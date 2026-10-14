/**
 * holdem-sim.js — 德州扑克的胜率评估官
 *
 * 它回答的问题
 * ------------------------------------------------------------------
 * 「我现在这一手（看牌 / 跟注 / 加注到 N / 全下 / 弃牌），把这一手牌打到
 *   摊牌，我能从底池里分到多少钱？」
 *
 * 与 21 点的本质差别
 * ------------------------------------------------------------------
 * 21 点的赢面是一个【可精确计算的数】：庄家的行为被规则写死（17 点以下
 * 必须要牌），所以「接下来会发生什么」是一棵能完整枚举的树。
 * 德州不是：对手加不加注、跟不跟，是他们自己的决定，规则里没有写。
 * 所以这里的数字天然带着一个前提 ——【对手按底池赔率应对】。
 * 引擎把这件事如实写进 meta（opponent: 'odds-based'），界面上也标出来。
 *
 * 为什么按【期望筹码】排序而不是按赢面（metric: 'ev'）
 * ------------------------------------------------------------------
 * 德州的动作会改变输赢的分量：加注赢了收下一个大池，弃牌只赔已经投进去的。
 * 「赢面 30%、赢一次收 30 枚」明显好过「赢面 60%、赢一次收 3 枚」，
 * 按赢面排会系统性地把加注判低、把看牌判高。21 点那边是同一个道理
 * （双倍/分牌会把注翻倍），只是它在赌桌上更早被撞见。
 *
 * 视角补全
 * ------------------------------------------------------------------
 * 只从【投影】里取材，绝不读原始 ruleState 的手牌 —— 那里面躺着对手的真底牌。
 * 看得见的牌 = 我的底牌 + 桌上的公共牌 + 已经对全桌公开的牌。
 * 未见牌堆 = 整副 52 张 − 看得见的 − 已经被销毁的。
 * 把这堆未见牌随机洗开：先按座位顺序补满对手的底牌，剩下的就是【牌堆】，
 * 之后翻牌/转牌/河牌都从这里现抽 —— 抽出来的就是这个世界里的牌。
 *
 * 公开的规则状态走白名单（publicRuleState），与斗地主那边同一条思路：
 * ruleState 是规则包自己的地盘，将来往里塞什么都不奇怪；直接整包交给
 * 模拟器，某天有人加了个「某人看过哪张牌」的字段，胜率立刻变成上帝视角的
 * 胜率 —— 不报错，只是智能体变得「神奇地准」。
 * ------------------------------------------------------------------
 */

import { makeDeck } from '../core/cards.js';
import { derivedIndex, makeRng, shuffle } from '../core/rng.js';
import { score7 } from '../rules/holdem/eval.js';
import { settleHand } from '../rules/holdem/pot.js';
import { chooseAction, handStrength } from '../rules/holdem/policy.js';
import {
  BIG_BLIND, DESTROY_PENALTY, MAX_ROUNDS, NEW_BOARD, START_CHIPS,
  actingOrder, canAct, chipsOf, contendersOf, dequeue, firstSeatOf, levelOf,
  minRaiseOf, needOf, pruneQueue, raiseFloorOf, reopenQueue,
} from '../rules/holdem/index.js';

/** 一手牌最多走几步。正常 3 人局 20 步上下；纯粹防呆 */
const MAX_PLIES = 400;

function mixSeed(a, b) {
  let h = (a >>> 0) ^ Math.imul((b | 0) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const key = (c) => `${c.rank}|${c.suit}`;

/**
 * 从「整副牌」里扣掉一批已知的牌，得到未见牌堆。
 * 按 (点数, 花色) 逐张扣 —— 不能按点数计数扣：那样扣掉一张 7 之后
 * 剩下三张 7 就分不清花色了，而同花/同花顺正是靠花色裁决的。
 */
function subtract(full, used) {
  const counts = new Map();
  for (const c of used) counts.set(key(c), (counts.get(key(c)) || 0) + 1);
  const out = [];
  for (const c of full) {
    const k = key(c);
    const n = counts.get(k) || 0;
    if (n > 0) {
      counts.set(k, n - 1);
      continue;
    }
    out.push({ rank: c.rank, suit: c.suit });
  }
  const leftover = [...counts.values()].reduce((a, b) => a + b, 0);
  return { pool: out, leftover };
}

// ---------------------------------------------------------------------------
// 公开规则状态的白名单
// ---------------------------------------------------------------------------

/**
 * 从规则包的私有状态位里，只取【全桌公开】的那几项。
 *
 * 这些都是「真人坐在牌桌上能自己数出来」的东西：谁投了多少（筹码堆在桌上）、
 * 谁弃了牌、底池多大、轮到谁、庄家是谁、现在第几轮下注。
 * 唯一没写进来的是 hole（底牌）—— 那是这一整局里唯一不能看的东西。
 */
export function publicRuleState(rs) {
  const out = {};
  if (!rs) return out;
  if (typeof rs.phase === 'string') out.phase = rs.phase;
  if (Array.isArray(rs.order)) out.order = [...rs.order];
  if (typeof rs.dealerSeat === 'number') out.dealerSeat = rs.dealerSeat;
  if (typeof rs.stage === 'number') out.stage = rs.stage;
  if (typeof rs.minRaiseInc === 'number') out.minRaiseInc = rs.minRaiseInc;
  if (typeof rs.pot === 'number') out.pot = rs.pot;
  if (rs.contrib && typeof rs.contrib === 'object') out.contrib = { ...rs.contrib };
  if (rs.chips && typeof rs.chips === 'object') out.chips = { ...rs.chips };
  if (rs.folded && typeof rs.folded === 'object') out.folded = { ...rs.folded };
  if (Array.isArray(rs.queue)) out.queue = [...rs.queue];
  return out;
}

// ---------------------------------------------------------------------------
// 评估官
// ---------------------------------------------------------------------------

/**
 * @param view      发起者视角的投影（所有信息的唯一来源）
 * @param selfId    发起者
 * @param ruleState 原始规则状态（只经白名单读取）
 * @param seed      采样种子：同种子必得同一批世界
 */
export function createHoldemJudge({
  view, selfId, ruleSet = null, ruleState = {}, seed = 20260928,
  /**
   * 引擎会把 simPolicy 一起传进来（它自己的默认值是 'smart'），但这个玩法
   * 【只有一种】对手模型：按底池赔率决定跟/弃/加（见 policy.js，规则包的
   * 本地兜底用的是同一份）。没有第二种可切，所以这里既不接受也不转发它 ——
   * 但它必须被【忽略】，不能把请求值当实际值报出去：那样界面会标出
   * 「对手按稳健路线应对」，而模拟里跑的根本不是那一套。
   */
  simPolicy: _requestedPolicy = null,
}) {
  const info = publicRuleState(ruleState);
  const order = info.order || (view.seats || []).map((s) => s.id);
  const n = order.length;
  const me = order.includes(selfId) ? selfId : null;

  const stage = info.stage || 1;
  const dealerSeat = info.dealerSeat || 0;
  const minRaiseInc = info.minRaiseInc || BIG_BLIND;
  const pot = info.pot || 0;
  const contrib = info.contrib || {};
  const chips = info.chips || {};
  const folded = info.folded || {};
  const queue = info.queue || [];

  // -------------------------------------------------------------------------
  // 看得见的牌
  // -------------------------------------------------------------------------
  const seenIds = new Set();
  const seen = [];
  const take = (c) => {
    if (!c || typeof c.rank !== 'number') return;
    if (seenIds.has(c.id)) return;
    seenIds.add(c.id);
    seen.push({ rank: c.rank, suit: c.suit });
  };
  for (const c of view.myHand || []) take(c);
  for (const c of view.table || []) take(c);
  for (const c of view.exposed || []) take(c);

  const myHole = (view.myHand || [])
    .filter((c) => typeof c.rank === 'number')
    .map((c) => ({ rank: c.rank, suit: c.suit }));
  const board = (view.table || [])
    .filter((c) => typeof c.rank === 'number')
    .map((c) => ({ rank: c.rank, suit: c.suit }));

  /**
   * 「牌 id → 牌面」的对照表，只收【发起者认得出来】的牌（自己手上的 + 已公开的）。
   * 销毁候选里点名的那张牌一定来自这里 —— resolveDestroy 会拒绝对着背面牌点名。
   */
  const idFace = new Map();
  for (const c of [...(view.myHand || []), ...(view.table || []), ...(view.exposed || [])]) {
    if (c && typeof c.id === 'string' && typeof c.rank === 'number') {
      idFace.set(c.id, { rank: c.rank, suit: c.suit });
    }
  }

  /**
   * 已经被销毁的牌。它们不在任何人手上、也不在牌堆里，所以必须从未见牌堆里
   * 扣掉 —— 不扣的话，补出来的世界里那几张牌会【复活】，胜率静默偏乐观。
   */
  const burned = (view.burned || [])
    .filter((c) => typeof c.rank === 'number')
    .map((c) => ({ rank: c.rank, suit: c.suit }));

  const seats = (view.seats || []).filter((s) => s.id !== selfId);
  /** 已经被公开亮出来的手牌（摊牌/亮牌）不算「未见」，按座位扣掉，免得重复补一张 */
  const revealedOf = (sid) => (view.exposed || []).filter((c) => c.ownerId === sid).length;
  const oppSlots = seats.reduce(
    (acc, s) => acc + Math.max(0, (s.handCount || 0) - revealedOf(s.id)), 0
  );

  const { pool, leftover } = subtract(makeDeck({ jokers: 0 }), [...seen, ...burned]);

  /** 这一手还要发几张公共牌 */
  const boardLeft = Math.max(0, 5 - board.length);

  /**
   * 纸牌守恒是所有数字的前提。对不上就【不出数】——
   * 一份看着像样的胜率表比一张空白表危险得多。
   *
   * 第三条比高牌那边多一个「牌堆还要够发完剩下的公共牌」：德州的牌堆是
   * 会一直抽到河牌的，抽空了就不是「世界退化」，而是牌局没有定义。
   */
  const balanced =
    leftover === 0 &&
    pool.length === 52 - seen.length - burned.length &&
    pool.length >= oppSlots + boardLeft &&
    myHole.length > 0 &&
    info.phase === 'bet' &&
    !!me &&
    queue[0] === me;

  /**
   * 上一次 run 为什么没跑通。必须是【字符串】：引擎写的是
   * `judge.lastReason || ''`，塞一个函数进去候选行会显示成「(… ) => …」。
   */
  const box = { why: '', last: null };

  /**
   * 只缓存【洗好的顺序】，每次按它重建一个可变的世界。
   *
   * 这里踩过一次（高牌那边的记录）：缓存整个世界对象复用会让候选之间互相污染 ——
   * 世界在模拟里是被就地改的（抽牌、弃牌、把筹码挪进池），于是第二个候选
   * 拿到的是第一个候选打完的局面。症状极隐蔽：数字照样算得出来，只是悄悄偏掉。
   * 缓存顺序仍然必要 —— 共同随机数要求「同编号 = 同一副牌」，
   * 候选之间必须在那副牌上比，否则两行的差里会混进「抽到的牌不同」。
   */
  const orderCache = new Map();
  function worldOrder(i) {
    if (!orderCache.has(i)) {
      orderCache.set(i, shuffle(pool.slice(), makeRng(mixSeed(seed, i))));
    }
    return orderCache.get(i);
  }

  /** 造一个世界：把未见牌堆洗开，先给对手补底牌，剩下的当牌堆 */
  function buildWorld(i) {
    const shuffled = worldOrder(i);
    const seatOf = (pid) => (view.seats || []).find((s) => s.id === pid) || null;
    /**
     * 某个座位上【已经对全桌公开】的手牌（亮牌）。它们已经在 seen 里、
     * 不在未见牌堆里，所以不能从牌堆里再补一张同量级的牌给他 ——
     * 那会让这个座位多出一张牌。这一档在德州的下注阶段不会出现
     * （没人亮牌），但补全这件事不该依赖「不会出现」。
     */
    const revealedOfSeat = (pid) => (view.exposed || [])
      .filter((c) => c.ownerId === pid && typeof c.rank === 'number')
      .map((c) => ({ rank: c.rank, suit: c.suit }));

    let p = 0;
    const hole = {};
    for (const pid of order) {
      if (pid === me) {
        hole[pid] = myHole.map((c) => ({ ...c }));
        continue;
      }
      const revealed = revealedOfSeat(pid);
      const total = ((seatOf(pid) || {}).handCount) || 0;
      const unseen = Math.max(0, total - revealed.length);
      hole[pid] = [...revealed, ...shuffled.slice(p, p + unseen).map((c) => ({ ...c }))];
      p += unseen;
    }
    return {
      order: [...order],
      dealerSeat,
      stage,
      phase: 'bet',
      minRaiseInc,
      pot,
      contrib: { ...contrib },
      chips: { ...chips },
      folded: { ...folded },
      queue: [...queue],
      hole,
      board: board.map((c) => ({ ...c })),
      shoe: shuffled.slice(p).map((c) => ({ ...c })),
      dp: 0,
    };
  }

  // -------------------------------------------------------------------------
  // 世界里的规则执行
  //
  // 与规则包 apply 逐条对应（只是不产生事件）。判据（水位、还欠多少、
  // 最小加注、谁还能行动、队列怎么重开）【全部 import 自规则包】，
  // 这里不重写一份 —— 两处走偏不会报错，只会让胜率悄悄偏。
  // -------------------------------------------------------------------------

  function commit(w, pid, amt) {
    const a = Math.max(0, Math.min(Math.round(amt), chipsOf(w, pid)));
    w.chips[pid] = chipsOf(w, pid) - a;
    w.contrib[pid] = (w.contrib[pid] || 0) + a;
    w.pot = (w.pot || 0) + a;
    return a;
  }

  function applyAction(w, pid, action) {
    /**
     * 先把动作交给【规则包的校验】过一遍。
     *
     * 这一条不是防御性编程，是防走偏：模拟器里有一套自己的下注状态机，
     * 它必须和真牌桌上那套完全一致。不一致的表现是「模拟里能加注、
     * 真牌桌上被拒」—— 两处都不报错，只是胜率悄悄偏，谁也发现不了。
     * 拿规则包的 validate 当判据，走偏的那一步会当场变成「算不出这一行」，
     * 而不是变成一张看着像样的假胜率表。
     */
    if (ruleSet && typeof ruleSet.validate === 'function') {
      const ck = ruleSet.validate({ ruleState: w }, pid, action, { allowBreach: false });
      if (!ck || !ck.ok) {
        return { ok: false, why: `规则包不认这一步（${(ck && ck.reason) || '没有理由'}）` };
      }
    }

    const before = levelOf(w);
    switch (action.type) {
      case 'check':
        dequeue(w, pid);
        break;

      case 'call':
        commit(w, pid, needOf(w, pid));
        dequeue(w, pid);
        break;

      case 'raise': {
        const target = Number(action.amount);
        if (!Number.isFinite(target) || target <= before) {
          return { ok: false, why: `加注的落点 ${action.amount} 不合法` };
        }
        commit(w, pid, target - (w.contrib[pid] || 0));
        w.minRaiseInc = Math.max(minRaiseOf(w), target - before);
        w.queue = reopenQueue(w, pid);
        break;
      }

      case 'allin': {
        const pay = commit(w, pid, chipsOf(w, pid));
        if (!pay) return { ok: false, why: '手上没有筹码可以全下' };
        const after = levelOf(w);
        if (after > before) {
          w.minRaiseInc = Math.max(minRaiseOf(w), after - before);
          w.queue = reopenQueue(w, pid);
        } else {
          dequeue(w, pid);
        }
        break;
      }

      case 'fold':
        w.folded[pid] = true;
        dequeue(w, pid);
        break;

      default:
        return { ok: false, why: `模拟器不认识的候选动作 ${action.type}` };
    }
    pruneQueue(w);
    return { ok: true };
  }

  /** 发一个阶段的公共牌（顺序从这个世界自己的牌堆里现抽） */
  function dealBoard(w, st) {
    const want = NEW_BOARD[st] || 0;
    for (let k = 0; k < want; k++) {
      if (w.dp >= w.shoe.length) return false;
      w.board.push(w.shoe[w.dp++]);
    }
    return true;
  }

  /**
   * 一个下注轮结束之后怎么办 —— 与规则包 resolveRound 的三条去向一一对应。
   * @returns 还会不会再有下注轮（false 表示该摊牌了）
   */
  function advanceStage(w) {
    const cont = contendersOf(w);
    const stillBet = cont.filter((pid) => canAct(w, pid)).length;

    if (cont.length > 1 && w.stage < MAX_ROUNDS && stillBet >= 2) {
      w.stage += 1;
      w.minRaiseInc = BIG_BLIND;
      if (!dealBoard(w, w.stage)) return false;
      w.queue = actingOrder(w, firstSeatOf(w, w.stage));
      pruneQueue(w);
      return true;
    }
    if (cont.length > 1 && w.stage < MAX_ROUNDS) {
      // 都全下了：剩下的公共牌一次发完（真实牌桌也这么干）
      for (let st = w.stage + 1; st <= MAX_ROUNDS; st++) {
        w.stage = st;
        if (!dealBoard(w, st)) break;
      }
    }
    return false;
  }

  /** 摊牌时的比较键。凑不满五张（底牌被销毁过）就给一个比任何真牌型都小的键 */
  function keyOfWorld(w, pid) {
    return score7([...(w.hole[pid] || []), ...w.board]) || [-1];
  }

  function settleWorld(w) {
    const cont = contendersOf(w);
    const keys = cont.length > 1
      ? Object.fromEntries(cont.map((pid) => [pid, keyOfWorld(w, pid)]))
      : null;
    return settleHand(w.contrib, cont, keys, w.order);
  }

  // -------------------------------------------------------------------------
  // 对手怎么打 —— 与规则包的本地兜底同一份策略（policy.js）
  // -------------------------------------------------------------------------

  function policyFor(w, pid) {
    const strength = handStrength(w.hole[pid] || [], w.board);
    const toCall = needOf(w, pid);
    const stack = chipsOf(w, pid);
    const floor = raiseFloorOf(w);
    const pick = chooseAction({
      strength,
      toCall,
      pot: Math.max(w.pot || 0, BIG_BLIND),
      canRaise: (w.contrib[pid] || 0) + stack >= floor,
      raiseTo: floor,
    });
    // 筹码不够跟平时，策略说「跟」就是「全押上剩下的」——
    // 这条由 applyAction 的 call 分支自己处理（只投得起的部分）。
    return pick;
  }

  function playOut(w) {
    let guard = 0;
    let done = false;
    while (guard++ < MAX_PLIES) {
      if (contendersOf(w).length <= 1) { done = true; break; }
      if (!w.queue.length) {
        if (!advanceStage(w)) { done = true; break; }
        continue;
      }
      const pid = w.queue[0];
      const r = applyAction(w, pid, policyFor(w, pid));
      if (!r.ok) return { ok: false, why: `${pid} 在模拟里走不通：${r.why}` };
    }
    if (!done) return { ok: false, why: `模拟没能在 ${MAX_PLIES} 步之内打完这一手` };
    return { ok: true };
  }

  // -------------------------------------------------------------------------
  // 破例「销毁」在世界里的等价动作
  // -------------------------------------------------------------------------

  function destroyInWorld(w, action) {
    const pick = action.pick || 'card';

    if (pick === 'card') {
      const target = idFace.get(action.cardId);
      if (!target) return null;
      // 我自己的底牌
      const mine = w.hole[me] || [];
      const i = mine.findIndex((c) => c.rank === target.rank && c.suit === target.suit);
      if (i >= 0) {
        if (mine.length <= 1) return null;   // 最后一张不可销毁，与规则的底线一致
        mine.splice(i, 1);
        return target;
      }
      // 桌面上的公共牌 —— 毁掉它会让【所有人】的七张都少一张
      const bi = w.board.findIndex((c) => c.rank === target.rank && c.suit === target.suit);
      if (bi >= 0) {
        w.board.splice(bi, 1);
        return target;
      }
      return null;
    }

    if (pick === 'random') {
      const victim = w.hole[action.from];
      if (!victim || victim.length <= 1) return null;
      // 抽哪一张由本地定：发起者看不见对方的手牌，
      // 所以「随便毁一张」在世界里就是均匀地毁一张。
      const idx = derivedIndex(seed, (String(action.from || '').length * 977) + (action.penalty || 0), victim.length);
      return victim.splice(idx, 1)[0];
    }

    if (pick === 'shoe') {
      // 盲烧的是【下一张要发的牌】：牌堆顺序是未知的，所以烧掉它
      // 等价于「下一张公共牌换成再下一张」。
      if (w.dp >= w.shoe.length) return null;
      return w.shoe.splice(w.dp, 1)[0];
    }

    return null;
  }

  // -------------------------------------------------------------------------
  // run：候选动作 → 这一手的结果
  // -------------------------------------------------------------------------

  function run(action, i) {
    box.why = '';
    if (!action) return null;
    if (!balanced) {
      box.why = info.phase !== 'bet'
        ? '这一手已经打完了，没有可模拟的后续'
        : queue[0] !== me
          ? '现在轮到的不是发起者，无法从这一步往后模拟'
          : '未见牌堆补不出来（牌数对不上）';
      return null;
    }

    if (action.type === 'breach' && action.kind === 'peek') {
      // 偷看买到的是【信息】，而模拟里的策略是写死的 —— 知道了也不会改变它怎么打。
      // 硬要给一个数，只会得到「偷看和什么都不做完全一样」的假结果。
      box.why = '偷看是信息型破例：模拟里的策略不会因为多知道一张牌而改变打法，算不出它的价值';
      return null;
    }

    const w = buildWorld(i);
    let penalty = 0;

    if (action.type === 'breach') {
      if (action.kind !== 'destroy') {
        box.why = `破例类型 ${action.kind} 不参与模拟`;
        return null;
      }
      const gone = destroyInWorld(w, action);
      if (!gone) {
        box.why = '这个销毁目标在世界里不存在';
        return null;
      }
      penalty = typeof action.penalty === 'number' ? action.penalty : DESTROY_PENALTY;
      // 罚分是直接从筹码上扣的（规则包也是这么做的），不进底池
      w.chips[me] = Math.max(0, (w.chips[me] || 0) - penalty);
    } else {
      const applied = applyAction(w, me, action);
      if (!applied.ok) {
        box.why = applied.why || '这个动作在世界里走不通';
        return null;
      }
    }

    const out = playOut(w);
    if (!out.ok) {
      box.why = out.why;
      return null;
    }

    const { payouts, uncalled } = settleWorld(w);
    const got = payouts[me] || 0;
    /**
     * 赢面 = 【从底池里分到了钱】，不是「payout > 0」。
     *
     * 差在哪：没人跟的那部分注额会原样退回出钱的人。一个已经弃牌的人
     * 也可能收到退款（他投得比在局的人能跟的还多），那不是赢，是把钱拿回来。
     * 把退款算成「赢」，弃牌那一行的赢面会莫名其妙地不为 0。
     */
    const fromPots = got - (uncalled[me] || 0);
    const score = (w.chips[me] || 0) + got - START_CHIPS;
    // 给自检对账用（生产代码不读它）：世界收尾时的筹码与分池明细
    box.last = { world: w, payouts, uncalled, penalty, score, got, fromPots };
    return {
      won: fromPots > 0,
      /** 这一手打下来我净赢/净亏多少筹码（含已经付出与即将付出的罚分） */
      score,
      penalty,
      payout: got,
    };
  }

  return {
    /** 不是精确解：值依赖对手怎么打，只能采样 */
    exact: false,
    /**
     * 按【期望筹码】排序。德州的动作会改变输赢的分量：加注赢了收一个池、
     * 弃牌只赔已经投进去的 —— 按赢面排会把加注系统性地判低。
     */
    metric: 'ev',
    /** 报的是【实际跑的那套】，不是调用方请求的那套（见构造参数的说明） */
    simPolicy: 'odds-based',
    phase: info.phase,
    balanced,
    /** 引擎读的是这个字段，必须给字符串（见 box 的说明） */
    get lastReason() {
      return box.why;
    },
    run,
    noteFor(action) {
      if (!action) return '';
      if (action.type === 'fold') {
        return '弃牌的期望分是负的：已经投进底池的那些筹码不退';
      }
      if (action.type === 'raise' || action.type === 'allin') {
        return '加注赢了收下的池更大，所以这一行看期望分比看赢面准';
      }
      return '';
    },
    /** 给自检看的体检数据 */
    snapshot() {
      return {
        pool: pool.length,
        seen: seen.length,
        burned: burned.length,
        oppSlots,
        boardLeft,
        balanced,
      };
    },

    /**
     * 下面两个是【自检用的对账口】，生产代码不读。
     *
     * 为什么非要有：这些数字全是采样出来的，光看「算出来了」证明不了「算对了」。
     * 把世界拿出来，就能钉两件最要紧的事 ——
     *   1. 补出来的世界里不会出现我已经看得见的牌（补全是不是干净）；
     *   2. 打完之后 Σ(手上筹码 + 分回来的钱) 与开局的总筹码对得上（钱有没有漏）。
     */
    debugWorld(i) {
      return balanced ? buildWorld(i) : null;
    },
    get lastRun() {
      return box.last;
    },
  };
}
