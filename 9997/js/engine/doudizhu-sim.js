/**
 * doudizhu-sim.js — 斗地主的轻量模拟器（胜率引擎的地基）
 *
 * 它在整个项目里的位置
 * ------------------------------------------------------------------
 * 智能体做决定之前，本地要回答一个问题：「如果我出这一手，赢面有多大？」
 * 唯一诚实的答法是把它打出来看看 —— 几百次。所以需要一个能跑几千局的模拟器。
 *
 * 为什么不用规则包本身来模拟
 * ------------------------------------------------------------------
 * 规则包（rules/doudizhu/index.js）走的是事件溯源：每打一张牌都要
 * 克隆牌表、深拷贝规则状态、往日志里追加事件。严格、可回放，但一局要
 * 11ms（实测）。几百局就是几秒，页面卡死，胜率反而没法用。
 * 所以这里另写一条轻量通道：手牌用点数计数表，出牌直接改计数，
 * 不产生任何事件。一局的目标是 1ms 以内。
 *
 * 代价是「同一套规则写了两遍」。这个风险不靠小心，靠测试压住：
 *   - fast.js 的识别/比较已被 4 万组随机对照证明与 combo.js 等价；
 *   - tools/smoke-winrate.mjs 还会把【同一个局面】分别用轻量模拟和
 *     规则包本体跑一遍，要求赢家一致 —— 两条通道必须给出同一个结果。
 *
 * 信息隔离
 * ------------------------------------------------------------------
 * 模拟用的世界是从【投影后的 view】恢复出来的，不是从真实状态抄的：
 * 自己看不见的牌（对手手牌、以及自己那些翻到背面的牌）一律按剩余牌堆
 * 随机派发。也就是说，引擎自己也不知道真实答案，它算的是
 *   E[ 胜 | 我当前掌握的信息 ]
 * —— 这正是智能体该用的那个期望。
 *
 * 世界（world）的形状
 * ------------------------------------------------------------------
 *   order      座位顺序（活着的玩家，按顺时针）
 *   landlord   地主
 *   mult       当前倍数
 *   hands      pid → Uint8Array(18) 点数计数表
 *   totals     pid → 手牌张数
 *   lead       null 或 { playerId, code }（台面上最大的一手）
 *   acted      本巡已经回应过的玩家（有人压过就清零，与规则包一致）
 *   leaderId   出牌权在谁手上
 *
 * 一巡的推进规则严格照搬规则包：其余人都过 → 出牌权回到这一手最大的人，
 * acted 清空。
 */

import { FACE } from '../core/cards.js';
import { derivedIndex, makeRng, shuffle } from '../core/rng.js';
import { TRAINED } from './learned-weights.js';
import { COMBO } from '../rules/doudizhu/combo.js';
import {
  beatingMoves, beatsCode, classifyCounts, cloneCounts, codeOf, controlCount,
  decompose, isBombCode, minHands, ranksOf,
} from '../rules/doudizhu/fast.js';

/** 一次模拟最多推进一步数（纯粹防呆，正常一局 60~90 步） */
const MAX_PLIES = 260;

// ---------------------------------------------------------------------------
// 公开规则状态的白名单
// ---------------------------------------------------------------------------

/**
 * 从规则包的私有状态位里，只取【全桌公开】的那几项。
 *
 * 为什么要有白名单：ruleState 是规则包自己的地盘，将来往里塞什么都不奇怪。
 * 如果直接把整个对象交给模拟器，某天有人加了个「某人看过哪张牌」的字段，
 * 模拟器就会在不知不觉中拿到它，胜率立刻变成上帝视角的胜率 ——
 * 那种偏差不会报错，只会让智能体变得"神奇地准"。白名单让这件事不可能发生。
 */
export function publicRuleState(rs) {
  const out = {};
  if (!rs) return out;
  if (typeof rs.phase === 'string') out.phase = rs.phase;
  if (rs.landlord) out.landlord = rs.landlord;
  if (Array.isArray(rs.bottom)) out.bottom = [...rs.bottom];
  if (typeof rs.multiplier === 'number') out.multiplier = rs.multiplier;
  if (rs.lead && rs.lead.combo) {
    out.lead = { playerId: rs.lead.playerId, code: codeOf(rs.lead.combo) };
  }
  if (Array.isArray(rs.acted)) out.acted = [...rs.acted];
  if (rs.leaderId) out.leaderId = rs.leaderId;
  if (Array.isArray(rs.bidOrder)) out.bidOrder = [...rs.bidOrder];
  if (rs.bids && typeof rs.bids === 'object') out.bids = { ...rs.bids };
  return out;
}

// ---------------------------------------------------------------------------
// 确定性发牌（determinization）
// ---------------------------------------------------------------------------

/**
 * 数出「每个人已经出过几手牌」。
 *
 * 春天 / 反春天要精确知道两个边界值：「一张没出」和「只出过一手」。这两个数
 * 只能从事件流里来 —— 另立一个状态位就会在流局重发、读档、换玩法这些路径上
 * 跟真相脱节。好在 play 事件本来就是全桌公开的，数它不涉及任何私有信息。
 */
function playsFromEvents(events) {
  const out = {};
  if (!Array.isArray(events)) return out;
  for (const e of events) {
    if (e && e.type === 'play' && e.actorId) out[e.actorId] = (out[e.actorId] || 0) + 1;
  }
  return out;
}

/**
 * 建一个「发牌器」：它掌握公开信息与未知牌堆，能按需造出一个个
 * 与观察者信息一致的完整世界。
 *
 * @param view     投影后的视角（selfId 的眼睛）
 * @param ruleSet  规则包（用它生成整副牌，牌面构成是公开知识）
 */
export function createDealer({ view, ruleSet }) {
  const deck = ruleSet.createDeck();
  const idxOf = new Map();
  const baseRankOf = new Uint8Array(deck.length);
  const totalCnt = new Uint8Array(18);
  deck.forEach((c, i) => {
    idxOf.set(c.id, i);
    baseRankOf[i] = c.rank;
    totalCnt[c.rank]++;
  });

  /**
   * 已经被销毁的牌。这一批必须【先从整副牌里扣掉】，
   * 否则后面每一处减法都会把它当成「还没出现的牌」——补全世界时会把它
   * 重新发到某人手上，销毁等于没发生。
   *
   * 斗地主这边失败得很响（不像 21 点是静默偏掉）：牌数对不上，
   * `build()` 按设计返回 null，整张胜率表变成
   * 「牌数对不上（视角补全失败），本次不出胜率」。
   *
   * 点数取自 view.burned 而不是事件流：牌面已经不在任何牌区里了，
   * 只有这一步还知道少掉的是什么。
   */
  const burnedIds = new Set();
  const burnedCnt = new Uint8Array(18);
  for (const c of (view && view.burned) || []) {
    if (!c || typeof c.id !== 'string' || burnedIds.has(c.id)) continue;
    const i = idxOf.get(c.id);
    if (i === undefined) continue;
    burnedIds.add(c.id);
    burnedCnt[baseRankOf[i]]++;
  }
  let burnedTotal = 0;
  for (const n of burnedCnt) burnedTotal += n;

  // 开局时每个人已经出过几手牌。春天 / 反春天判定要用它，而它可以从
  // 【公开事件流】直接数出来 —— play 事件本来就是全桌可见的，不含任何私有信息。
  //
  // 注意这里【不】扣掉已被销毁的牌：一张先被打出去、随后被销毁的牌，
  // 「已经出过」这件事是真实发生过的历史，春天判定要看的就是它。
  // 对记牌而言两种口径也一致 —— 它无论算「已出」还是算「已毁」，
  // 结论都是「不在外面了」，不会重复扣减（poolRanks 走的是 knownCnt 那条路）。
  const playsAtStart = playsFromEvents(view && view.events);

  // 已经打到桌面上的牌（按点数计数）。这是「记牌」的全部原料：把整副牌里
  // 每个点数有几张，减去已经打出去的，减去我自己手上的，剩下的就是
  // 还在别人手上（或还没出现）的牌。策略只有拿到它，才可能知道
  // 「我这张 2 是不是外面已经没人能压了」—— 这正是高手和庸手的差别。
  const playedAtStart = new Uint8Array(18);
  /** 被打出去过的牌 id。用来避免「打过 + 又被销毁」的牌被减两遍 */
  const playedIds = new Set();
  if (view && Array.isArray(view.events)) {
    for (const e of view.events) {
      if (e && e.type === 'play' && e.payload && Array.isArray(e.payload.cardIds)) {
        for (const cid of e.payload.cardIds) {
          const i = idxOf.get(cid);
          if (i !== undefined) {
            playedIds.add(cid);
            playedAtStart[baseRankOf[i]]++;
          }
        }
      }
    }
  }

  /**
   * 被销毁、而且【从来没有被打出去过】的牌，也要并进这个「不在外面了」的计数。
   *
   * 漏掉这一条的后果是静默的：记牌器算的是 `整副牌 − 已出 − 我手上`，
   * 一张从手上直接被销毁的牌这三处都不占，于是被算成「还在外面」——
   * 策略会一直等着去压一张已经不存在的牌，或者把手上唯一的大牌浪费在
   * 「外面还有三张能压我」的假警报上。
   *
   * 只算没打过的那部分：打过又被销毁的牌在上面已经计过一次，
   * 两处都算就会把它减去两遍（外面凭空少一张）。
   */
  if (view && Array.isArray(view.burned)) {
    for (const c of view.burned) {
      if (!c || typeof c.id !== 'string' || playedIds.has(c.id)) continue;
      const i = idxOf.get(c.id);
      if (i === undefined) continue;
      playedAtStart[baseRankOf[i]]++;
    }
  }

  /** 我看得见的牌：座位上手牌里朝向为正面的 + 桌面上已经打出去的 */
  const seen = new Set();
  /** 其中属于「桌面」的那部分 —— 这些牌看得见，而且【不在任何人手上】 */
  const seenTable = new Set();
  const seats = [];
  let handTotal = 0;
  for (const seat of view.seats) {
    const hand = seat.hand || [];
    const ids = [];
    const known = [];
    const unseenIdx = [];
    for (const c of hand) {
      ids.push(c.id);
      if (c.facing === FACE && typeof c.rank === 'number') {
        known.push(c.rank);
        seen.add(c.id);
      } else {
        known.push(0);
        unseenIdx.push(ids.length - 1);
      }
    }
    handTotal += ids.length;
    seats.push({ id: seat.id, ids, known, unseenIdx });
  }
  for (const c of view.table || []) {
    if (c && typeof c.rank === 'number') {
      seenTable.add(c.id);
      seen.add(c.id);
    }
  }
  for (const c of view.exposed || []) {
    if (c && typeof c.rank === 'number') seen.add(c.id);
  }

  const knownCnt = new Uint8Array(18);
  for (const cid of seen) {
    const i = idxOf.get(cid);
    if (i !== undefined) knownCnt[baseRankOf[i]]++;
  }

  // 未知牌堆 = 整副牌 − 我看得见的牌。
  // 不在任何人手上、又看不见的牌才是「底牌」那一类（叫地主阶段的三张）——
  // 它必须由 pool 的长度反推，不能写成 54 − 手牌总数：
  // 桌面上已经打出去的牌同样是「不在任何人手上」，但它们【看得见】，
  // 已经不在 pool 里了。照 54 − 手牌总数 去算，就会凭空多派三张牌给地主，
  // 把牌堆掏空成负数（实测症状：某人手牌计数 1 张、实际一张也没有）。
  const poolRanks = [];
  for (let r = 3; r <= 17; r++) {
    for (let k = 0; k < totalCnt[r] - knownCnt[r] - burnedCnt[r]; k++) poolRanks.push(r);
  }
  const unseenSlots = seats.reduce((n, s) => n + s.unseenIdx.length, 0);
  const extraCount = poolRanks.length - unseenSlots;
  /**
   * 独立算一遍「应该有多少张看不见的非手牌」，用来交叉验证上面那个减法。
   *
   * burnedTotal 也要减：销毁掉的牌同样「不在任何人手上」，但它在
   * poolRanks 那边已经被扣掉了；这里不减，两条路就会差出销毁的张数，
   * 交叉验证会把一个正确的局面判成「牌数对不上」。
   */
  const expectedExtras = deck.length - handTotal - seenTable.size - burnedTotal;

  const base = {
    order: seats.map((s) => s.id),
    idsOf: Object.fromEntries(seats.map((s) => [s.id, s.ids])),
  };

  /**
   * 造一个世界。洗不出来就返回 null（调用方把这次采样作废，而不是硬塞）。
   */
  function build(landlord, seed, info = {}) {
    if (extraCount < 0 || extraCount !== expectedExtras) return null;
    const pool = shuffle([...poolRanks], makeRng(seed >>> 0));
    const rankOf = Uint8Array.from(baseRankOf);
    const hands = {};
    const totals = {};
    let p = 0;

    for (const seat of seats) {
      const cnt = new Uint8Array(18);
      for (let i = 0; i < seat.ids.length; i++) {
        const r = seat.known[i];
        if (r) {
          cnt[r]++;
          continue;
        }
        if (p >= pool.length) return null;
        const s = pool[p++];
        cnt[s]++;
        rankOf[idxOf.get(seat.ids[i])] = s;
      }
      hands[seat.id] = cnt;
      totals[seat.id] = seat.ids.length;
    }
    // 剩下的未知牌归地主（叫地主阶段：底牌进地主的手）
    if (extraCount > 0) {
      if (p + extraCount > pool.length) return null;
      const h = hands[landlord] || hands[base.order[0]];
      for (let i = 0; i < extraCount; i++) h[pool[p++]]++;
      totals[landlord] = (totals[landlord] || 0) + extraCount;
    }
    if (p !== pool.length) return null;

    return {
      order: base.order,
      landlord,
      mult: Math.max(1, Number(info.multiplier) || 1),
      hands,
      totals,
      lead: info.lead ? { playerId: info.lead.playerId, code: { ...info.lead.code } } : null,
      acted: Array.isArray(info.acted) ? [...info.acted] : [],
      leaderId: info.leaderId || landlord,
      rankOf,
      idxOf,
      /** 这个世界的抽样种子与计数器：破例「随机抽一张」靠它保持确定性 */
      seed: seed >>> 0,
      pick: 0,
      /** 这个世界里我的罚分（破例代价），期望得分的计算要用 */
      penalty: 0,
      /** 每人已出过几手：春天判定要从真实历史起算，不能只看本次模拟 */
      plays: { ...playsAtStart },
      /** 整副牌每个点数有几张（公开知识：牌面构成是规则的一部分） */
      totalOf: totalCnt,
      /** 已经打到桌面上的牌（公开信息）——「记牌」靠它 */
      played: playedAtStart.slice(),
      /**
       * 每个座位手上的牌 id 列表。
       *
       * 手牌本体在这个世界里只是一份【点数计数】（hands），够打牌用；
       * 但销毁要回答「这张具体的牌现在在谁手上」，那是点数计数答不了的。
       * 这里存的是投影给的 id，只读，且不随世界洗牌变化 —— 洗的是
       * 未知牌的【点数】，不是牌的位置。
       */
      idsOf: base.idsOf,
    };
  }

  return {
    build,
    seats,
    poolSize: poolRanks.length,
    unseenSlots,
    extraCount,
    expectedExtras,
    idxOf,
    seatIds: base.order,
    /** 纸牌守恒的自检结果：两边算出来的「看不见的非手牌」必须一致 */
    balanced: extraCount === expectedExtras && extraCount >= 0,
  };
}

/** 复制一个世界（每个候选、每次采样都要一份干净的世界） */
export function cloneWorld(w) {
  const hands = {};
  const totals = {};
  for (const pid of w.order) {
    hands[pid] = cloneCounts(w.hands[pid]);
    totals[pid] = w.totals[pid];
  }
  return {
    ...w,
    hands,
    totals,
    lead: w.lead ? { playerId: w.lead.playerId, code: { ...w.lead.code } } : null,
    acted: [...w.acted],
    // plays 是可变对象，浅拷贝会让两份世界共享计数 —— 克隆出来的世界必须独立
    plays: { ...(w.plays || {}) },
    // 记牌器同样是可变数组：克隆世界里出的牌不能污染原世界看到的历史
    totalOf: w.totalOf ? w.totalOf.slice() : null,
    played: w.played ? w.played.slice() : null,
  };
}

// ---------------------------------------------------------------------------
// 打牌策略（模拟里所有角色都用它，包括对手）
// ---------------------------------------------------------------------------

function sameSide(w, a, b) {
  if (a === b) return true;
  return a !== w.landlord && b !== w.landlord;
}

function opponentsOf(w, pid) {
  return w.order.filter((id) => !sameSide(w, pid, id));
}

function minOpponentCards(w, pid) {
  const opps = opponentsOf(w, pid);
  return opps.length ? Math.min(...opps.map((x) => w.totals[x])) : 99;
}

/** 手上最小的单张点数（没有牌时返回 0） */
function lowestSingle(hand) {
  for (let r = 3; r <= 17; r++) if (hand[r]) return r;
  return 0;
}

/**
 * 外面还剩几张比 rank 大的牌。
 *
 * 这就是「记牌」的全部内容：整副牌里每个点数有几张是公开知识（牌面构成属于
 * 规则），减去已经打到桌面上的、再减去我自己手上的，剩下的就在别人手里。
 * 结果为 0 表示「我这张外面已经没人压得过」—— 一张必胜的单张。
 *
 * 少了这个数，策略就只能按牌面点数胖瘦判断轻重，会把手上唯一一张能收回
 * 出牌权的牌当普通小牌打出去。
 *
 * 导出它是为了能被测试直接验证语义 —— 这个函数算错了不会报错，只会让策略
 * 悄悄变笨，所以必须有断言钉住它。
 */
export function unseenAbove(w, pid, rank) {
  // 拿不到牌面构成就别声称「外面已经没了」—— 那种误判会让策略以为张张是
  // 绝对大牌，把手上的资源全浪费掉。返回 Infinity 等于「不知道」，安全。
  if (!w.totalOf) return Infinity;
  const mine = w.hands[pid];
  let n = 0;
  for (let r = rank + 1; r <= 17; r++) {
    n += w.totalOf[r] - (w.played ? w.played[r] : 0) - (mine ? mine[r] : 0);
  }
  return Math.max(0, n);
}

/** 队友（同阵营的另一家）。地主没有队友，返回 null */
function teammateOf(w, pid) {
  if (!w.landlord || pid === w.landlord) return null;
  return w.order.find((id) => id !== pid && id !== w.landlord) || null;
}

const mk = (code, ranks) => ({ t: code.t, r: code.r, n: code.n, ranks });

/** 从分解结果里挑一组最便宜的当翅膀 */
function pickWingGroup(groups, body, hand, size) {
  const cand = groups.filter((g) => g !== body && g.ranks.length === size && g.t !== COMBO.BOMB && g.t !== COMBO.ROCKET);
  if (!cand.length) return null;
  // 翅膀越不心疼越好：先低点数、再避开 2 和王
  cand.sort((a, b) => {
    const ca = (a.r >= 16 ? 100 : a.r >= 15 ? 50 : 0) + a.r;
    const cb = (b.r >= 16 ? 100 : b.r >= 15 ? 50 : 0) + b.r;
    return ca - cb;
  });
  return cand[0].ranks;
}

/** 找一手便宜的、≥2 张的牌型（对手只剩一张时用） */
function cheapestMulti(hand) {
  const groups = decompose(hand);
  const cand = groups.filter((g) => g.ranks.length >= 2 && !isBombCode(g));
  if (!cand.length) return null;
  cand.sort((a, b) => a.r - b.r || b.n - a.n);
  return mk(cand[0], cand[0].ranks);
}

function highestRank(hand) {
  for (let r = 17; r >= 3; r--) if (hand[r]) return r;
  return 0;
}

// ---------------------------------------------------------------------------
// 策略层：模拟里那三个座位到底怎么打
// ---------------------------------------------------------------------------
//
// 为什么要有「档位」
// ------------------------------------------------------------------
// 胜率表里的数字是相对的 —— 它答的是「在这套对手面前，我这一手的胜面」。
// 对手越弱，数字越好看，但那不是真实胜面。所以模拟器要能换一套更强的对手，
// 并且【量出它确实更强】—— tools/bench-policy.mjs 用同一批牌做交叉对拍。
//
// greedy（原来那套）：跟牌挑最便宜的、领出挑最小的组。快、稳，但有两个盲点：
//   1. 不看「出完这手我还剩几手」—— 斗地主里最实在的进度指标；
//   2. 不知道脱手之后手上还有没有能收回出牌权的牌（2 / 王 / 炸弹）。
// smart 就是补这两点：候选逐个算「出完之后还要几手走完」，再算脱手代价。
//
// learned：跟 smart 走【同一段代码】，只是分数里的权重不是手调的，而是
// tools/selfplay-learn.mjs 让 AI 自己跟自己打、一代代推出来的（见
// js/engine/policy-learn.js）。两者的关系是「同一副骨架、两套关节角度」——
// 不复制一份打分逻辑出来，是因为复制出来的那份迟早会跟原版漂开，
// 而漂开的表现是「learned 悄悄变笨」，不会报错。
//
// 这也是为什么打分被拆成了「特征 + 点积」：特征是可复用的那部分（局面里
// 客观存在的事实），权重才是被学的那部分。拆开之后，「换一组脑子」就等于
// 「换一个向量」，训练器才有地方下手。

export const POLICY_LEVELS = ['greedy', 'smart', 'learned'];

/** 默认档位。保持 greedy —— 换默认档会让所有历史数字漂移，得单独决定。 */
const DEFAULT_POLICY = 'greedy';

/**
 * 取某个座位这一局要用哪一档、哪一组权重。
 *
 * 原来这里只返回一个档位字符串。加 learned 档之后不够用了 —— 学习的过程要拿
 * 【几十组不同的权重】挨个上来打，不可能每一组都去改模块级的常量（那会让
 * 「同一进程里并行评估多组权重」变成不可能）。所以座位上可以挂一个完整的
 * 策略对象：{ level, weights }。
 *
 * 向后兼容：字符串（'greedy' / 'smart'）、以及整个 w.policy 就是一个字符串，
 * 这两种老写法都还认，行为不变。
 */
function policySpec(w, pid) {
  const p = w && w.policy;
  if (!p) return specOf(DEFAULT_POLICY);
  if (typeof p === 'string') return specOf(p);
  const raw = (p.bySeat && p.bySeat[pid]) || p.default || DEFAULT_POLICY;
  return specOf(raw);
}

function specOf(raw) {
  if (typeof raw === 'string') return { level: raw, weights: weightsForLevel(raw) };
  if (raw && typeof raw === 'object') {
    const level = raw.level || DEFAULT_POLICY;
    return { level, weights: raw.weights || weightsForLevel(level) };
  }
  return { level: DEFAULT_POLICY, weights: weightsForLevel(DEFAULT_POLICY) };
}

function weightsForLevel(level) {
  return level === 'learned' ? LEARNED_WEIGHTS : POLICY_WEIGHTS;
}

/** 出掉 m 之后剩下的手牌计数 */
function restAfter(hand, m) {
  const rest = cloneCounts(hand);
  for (const r of m.ranks) rest[r]--;
  return rest;
}

/**
 * 脱手代价：这手牌用掉了多少「控场资源」。
 * 数字是相对的 —— 主项「手数」100/手，所以拆一个炸弹约等于多两手才能走完，
 * 出掉一张王约等于 0.3 手。量级对得上就行，不需要精确。
 */
function moveRankCost(m) {
  let c = m.r >= 16 ? 30 : m.r >= 15 ? 20 : 0;
  if (isBombCode(m)) c += 120;
  return c;
}

// ---------------------------------------------------------------------------
// greedy 档
// ---------------------------------------------------------------------------

/** 自由出牌（greedy） */
function greedyLead(w, pid, hand, total) {
  // 一手走完：直接走，这就是赢
  const whole = classifyCounts(hand);
  if (whole.ok) return mk(whole, ranksOf(hand));

  const oppMin = minOpponentCards(w, pid);

  // 对手只剩一张：出一手两张以上的牌，他接不住
  if (oppMin <= 1) {
    const multi = cheapestMulti(hand);
    if (multi) return multi;
    const hi = highestRank(hand);
    if (hi) return mk({ t: COMBO.SINGLE, r: hi, n: 1 }, [hi]);
  }

  const groups = decompose(hand);
  if (!groups.length) return null; // 手上真没牌了（调用方会跳过这一局）
  const safe = groups.filter((g) => !isBombCode(g) && g.r < 15);
  const pool = safe.length ? safe : groups.filter((g) => !isBombCode(g));
  const usable = pool.length ? pool : groups;
  usable.sort((a, b) => a.r - b.r || b.n - a.n);
  const body = usable[0];

  // 三张单独出会浪费一次出牌机会：能带就带一张走
  if (body.t === COMBO.TRIPLE) {
    const wing = pickWingGroup(groups, body, hand, 1);
    if (wing) return mk({ t: COMBO.TRIPLE_ONE, r: body.r, n: 4 }, [...body.ranks, ...wing]);
    const wpair = pickWingGroup(groups, body, hand, 2);
    if (wpair) return mk({ t: COMBO.TRIPLE_PAIR, r: body.r, n: 5 }, [...body.ranks, ...wpair]);
  }
  return mk(body, body.ranks);
}

/** 跟牌（greedy） */
function greedyBeat(w, pid, hand, total, lead) {
  const target = lead.code;
  const moves = beatingMoves(hand, target);
  if (!moves.length) return null; // 过牌

  // 能一手走完就走（哪怕要拆炸弹）
  const finish = moves.find((m) => m.n === total);
  if (finish) return finish;

  // 队友出的牌：让给队友，除非上面那条（自己直接走完）
  if (lead.playerId !== pid && sameSide(w, pid, lead.playerId)) return null;

  const oppMin = minOpponentCards(w, pid);
  const nonBomb = moves.filter((m) => !isBombCode(m));

  if (nonBomb.length) {
    const cheap = nonBomb[0];
    // 拿 2 / 王 去压一手小牌是亏的：除非对手马上就走完了
    if (cheap.r >= 15 && target.r <= 11 && oppMin > 2) {
      const alt = nonBomb.find((m) => m.r <= 14);
      return alt || null;
    }
    return cheap;
  }

  // 手上只有炸弹：对手快走完、或者对方这一手是长牌型，就炸
  if (oppMin <= 2 || target.n >= 4) return moves[0];
  return null;
}

// ---------------------------------------------------------------------------
// smart 档
// ---------------------------------------------------------------------------

/**
 * smart 档的打分权重。
 *
 * 这些数字不是拍出来的 —— tools/tune-policy.mjs 会在【训练种子】上做网格搜索，
 * 挑出 B-C 最大的那一组，再拿【另一组从没见过的种子】复核，防止过拟合到
 * 某一批牌上。想调参请改这里，然后跑那个脚本，不要手改公式里的字面量。
 *
 * 最反直觉的一条恰恰最重要
 * ------------------------------------------------------------------
 * 网格收敛到：hands 100 → 50，noCtrl 70 → 400，cheapBig 180 → 0
 * 也就是「手数」的权重砍半，「脱手后手里还有没有能收回出牌权的牌」的权重涨了
 * 近六倍。验证集上 B-C 从 +10.7pt 升到 +25.8pt。
 *
 * 读出来的道理：斗地主的核心资源是**出牌权**，不是出牌速度。
 * 手上没 2、没王、没炸弹，哪怕只剩两手也走不掉 —— 出一手就被压，然后永远拿不
 * 回出牌权。所以「别把最后一张控场牌交出去」比「少剩一手」值钱得多。
 * cheapBig 归零也是同一件事：既然 noCtrl 已经在管大牌，再单独罚一次「大牌压
 * 小牌」只会让它畏手畏脚。
 *
 * 关于下面两段
 * ------------------------------------------------------------------
 * 上段（hands ~ addLowSingle）是手调出来的，网格搜索定下、验证集确认过。
 * 下段（gradeTop ~ passNoCtrl）是给自博弈学习开的口子，【默认全是 0】——
 * 也就是说它们对 smart 的行为没有任何影响。它们不是"顺手加的功能"，而是把
 * 原公式里藏着的东西变成可学的量：
 *   · 原来「对手只剩一两张」用的是硬阈值 oppMin<=2 / >3，阶梯式跳变；
 *     这里给一条连续的坡（oppGrad*），让优化器自己决定拐点在哪。
 *   · 原来「记牌」只有 ===0 这个二元判断（wasteTop）；这里加了分级版本。
 *   · 原来地主和农民共用一套 hands 权重；这里拆成两套，角色节奏本就不同。
 * 默认 0 的意义是：学习没带来改进时，learned 档就精确地等于 smart 档，
 * 不会因为"多加了几个旋钮"而悄悄变味。
 */
export const POLICY_WEIGHTS = {
  hands: 50,         // 每多一手要出一次牌
  noCtrl: 400,       // 脱手之后手上没有任何能收回出牌权的牌
  oppLeadMulti: 400, // 对手只剩一两张时，领出一手多张（他接不住）
  oppLeadSingle: -150, // 对手只剩一两张时还领单张（他随手一压就走了）
  oppBeat: 260,      // 跟牌压住只剩一两张的对手
  cheapBig: 0,       // 拿 2 / 王 去压一手小牌
  rankCost: 1,       // 脱手代价的倍率（见 moveRankCost）
  finish: 1e6,       // 出完就是赢
  wasteTop: 0,       // 把「外面已经压不过」的单张当普通牌打出去（记牌）
  feedMate: 0,       // 队友只剩一张时，送他一张最小的单张（农民配合）
  addLowSingle: 0,   // 领出候选里补一个「拆出最小的一张单牌」（开关：0 关 / 1 开）

  // ---- 自博弈学习开的口子（默认 0 = smart 行为不变）----
  gradeTop: 0,           // 分级记牌：外面还剩几张压得过它
  oppGradLeadMulti: 0,   // 对手压力的连续版本（领出多张）
  oppGradLeadSingle: 0,  // 对手压力的连续版本（领出单张）
  oppGradBeat: 0,        // 对手压力的连续版本（跟牌）
  llHands: 0,            // 地主专用的「手数」
  ffHands: 0,            // 农民专用的「手数」
  mateNear: 0,           // 队友只剩一两张时送他最小的单张（放宽版送牌）

  // ---- 过牌门槛：原先是 smartBeat 里的字面量 100 / 70 ----
  // 「压上去值不值」没有不变的答案 —— 抽成参数是为了让学习能去找它。
  passHands: 100,
  passNoCtrl: 70,

  // ---- 平局偏好：把原本写在比较里的「同分走便宜的」搬进打分表 ----
  //
  // 这不是新策略，是【同一件事换了个写法】。原来候选之间分不出高下时，
  // 靠一句 `s === bestScore && (m.r < best.r ...)` 来裁决 —— 一个精确相等判断。
  // 现在改成给每个候选加 `-cheapTie × (点数 + 0.01×张数)`，让"更便宜"直接进分数。
  //
  // 为什么非改不可（实测）
  // ------------------------------------------------------------------
  // 相等判断在权重空间里是一道【断崖】：权重只要离开 0（或任何一个整数值）
  // 一丁点，相等就不再成立，裁决权立刻从那条规则转到分数上。实测把权重扰动
  // 1e-9 σ（数值上等于没动），17% 的对局胜负就变了 —— 连续函数做不到这件事。
  // 后果是任何优化器都在这片"台阶地"上踩着噪声走，见 tools/landscape-audit.mjs。
  // 换成加法项之后，"更便宜"成了一个连续的坡度，扰动它只会让偏好微微变化。
  //
  // 取值 1.0 的依据（这个数不能随便调，它是算出来的）：
  //   平局项的取值跨度 = 最高点数 − 最低点数 = 17 − 3 = 14（张数项 0.01 太小，不算）
  //   而打分表里最小的非零间隔来自脱手代价：20（moveRankCost 的 15 → 20）
  //   只要 14 × 1.0 < 20，平局项就【永远盖不过任何真实差别】，只在其它项全都相等时说话。
  // 实测教训：先取 2 的时候它盖过了代价项，300 局里有 12 局走出了不同的棋 ——
  // 那就不是"换个写法"，而是偷偷改了策略。
  cheapTie: 1.0,
};

/**
 * 自博弈学出来的权重。没训练过时就是 POLICY_WEIGHTS 的副本 ——
 * 于是「learned 档」在训练之前与 smart 逐位同源（tools/smoke-learn.mjs 钉住）。
 */
export const LEARNED_WEIGHTS = TRAINED
  ? { ...POLICY_WEIGHTS, ...TRAINED.weights }
  : { ...POLICY_WEIGHTS };

/** 训练产物的元信息（没训练过时只有 trained:false） */
export const LEARNED_META = TRAINED
  ? { ...TRAINED.meta, trained: true }
  : { trained: false };

/**
 * 特征表。顺序就是特征向量的下标 ——
 * 【改顺序会让已经训练出来的权重全体错位】，而且错位之后不报错、只是变笨，
 * 所以顺序由 tools/smoke-learn.mjs 的断言钉死。
 *
 * 「权重表里除了特征之外还有几个参数」这件事也要说清楚：
 *   · finish       —— 不是特征，是「走光」的短路返回值（必须压倒一切）；
 *   · addLowSingle —— 不是打分项，是候选集的开关；
 *   · passHands / passNoCtrl —— 不是特征，是过牌门槛的两个系数。
 * 它们同样在 POLICY_WEIGHTS 里，但没有特征向量，所以不出现在这个数组里。
 */
export const POLICY_FEATURE_KEYS = [
  'hands', 'noCtrl', 'rankCost',
  'oppLeadMulti', 'oppLeadSingle', 'oppBeat', 'cheapBig',
  'wasteTop', 'feedMate',
  'gradeTop', 'oppGradLeadMulti', 'oppGradLeadSingle', 'oppGradBeat',
  'llHands', 'ffHands', 'mateNear',
  'cheapTie',
];

/** 学习真正会去动的那些量：全部特征权重 + 过牌门槛 */
export const POLICY_PARAM_KEYS = [...POLICY_FEATURE_KEYS, 'passHands', 'passNoCtrl'];

const FI = Object.fromEntries(POLICY_FEATURE_KEYS.map((k, i) => [k, i]));

/** 复用一块定长缓冲：一局要打几千次分，每次新建数组会明显拖慢模拟 */
const _feat = new Float64Array(POLICY_FEATURE_KEYS.length);

const clamp01 = (x) => (x > 1 ? 1 : x > 0 ? x : 0);

/**
 * 把「局面 + 这一手」翻译成一组特征。
 *
 * 特征是【客观事实】，权重才是【偏好】。分开之后，「这个策略有多强」就变成
 * 「这组偏好有多好」，而「偏好有多好」是可以被搜索的 —— 这是整个自博弈学习的
 * 前提：如果打分写成一堆 if，那就只能靠人改 if，没有东西可学。
 *
 * 每条特征的含义写在 POLICY_WEIGHTS 旁边。这里只强调一处：
 * 所有特征都限制在【同量级】范围内（绝大多数是 0/±1，或 0~1 的坡），
 * 不出现差着几个数量级的量纲。否则优化器得自己学会一组跨度极大的步长，
 * 那是白送给它的困难。
 */
export function fillFeatures(out, w, pid, hand, m, { leading, target }) {
  out.fill(0);
  const rest = restAfter(hand, m);
  const hands = minHands(rest);
  const ctrl = controlCount(rest);
  const oppMin = minOpponentCards(w, pid);
  const isLL = pid === w.landlord;

  out[FI.hands] = -hands;
  out[FI.noCtrl] = (ctrl === 0 && hands > 1) ? -1 : 0;
  out[FI.rankCost] = -moveRankCost(m);

  // 「更便宜」进分数：点数为主、张数为辅（0.01 的系数保证同点数才比张数）
  out[FI.cheapTie] = -(m.r + m.n * 0.01);

  if (oppMin <= 2) {
    if (leading) out[m.n >= 2 ? FI.oppLeadMulti : FI.oppLeadSingle] = 1;
    else out[FI.oppBeat] = 1;
  }

  if (!leading && target && target.r <= 11 && m.r >= 15 && oppMin > 3) out[FI.cheapBig] = -1;

  if (m.n === 1 && hands > 0) {
    const un = unseenAbove(w, pid, m.r);
    // 拿不到牌面构成时 unseenAbove 返回 Infinity（「不知道」）。
    // 这里必须当成「外面还很多」= 最悲观的一档，绝不能当成 0 ——
    // 当成 0 等于谎报「这张必胜」，策略会把资源全浪费在虚无的大牌上。
    if (un === 0) out[FI.wasteTop] = -1;
    out[FI.gradeTop] = -clamp01(un / 6);
  }

  const pressure = clamp01((5 - oppMin) / 4);
  if (leading) out[m.n >= 2 ? FI.oppGradLeadMulti : FI.oppGradLeadSingle] = pressure;
  else out[FI.oppGradBeat] = pressure;

  if (isLL) out[FI.llHands] = -hands;
  else out[FI.ffHands] = -hands;

  if (leading) {
    const mate = teammateOf(w, pid);
    if (mate && m.n === 1 && m.r === lowestSingle(hand)) {
      if (w.totals[mate] === 1 && w.totals[pid] > 1) out[FI.feedMate] = 1;
      if (w.totals[mate] <= 2 && w.totals[pid] > w.totals[mate]) out[FI.mateNear] = 1;
    }
  }
  return out;
}

/** 给外部（测试、训练器）用的便利版本：返回一份新数组，可以随便留着 */
export function featureVector(w, pid, hand, m, ctx) {
  return Array.from(fillFeatures(new Float64Array(POLICY_FEATURE_KEYS.length), w, pid, hand, m, ctx));
}

/** 特征向量与权重的点积 */
export function dotFeatures(W, f) {
  let s = 0;
  for (let i = 0; i < f.length; i++) {
    const v = W[POLICY_FEATURE_KEYS[i]];
    s += f[i] * (typeof v === 'number' ? v : 0);
  }
  return s;
}

/**
 * 「这一手值多少分」的对外入口 —— 与 scoreMove 完全同义，只是权重可以传进来。
 *
 * 为什么要单独暴露它：测试要拿它跟重构之前那份公式逐局面比对，而比对必须比
 * 【有效打分】而不是【特征点积】—— 两者差着「走光就是赢」那条短路。
 * 少了这条短路，一手能打完的牌会被算成"手数项为 0"，跟一堆普通候选混在一起比，
 * 结果是丢掉必胜的一手。这种错法在测试里的表现是"最大偏差恰好是 1e6"。
 */
export function scoreAction(W, w, pid, hand, m, ctx) {
  const f = fillFeatures(_feat, w, pid, hand, m, ctx);
  // 走光就是赢，压倒一切
  if (f[FI.hands] === 0) return W.finish;
  return dotFeatures(W, f);
}

/**
 * 给一手指打分。越高的分 = 越该出这一手。
 *
 * 主项是「出完这手，我还要几手才能走完」—— 这是斗地主里最实在的进度指标，
 * 比「这手是不是最便宜」重要得多：手上 334455667788 出 334455 还剩 2 手，
 * 一口气出 6 张连对只剩 1 手，后者才对。
 *
 * 它以前是「一串 if 直接加减」，现在退化成「取特征 → 点积」。值完全一样
 * （有逐位相等的自检），变的只是它现在有了一组可以让人以外的东西去调的旋钮。
 */
function scoreMove(w, pid, hand, m, ctx, W) {
  return scoreAction(W, w, pid, hand, m, ctx);
}

/**
 * 领出候选：贪心分解给出的每一组，都是一手可出的牌。
 *
 * @param addLowSingle 额外补一个「从最小的一组里拆出一张单牌」的候选。
 *
 * 为什么要留这个开关：贪心分解只给【整组】出法，于是有一整类牌永远打不出去。
 * 最典型的一幕是「我手上只剩对子，队友却只剩一张」—— 想送一张给他，
 * 候选集里连单张都没有，策略再聪明也选不出来。这不是打分问题，是候选集
 * 本身就缺项。开关默认关，由 tools/tune-policy.mjs 用数据决定要不要开。
 */
function leadCandidates(hand, { addLowSingle = false } = {}) {
  const groups = decompose(hand);
  const out = [];
  for (const g of groups) {
    // 三张能带牌就带（少出一手）
    if (g.t === COMBO.TRIPLE) {
      const wing = pickWingGroup(groups, g, hand, 1);
      if (wing) out.push(mk({ t: COMBO.TRIPLE_ONE, r: g.r, n: 4 }, [...g.ranks, ...wing]));
      const wpair = pickWingGroup(groups, g, hand, 2);
      if (wpair) out.push(mk({ t: COMBO.TRIPLE_PAIR, r: g.r, n: 5 }, [...g.ranks, ...wpair]));
    }
    out.push(mk(g, g.ranks));
  }
  if (addLowSingle) {
    const low = lowestSingle(hand);
    if (low && !out.some((m) => m.n === 1 && m.r === low)) {
      out.push(mk({ t: COMBO.SINGLE, r: low, n: 1 }, [low]));
    }
  }
  return out;
}

/** 自由出牌（smart / learned 共用，区别只在传进来的 W） */
function smartLead(w, pid, hand, total, W) {
  const whole = classifyCounts(hand);
  if (whole.ok) return mk(whole, ranksOf(hand)); // 一手走完

  const opts = { addLowSingle: W.addLowSingle > 0 };
  const oppMin = minOpponentCards(w, pid);

  // 对手只剩一张：单张他随手一压就走了，必须出多张（他接不住）
  if (oppMin <= 1) {
    const cand = leadCandidates(hand, opts).filter((m) => m.n >= 2 && !isBombCode(m));
    if (cand.length) {
      cand.sort((a, b) => minHands(restAfter(hand, a)) - minHands(restAfter(hand, b)) || a.r - b.r);
      return cand[0];
    }
    const hi = highestRank(hand);
    if (hi) return mk({ t: COMBO.SINGLE, r: hi, n: 1 }, [hi]);
    return null;
  }

  const cand = leadCandidates(hand, opts);
  if (!cand.length) return null;
  let best = cand[0];
  let bestScore = -Infinity;
  for (const m of cand) {
    const s = scoreMove(w, pid, hand, m, { leading: true, target: null }, W);
    // 同分走便宜的（点数低、张数少）
    if (s > bestScore || (s === bestScore && (m.r < best.r || (m.r === best.r && m.n < best.n)))) {
      best = m; bestScore = s;
    }
  }
  return best;
}

/** 跟牌（smart / learned 共用） */
function smartBeat(w, pid, hand, total, lead, W) {
  const target = lead.code;
  const moves = beatingMoves(hand, target);
  if (!moves.length) return null; // 过牌

  // 一手走完就走，不管别的
  const finish = moves.find((m) => m.n === total);
  if (finish) return finish;

  // 队友出的牌：让给他。他手里的牌跟我一样是对付地主的，我压他等于帮他倒忙。
  // 例外只有上面那条「我自己能直接走完」。
  if (lead.playerId !== pid && sameSide(w, pid, lead.playerId)) return null;

  const oppMin = minOpponentCards(w, pid);

  // 手上只有炸弹：压下去等于把最大的底牌交出去，得有理由
  if (moves.every((m) => isBombCode(m))) {
    if (oppMin <= 2 || target.n >= 4) return moves[0];
    return null;
  }

  let best = null;
  let bestScore = -Infinity;
  for (const m of moves) {
    const s = scoreMove(w, pid, hand, m, { leading: false, target }, W);
    if (s > bestScore) { best = m; bestScore = s; }
  }

  // 过牌也是一种选择：如果压上去的代价大于收益，就别压。
  // 收益参考：压完之后我还剩几手；不压就是保持现状。
  //
  // 100 / 70 这两个数是把原来的字面量原样搬到权重表里来的（值没变，行为没变），
  // 搬家的唯一目的是让它们变成可学的 —— 「多愿意压一手」本来就是斗地主里
  // 最吃不准的一个尺度。
  const passScore = -minHands(hand) * W.passHands
    - (controlCount(hand) === 0 && minHands(hand) > 1 ? W.passNoCtrl : 0);
  if (bestScore <= passScore && oppMin > 1) return null;

  return best;
}

// ---------------------------------------------------------------------------

export function chooseMove(w, pid) {
  const hand = w.hands[pid];
  const total = w.totals[pid];
  if (!total) return null;
  const { level, weights } = policySpec(w, pid);
  const W = weights || POLICY_WEIGHTS;
  // greedy 那条路不看权重；smart 与 learned 走同一段代码，只有 W 不同
  if (level === 'greedy') {
    return w.lead ? greedyBeat(w, pid, hand, total, w.lead)
      : greedyLead(w, pid, hand, total);
  }
  return w.lead
    ? smartBeat(w, pid, hand, total, w.lead, W)
    : smartLead(w, pid, hand, total, W);
}

// ---------------------------------------------------------------------------
// 推进
// ---------------------------------------------------------------------------

function nextAfter(order, from, pending) {
  const i = order.indexOf(from);
  const set = new Set(pending);
  for (let k = 1; k <= order.length; k++) {
    const id = order[(i + k) % order.length];
    if (id !== from && set.has(id)) return id;
  }
  return pending[0];
}

function applyMove(w, pid, move) {
  if (!move) {
    // 过牌：只有在「台面上有牌可跟」时才有意义
    if (!w.lead) return false;
    if (!w.acted.includes(pid)) w.acted.push(pid);
    return true;
  }
  const hand = w.hands[pid];
  for (const r of move.ranks) {
    if (hand[r] <= 0) return false;
    hand[r]--;
  }
  w.totals[pid] -= move.ranks.length;
  w.lead = { playerId: pid, code: { t: move.t, r: move.r, n: move.n } };
  w.acted = [];
  // 出过几手 —— 春天 / 反春天判定要用（「一张没出」「只出过一手」）
  w.plays[pid] = (w.plays[pid] || 0) + 1;
  // 打出去的牌进入「公开已出」，记牌器要跟着走，否则模拟到中局之后
  // 策略对「外面还剩什么」的认知会停在这一局的开头
  if (w.played) for (const r of move.ranks) w.played[r]++;
  if (move.t === COMBO.BOMB || move.t === COMBO.ROCKET) w.mult *= 2;
  return true;
}

function settle(w, outPid) {
  const landlordWon = outPid === w.landlord;
  // 地主一个人对上一整队农民，进出必须按农民人数放大 —— 固定写 2 只在三人局
  // 凑巧零和，四人局会凭空虚增一分。桌面分数不守恒，「胜率」就没有意义。
  const farmers = Math.max(1, w.order.filter((id) => id !== w.landlord).length);

  // 春天 / 反春天：倍数再翻一倍。它只影响期望分（输赢不变），但期望分正是
  // 用来判断「这手划不划算」的，漏掉它等于把春天这一档收益当成不存在。
  const plays = w.plays || {};
  let spring = null;
  if (w.landlord) {
    const allIdle = w.order.every((id) => id === w.landlord || !plays[id]);
    if (landlordWon && allIdle) spring = 'spring';
    else if (!landlordWon && (plays[w.landlord] || 0) <= 1) spring = 'anti';
  }
  const mult = spring ? w.mult * 2 : w.mult;

  const deltas = {};
  for (const pid of w.order) {
    if (pid === w.landlord) deltas[pid] = (landlordWon ? 1 : -1) * farmers * mult;
    else deltas[pid] = landlordWon ? -mult : mult;
  }
  return { landlordWon, mult, base: w.mult, spring, outPid, deltas, plies: 0 };
}

/**
 * 把世界打到结束。
 *
 * @param onDecision 可选的旁听钩子，每做一次决定就被叫一次：
 *   `onDecision(w, pid, move, { leading })`，此时 w 还是「做决定之前」的样子。
 *   策略审计靠它 —— 想知道 AI 在什么局面下选了什么，就得有个不改变对局的
 *   观察位。不传它时开销可以忽略（只有一次真值判断）。
 * @returns 结算对象；若超出步数上限（异常局面）返回 null
 */
export function playOut(w, { maxPlies = MAX_PLIES, onDecision = null } = {}) {
  if (!w.leaderId) w.leaderId = w.order[0];

  // 进循环之前先看一眼：有人已经把牌打光了吗？
  //
  // 这一步不能省。playOut 的常规入口是「一副刚发好的世界」，那时谁都没出牌；
  // 但它还有一个入口 —— 候选动作已经落在世界上了（见 createDoudizhuJudge）。
  // 如果候选本身就是致胜的那一手（一手出完），交给 playOut 时我已经 0 张牌了。
  // 少了这一步会出两种错：
  //   1. 别人轮空之后出牌权绕回我这里，我一张都出不了 → 整局返回 null，
  //      这个候选的采样全部作废（胜率表里那一行是空白）；
  //   2. 更坏的一种：牌局继续打下去，某个对手先走完 → 结算成「我输了」。
  //      赢棋被算成输棋，而表面上看不出任何异常。
  // 优先认「刚出的这一手」的玩家，他才是真正打光手牌的那个人。
  const outPid = (w.lead && w.totals[w.lead.playerId] === 0)
    ? w.lead.playerId
    : w.order.find((id) => w.totals[id] === 0);
  if (outPid) return { ...settle(w, outPid), plies: 0 };

  for (let plies = 0; plies <= maxPlies; plies++) {
    if (!w.lead) {
      // 出牌权在 leaderId 手上；斗地主里他必须出牌，不能过
      const pid = w.leaderId;
      const move = chooseMove(w, pid);
      if (!move) return null;
      if (onDecision) onDecision(w, pid, move, { leading: true });
      applyMove(w, pid, move);
      if (w.totals[pid] === 0) return { ...settle(w, pid), plies };
      continue;
    }

    const pending = w.order.filter((id) => id !== w.lead.playerId && !w.acted.includes(id));
    if (!pending.length) {
      // 其余人都过了：出牌权回到这一手最大的人，开新的一巡
      w.leaderId = w.lead.playerId;
      w.lead = null;
      w.acted = [];
      continue;
    }

    const pid = nextAfter(w.order, w.lead.playerId, pending);
    const move = chooseMove(w, pid);
    if (onDecision) onDecision(w, pid, move, { leading: false });
    if (!applyMove(w, pid, move)) return null;
    if (w.totals[pid] === 0) return { ...settle(w, pid), plies };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 把「候选动作」落进世界
// ---------------------------------------------------------------------------

/**
 * 在世界里执行一个候选动作。
 *
 * 动作里的牌用 id 指定，而 id 在模拟世界里对应哪张牌是抽样结果 ——
 * 所以这里要检查「这个世界里这一手是否也成立」。不成立就返回 ok:false，
 * 这一次采样作废（不会被算成输），而不是硬塞进去污染统计。
 *
 * @returns {{ok:boolean, why?:string, penalty?:number}}
 */
export function applyCandidate(w, pid, action) {
  if (!action || !action.type) return { ok: false, why: '空动作' };
  const hand = w.hands[pid];
  const target = w.lead && w.lead.playerId !== pid ? w.lead.code : null;

  switch (action.type) {
    case 'bid':
      // 叫分对出牌阶段没有任何影响：它会改变的是「谁是地主」，
      // 而这件事在造世界的时候就按候选定好了（见 createDoudizhuJudge）。
      // 本实现的分数也不随叫分放大，所以这里什么都不用改。
      return { ok: true };

    case 'play': {
      const ids = action.cards || [];
      if (!ids.length) return { ok: false, why: '没指定牌' };
      const ranks = [];
      const need = new Uint8Array(18);
      for (const cid of ids) {
        const i = w.idxOf.get(cid);
        if (i === undefined) return { ok: false, why: '牌不在牌堆里' };
        const r = w.rankOf[i];
        if (!r) return { ok: false, why: '这个世界里这张牌还没有归属' };
        need[r]++;
        if (need[r] > hand[r]) return { ok: false, why: '这张牌不在你手上' };
        ranks.push(r);
      }
      const shaped = classifyCounts(need);
      if (!shaped.ok) return { ok: false, why: '这个世界里它不成牌型' };
      if (target && !beatsCode(shaped, target)) {
        return { ok: false, why: '这个世界里它压不过' };
      }
      for (const r of ranks) hand[r]--;
      w.totals[pid] -= ranks.length;
      w.lead = { playerId: pid, code: { t: shaped.t, r: shaped.r, n: shaped.n } };
      w.acted = [];
      w.plays[pid] = (w.plays[pid] || 0) + 1;
      if (w.played) for (const r of ranks) w.played[r]++;
      if (shaped.t === COMBO.BOMB || shaped.t === COMBO.ROCKET) w.mult *= 2;
      return { ok: true };
    }

    case 'pass': {
      if (!target) return { ok: false, why: '没有可跟的牌，不能过' };
      if (!w.acted.includes(pid)) w.acted.push(pid);
      return { ok: true };
    }

    case 'reveal':
      // 亮牌不改变牌局，只改变对手的判断 —— 模拟里它就是一个「不推进」的动作
      return { ok: true };

    case 'breach':
      return applyBreach(w, pid, action);

    default:
      return { ok: false, why: `模拟器不认识的动作 ${action.type}` };
  }
}

function applyBreach(w, pid, action) {
  const penalty = Number(action.penalty) || 0;
  const me = w.hands[pid];
  const kind = action.kind;

  if (kind === 'steal') {
    const victim = w.hands[action.from];
    if (!victim || !w.totals[action.from]) return { ok: false, why: '被抢的人手上没牌' };
    let r = 0;
    if (action.card) {
      // 指定了抢哪一张：看得见的牌我能算出点数，看不见的只能按抽样
      const i = w.idxOf.get(action.card);
      if (i === undefined) return { ok: false, why: '要抢的牌不存在' };
      r = w.rankOf[i];
      if (!r || victim[r] <= 0) return { ok: false, why: '这个世界里这张牌不在对方手上' };
    } else {
      // 没指定：从这个世界里对方手上随机抽一张。
      // 用 derivedIndex 而不是 Math.random：同一个世界重跑要抽到同一张，
      // 否则「同一批世界对比不同候选」的共同随机数就失效了。
      const pool = [];
      for (let k = 3; k <= 17; k++) for (let n = 0; n < victim[k]; n++) pool.push(k);
      if (!pool.length) return { ok: false, why: '对方手上没牌' };
      r = pool[derivedIndex(w.seed, (w.pick++) * 7 + 1, pool.length)];
    }
    victim[r]--;
    w.totals[action.from]--;
    me[r]++;
    w.totals[pid]++;
    w.penalty += penalty;
    return { ok: true, penalty };
  }

  if (kind === 'peek') {
    // 偷看只产生信息，不改变牌局
    if (!w.hands[action.target] || !w.totals[action.target]) return { ok: false, why: '对方手上没牌' };
    w.penalty += penalty;
    return { ok: true, penalty };
  }

  if (kind === 'extraplay') {
    const ids = action.cards || [];
    if (ids.length !== 1) return { ok: false, why: '违规甩牌一次只能一张' };
    const i = w.idxOf.get(ids[0]);
    if (i === undefined) return { ok: false, why: '牌不存在' };
    const r = w.rankOf[i];
    if (!r || me[r] <= 0) return { ok: false, why: '这张牌不在你手上' };
    me[r]--;
    w.totals[pid]--;
    w.penalty += penalty;
    return { ok: true, penalty };
  }

  /**
   * 销毁：把一张牌从牌局里彻底拿掉。
   *
   * 模拟里的记账口径要和投影那边一致，否则「销毁」只改变了世界，
   * 没有改变任何人【认为】的局面 —— 而策略正是按后者做决策的。
   *
   *   1. 从某个人的手上消失 → 那个人的张数减一；
   *   2. 同时记进「已不在外面」的计数（played）。
   *      记牌器算的是 `整副牌 − 已出 − 我手上`，销毁掉的牌如果两边都不算，
   *      就会被算成「还在外面」，于是策略继续等着压一张已经不存在的牌。
   *   3. 销毁已经打在桌面上、不属于任何人手牌的那张 → 记账上【什么都不用做】：
   *      它本来就已经在 played 里，销毁不会让它变得「更不在外面」。
   */
  if (kind === 'destroy') {
    const pick = action.pick || 'card';

    const gone = (owner, r) => {
      w.hands[owner][r]--;
      w.totals[owner]--;
      if (w.played) w.played[r]++;
      w.penalty += penalty;
    };

    if (pick === 'random') {
      const victim = w.hands[action.from];
      if (!victim || !w.totals[action.from]) return { ok: false, why: '对方手上没牌' };
      const pool = [];
      for (let k = 3; k <= 17; k++) for (let n = 0; n < victim[k]; n++) pool.push(k);
      if (!pool.length) return { ok: false, why: '对方手上没牌' };
      // 和抢牌一样用 derivedIndex：同一个世界重跑必须抽到同一张
      gone(action.from, pool[derivedIndex(w.seed, (w.pick++) * 7 + 5, pool.length)]);
      return { ok: true, penalty };
    }

    if (pick !== 'card') return { ok: false, why: `模拟器不认识的销毁目标 ${pick}` };

    const cid = action.cardId;
    const i = w.idxOf.get(cid);
    if (i === undefined) return { ok: false, why: '要销毁的牌不存在' };
    const r = w.rankOf[i];
    if (!r) return { ok: false, why: '这个世界里这张牌还没有归属' };

    // 「这张牌在谁手上」按 id 找，不按点数找 —— 点数会撞（四张 7 里
    // 有一张在桌上、有一张在对手手上），id 才分得开。
    const owner = w.order.find((sid) => (w.idsOf[sid] || []).includes(cid));
    if (owner) {
      if (w.hands[owner][r] <= 0) return { ok: false, why: '这个世界里这张牌不在他手上' };
      gone(owner, r);
      return { ok: true, penalty };
    }

    // 不在任何人手上：只能是桌面已出的牌（它已经在 played 里了）
    if (w.played && w.played[r] > 0) {
      w.penalty += penalty;
      return { ok: true, penalty };
    }
    return { ok: false, why: '这个世界里这张牌既不在任何人手上，也不在桌面上' };
  }

  return { ok: false, why: `模拟器不认识的破例 ${kind}` };
}

// ---------------------------------------------------------------------------
// 供测试用：从真实状态造一个世界（用来验证两条通道结论一致）
// ---------------------------------------------------------------------------

export function worldFromState(state, ruleSet) {
  const w = {
    order: state.players.filter((p) => p.alive).map((p) => p.id),
    landlord: state.ruleState?.landlord,
    mult: Math.max(1, state.ruleState?.multiplier || 1),
    hands: {},
    totals: {},
    lead: null,
    acted: [...(state.ruleState?.acted || [])],
    leaderId: state.ruleState?.leaderId || null,
    rankOf: new Uint8Array(64),
    idxOf: new Map(),
    seed: (Number(state.seed) || 1) >>> 0,
    pick: 0,
    penalty: 0,
    // 从中途局面续打时，历史上的出牌手数不能丢 —— 否则「春天」会被重新
    // 判成「还没出过牌」，期望分跟着偏。
    plays: playsFromEvents(state.log),
  };
  for (const p of state.players) {
    const cnt = new Uint8Array(18);
    for (const cid of p.hand) {
      const c = state.cards[cid];
      if (c) cnt[c.rank]++;
    }
    w.hands[p.id] = cnt;
    w.totals[p.id] = p.hand.length;
  }
  for (const [cid, c] of Object.entries(state.cards)) {
    const i = Number(String(cid).replace(/^\D+/, '')) || 0;
    w.idxOf.set(cid, i);
    w.rankOf[i] = c.rank;
  }
  const lead = state.ruleState?.lead;
  if (lead && lead.combo) {
    w.lead = { playerId: lead.playerId, code: codeOf(lead.combo) };
  }

  // 整副牌每个点数几张 + 已经打到桌面上的牌 —— 策略「记牌」的全部原料。
  // 只统计 zone === 'table' 的牌：手上和底牌区的不算，它们本来就在
  // 「已知位置」，重复计入会让「外面还剩几张」算少。
  const totalOf = new Uint8Array(18);
  const played = new Uint8Array(18);
  for (const c of Object.values(state.cards)) {
    if (!c) continue;
    totalOf[c.rank]++;
    if (c.zone === 'table') played[c.rank]++;
  }
  w.totalOf = totalOf;
  w.played = played;

  return w;
}

// ---------------------------------------------------------------------------
// 评估官：把「候选动作」翻译成对局结果
// ---------------------------------------------------------------------------

function mixSeed(a, b) {
  let h = (a >>> 0) ^ Math.imul((b | 0) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * 给「这一手该不该出」造一个评估官。
 *
 * 它的职责只有一件：给定候选动作和世界编号，返回这一局的结果。
 * 采样多少、怎么分配预算、怎么把数字讲成人话，都不归它管 ——
 * 那些是胜率引擎的事。这样换玩法时只要再写一个评估官。
 *
 * 两个容易搞错的地方，这里明确写下来：
 *
 * 1. 【共同随机数】世界编号相同 ⇒ 未知牌的发法相同。所以「候选 A 在第 7 号
 *    世界的胜率」与「候选 B 在第 7 号世界的胜率」是在同一副牌上比的，
 *    不会因为两边抽到不同的牌而出现假差异。
 * 2. 【叫分阶段的地主不是固定的】。候选「叫 3 分」意味着目标是【你】当地主，
 *    候选「不叫」意味着地主是别人。这是两个不同的问题，所以世界的构造
 *    按候选分叉 —— 胜率表里这两行不能直接横着比大小。
 */
export function createDoudizhuJudge({
  view, selfId, ruleSet, ruleState = {}, seed = 20260928, simPolicy = 'smart',
}) {
  const info = publicRuleState(ruleState);
  const dealer = createDealer({ view, ruleSet });
  const order = dealer.seatIds;
  const phase = info.phase === 'bid' ? 'bid' : 'play';
  const me = order.includes(selfId) ? selfId : order[0];
  const others = order.filter((id) => id !== me);

  // 上一次 run 为什么没跑通。引擎拿它填候选行的 reason ——
  // 「一个候选零样本」这种状态，光看胜率表是看不出根因的。
  let lastReason = '';

  function run(action, i) {
    lastReason = '';
    const landlord = (() => {
      if (phase === 'bid') {
        const score = action && action.type === 'bid' ? Number(action.score) || 0 : 0;
        // 叫分：分数 > 0 表示「我要当地主」；不叫表示地主是别人，
        // 逐个候选轮流让不同的对手当地主，避免把胜负全押在一个人身上
        if (score > 0) return me;
        return others[i % Math.max(1, others.length)] || me;
      }
      return info.landlord || order[0];
    })();

    const w = dealer.build(landlord, mixSeed(seed, i), info);
    if (!w) {
      lastReason = '这个世界补不出来（牌数对不上）';
      return null;
    }

    // 世界补出来之后，给三个座位安上策略。
    //
    // 这一步决定了胜率表在回答哪个问题。不设的话 policyOf() 会退回 greedy，
    // 那算的是「三个座位都只会贪心甩小牌」前提下的胜面 —— 数字好看，但不是我
    // 们要的那个。项目从第一天起要的就是「对手最佳应对下的胜率」。
    // 默认 smart 的依据：tools/bench-policy.mjs 实测它在地主 / 农民两个位置上
    // 都明显强于 greedy（同一批牌，综合压制力 B-C 从 +10.7pt 提到 +25.8pt）。
    //
    // 「我自己」也用同一档：算的是「我出这一手、之后大家都好好打」的胜面。
    // 若只让对手变聪明、自己继续贪心，会系统性低估每一个候选。
    w.policy = { bySeat: {} };
    for (const pid of w.order) w.policy.bySeat[pid] = simPolicy;

    const applied = applyCandidate(w, me, action);
    if (!applied.ok) {
      lastReason = applied.why || '这一手在世界里走不通';
      return null;
    }
    const out = playOut(w);
    if (!out) {
      lastReason = '打完这一手之后牌局走不下去了';
      return null;
    }

    const iAmLandlord = me === landlord;
    return {
      won: out.landlordWon === iAmLandlord,
      // 期望得分要扣掉破例的罚分 —— 抢牌抢到一张好牌，账面也可能是赔的
      score: (out.deltas[me] || 0) - w.penalty,
      landlord,
      penalty: w.penalty,
    };
  }

  /** 提示词里用的一句话：这一行的胜率是在哪个前提下算的 */
  function noteFor(action) {
    if (phase !== 'bid') return '';
    const score = action && action.type === 'bid' ? Number(action.score) || 0 : 0;
    if (score > 0) return '这个胜率算的是「你成功当地主」的情况';
    return '这个胜率算的是「你不叫、由别人当地主，你当农民」的情况';
  }

  return {
    gameId: 'doudizhu',
    phase,
    selfId: me,
    seats: order,
    run,
    noteFor,
    /** 这一批世界用的是哪一档对手（引擎把它写进 meta，界面会显示） */
    simPolicy,
    /** 上一次 run 失败的根因（引擎用它填候选行的 reason） */
    get lastReason() { return lastReason; },
    /** 纸牌守恒：为 false 时引擎必须拒绝出数，而不是给一份看着像样的噪声 */
    balanced: dealer.balanced,
    /** 世界总数（未知牌堆的取样空间），引擎按它决定最多能采样多少 */
    worldSpace: 1 << 20,
  };
}

export { MAX_PLIES };
