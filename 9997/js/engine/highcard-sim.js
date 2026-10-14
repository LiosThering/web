/**
 * highcard-sim.js — 比大小的胜率评估官
 *
 * 它回答的问题
 * ------------------------------------------------------------------
 * 「我现在这一手（换 / 不换），把这一轮打到摊牌，赢下来的概率是多少？」
 *
 * 为什么是采样，而不是像 21 点那样的精确解
 * ------------------------------------------------------------------
 * 21 点的赢面能精确算出来，是因为【庄家的行为被规则写死了】（17 点以下必须要牌），
 * 于是「接下来会发生什么」是一棵可以完整枚举的树。
 * 比大小不是：对手换不换牌，是他们自己的决定，规则里没有写。
 * 所以这里的数字天然带着一个前提 ——【对手会稳健应对】。
 * 这个前提不是缺陷，是这一玩法与 21 点的本质差别；
 * 引擎把它如实写进 meta（opponent: 'steady'），界面上也照样标出来。
 *
 * 视角补全
 * ------------------------------------------------------------------
 * 只从【投影】里取材，绝不读原始 ruleState —— 那里面躺着对手的真实手牌。
 * 看得见的牌 = 我的手牌 + 桌面上的牌（换牌弃掉的、以及别的玩法摊开的）。
 * 未见牌堆 = 整副 52 张 − 看得见的 − 已经被销毁的。
 * 然后把这堆未见牌随机洗开：前几张按座位顺序发给对手，剩下的是牌堆顺序。
 *
 * 这一步同时解释了「为什么销毁的牌必须公开牌面」（见 state.js 的 destroy）：
 * 不公开的话，未见牌堆就变成「少了一张、但少的是哪张不确定」的集合，
 * 补出来的世界与真实牌堆的构成对不上，胜率会静默偏掉。
 */

import { makeDeck } from '../core/cards.js';
import { makeRng, derivedIndex, shuffle } from '../core/rng.js';
import { MAX_SWAPS, swapWorthwhile } from '../rules/highcard/index.js';

/** 把牌堆洗成确定的一副（同 seed 必得同一副） */
function mixSeed(a, b) {
  let h = (a >>> 0) ^ Math.imul((b | 0) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

const key = (c) => `${c.rank}|${c.suit}`;

/**
 * 从「整副牌」里扣掉一批已知的牌，得到未见牌堆。
 * 按 (点数, 花色) 逐张扣 —— 不能用点数计数去扣：那样扣掉一张 7 之后
 * 剩下的三张 7 就无法区分了，而花色是同和时唯一的裁决依据。
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

/** 一手的比较键：和 → 最大单张的点数 → 最大单张的花色 */
const SUIT_RANK = { S: 4, H: 3, D: 2, C: 1 };
function keyOf(cards) {
  let sum = 0;
  let rank = 0;
  let suit = 0;
  for (const c of cards) {
    sum += c.rank;
    const s = SUIT_RANK[c.suit] || 0;
    if (c.rank > rank || (c.rank === rank && s > suit)) {
      rank = c.rank;
      suit = s;
    }
  }
  return { sum, rank, suit };
}
function beats(a, b) {
  if (a.sum !== b.sum) return a.sum > b.sum;
  if (a.rank !== b.rank) return a.rank > b.rank;
  return a.suit > b.suit;
}

export function createHighcardJudge({
  view, selfId, ruleSet = null, ruleState = {}, seed = 20260928,
  /**
   * 引擎会把 simPolicy 一起传进来（它自己的默认值是 'smart'），但这个玩法
   * 【只有一种】对手模型：手上较小的那张低于未见牌堆均值就换（见 policyFor）。
   * 没有第二种可切，所以这里既不接受也不转发这个请求 —— 但它必须被【忽略】，
   * 不能把请求值当成实际值报出去：那样界面会标出「对手按某套学习策略应对」，
   * 而模拟里跑的根本不是那套。
   * 21 点的评估官就是这么处理的：它固定报 'dealer-fixed'（庄家行为被规则写死），
   * 而不是照抄传进来的值。
   */
  simPolicy: _requestedPolicy = null,
}) {
  const roundNo = view.round || 1;
  const tag = `s${roundNo}-`;
  const inRound = (id) => typeof id === 'string' && id.startsWith(tag);

  // -------------------------------------------------------------------------
  // 看得见的牌
  // -------------------------------------------------------------------------
  const seenIds = new Set();
  const seen = [];
  const take = (c) => {
    if (!c || c.facing !== 'face' || typeof c.rank !== 'number') return;
    if (!inRound(c.id) || seenIds.has(c.id)) return;
    seenIds.add(c.id);
    seen.push({ rank: c.rank, suit: c.suit });
  };
  for (const c of view.myHand || []) take(c);
  for (const c of view.table || []) take(c);
  for (const c of view.exposed || []) take(c);

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
   * 已经被销毁的牌。
   * 它们不在任何人手上、也不在牌堆里，所以必须从未见牌堆里扣掉 ——
   * 不扣的话，补出来的世界里那几张牌会【复活】，胜率会静默偏乐观。
   */
  const burned = (view.burned || [])
    .filter((c) => typeof c.rank === 'number')
    .map((c) => ({ rank: c.rank, suit: c.suit }));

  const seats = (view.seats || []).filter((s) => s.id !== selfId);
  const mySeat = (view.seats || []).find((s) => s.id === selfId) || null;
  const myHandCount = mySeat ? mySeat.handCount : 0;
  const oppSlots = seats.reduce((n, s) => n + (s.handCount || 0), 0);

  const { pool, leftover } = subtract(makeDeck({ jokers: 0 }), [...seen, ...burned]);

  /**
   * 纸牌守恒是所有数字的前提。
   * 对不上就【不出数】—— 一份看着像样的胜率表比一张空白表危险得多。
   *
   * 第三条只要求「牌够发给对手」，不是「够发之外还能多一张」。
   * 为什么是刚好够、而不是留一张余量：未见牌堆的构成就是「整副 − 看得见的」，
   * 对手手上的暗牌【本来就从这个堆里出】。堆的量恰好等于对手手牌总量时，
   * 牌堆为空，这一种世界退化成「所有人都不换」—— 那是一个合法且确定的世界，
   * policyFor 里已有一条「牌堆空了就停牌」兜底，走不出岔子。
   * 硬留一张余量会把一整类可确定的世界排除在外，白丢信息。
   */
  const balanced =
    leftover === 0 &&
    pool.length === 52 - seen.length - burned.length &&
    pool.length >= oppSlots &&
    myHandCount > 0;

  const phase = view.phase;
  /**
   * 上一次 run 为什么没跑通。
   *
   * 必须是【字符串】：引擎那边写的是 `judge.lastReason || ''`，
   * 直接塞一个取值函数进去，候选行会显示成「(… ) => lastReason」这种
   * 谁也看不懂的东西。这里用一个盒子装着，靠 getter 读出来。
   */
  const box = { why: '' };

  /**
   * 只缓存【洗好的顺序】，每次按它重建一个可变的世界。
   *
   * 这里踩过一次：最早把整个世界对象缓存下来复用，结果是候选之间互相污染 ——
   * 世界在模拟里是会被就地改的（抽牌、弃牌、把牌从手上摘掉），
   * 于是「第二个候选」拿到的是「第一个候选打完」的局面。
   * 症状很隐蔽：数字全都算得出来、也不报错，只是「盲烧牌堆顶」
   * 这种毫无道理的一手会显示成 56.7%（而真实基线只有 18%）。
   *
   * 缓存顺序仍然必要 —— 共同随机数要求「同一编号 = 同一副牌」，
   * 候选之间必须在那副牌上比，否则两行数字的差里会混进「抽到的牌不同」。
   */
  const orderCache = new Map();
  function worldOrder(i) {
    if (!orderCache.has(i)) {
      orderCache.set(i, shuffle(pool.slice(), makeRng(mixSeed(seed, i))));
    }
    return orderCache.get(i);
  }

  /** 造一个世界：把未见牌堆洗开，先给对手发牌，剩下的当牌堆 */
  function buildWorld(i) {
    const shuffled = worldOrder(i);
    let p = 0;
    const cards = {};
    for (const s of seats) {
      const n = s.handCount || 0;
      cards[s.id] = shuffled.slice(p, p + n).map((c) => ({ ...c }));
      p += n;
    }
    const w = {
      cards,
      deck: shuffled.slice(p).map((c) => ({ ...c })),
      dp: 0,
      queue: (view.seats || []).map((s) => s.id),
      swaps: {},
      discard: [],
    };
    // 我自己的手牌是看得见的，直接用真实的两张
    cards[selfId] = (view.myHand || [])
      .filter((c) => typeof c.rank === 'number')
      .map((c) => ({ rank: c.rank, suit: c.suit }));

    // 已经公开的弃牌要从一开始就在「公开信息」里 —— 策略靠它判断
    for (const c of view.table || []) {
      if (c.facing === 'face' && inRound(c.id) && typeof c.rank === 'number') {
        w.discard.push({ rank: c.rank, suit: c.suit });
      }
    }
    return w;
  }

  /** 在世界里执行一个动作（不产生事件，只改变世界） */
  function applyInWorld(w, pid, action) {
    const hand = w.cards[pid] || [];
    if (action.type === 'stand') {
      const i = w.queue.indexOf(pid);
      if (i >= 0) w.queue.splice(i, 1);
      return { ok: true };
    }
    if (action.type === 'hit') {
      if (hand.length < 2) return { ok: false, why: '手上不足两张，换不了' };
      if ((w.swaps[pid] || 0) >= MAX_SWAPS) return { ok: false, why: '换牌次数已用完' };
      if (w.dp >= w.deck.length) return { ok: false, why: '牌堆空了' };
      // 换掉较小的那张 —— 与规则包同一条规则，不能各写一份
      let wi = 0;
      for (let k = 1; k < hand.length; k++) if (hand[k].rank < hand[wi].rank) wi = k;
      w.discard.push(hand[wi]);
      hand[wi] = w.deck[w.dp++];
      w.swaps[pid] = (w.swaps[pid] || 0) + 1;
      const qi = w.queue.indexOf(pid);
      if (qi >= 0) {
        w.queue.splice(qi, 1);
        w.queue.push(pid);
      }
      return { ok: true };
    }
    return { ok: false, why: '这个动作在世界里走不通' };
  }

  /** 破例「销毁」在世界里的等价动作：把那张牌从世界的一切地方抹掉 */
  function destroyInWorld(w, pid, action) {
    const pick = action.pick || 'card';
    if (pick === 'card') {
      // 指定销毁：能被点名的牌只有「自己手上的」和「桌面上已经公开的」
      // （resolveDestroy 的 identifiable 检查保证这一点）。
      const target = idFace.get(action.cardId);
      if (!target) return null;
      const hand = w.cards[pid] || [];
      const idx = hand.findIndex((c) => c.rank === target.rank && c.suit === target.suit);
      if (idx < 0) {
        // 桌面上那张：它本来就不在任何人的手上（也不是牌堆的一部分），
        // 所以抹掉它对这个世界没有任何影响 —— 这正是「销毁弃牌」的真相。
        return { rank: target.rank, suit: target.suit };
      }
      if (hand.length <= 1) return null; // 最后一张不可销毁，与规则的底线一致
      hand.splice(idx, 1);
      return target;
    }
    if (pick === 'random') {
      const victim = w.cards[action.from];
      if (!victim || victim.length <= 1) return null;
      // 抽哪一张由本地定：发起者看不见对方的手牌，
      // 所以「随便毁一张」在世界里就是均匀地毁一张。
      const idx = derivedIndex(seed, i0(action), victim.length);
      const gone = victim[idx];
      victim.splice(idx, 1);
      return gone;
    }
    if (pick === 'shoe') {
      if (w.dp >= w.deck.length) return null;
      const gone = w.deck[w.dp];
      w.deck.splice(w.dp, 1);
      return gone;
    }
    return null;
  }

  /** 给「随机销毁」派生下标用：同一个世界编号下必须稳定 */
  function i0(action) {
    return (String(action.from || '').length * 977) + (action.penalty || 0);
  }

  /** 一个座位在自己的回合会怎么走（只看它自己看得见的东西） */
  function policyFor(w, pid) {
    const hand = w.cards[pid] || [];
    if (hand.length < 2) return { type: 'stand' };
    if ((w.swaps[pid] || 0) >= MAX_SWAPS) return { type: 'stand' };
    // 牌堆空了就没有「换」这个选项。不加这一条，策略会一直返回 hit，
    // 而 applyInWorld 又走不通 —— 队列会被 shift 掉，回合静默提前结束。
    if (w.dp >= w.deck.length) return { type: 'stand' };
    const mine = hand.map((c) => c.rank);
    const publicRanks = w.discard.map((c) => c.rank);
    return swapWorthwhile(mine, publicRanks) ? { type: 'hit' } : { type: 'stand' };
  }

  function playOut(w) {
    let guard = 0;
    while (w.queue.length && guard++ < 400) {
      const pid = w.queue[0];
      const a = policyFor(w, pid);
      const r = applyInWorld(w, pid, a);
      if (!r.ok) {
        // 走不动就把他摘出队列：这里不该发生，但发生了也不能转圈
        w.queue.shift();
      }
    }
    let best = null;
    for (const pid of Object.keys(w.cards)) {
      const k = keyOf(w.cards[pid]);
      if (!best || beats(k, keyOf(w.cards[best]))) best = pid;
    }
    return best;
  }

  /**
   * @param action 候选动作
   * @param i      世界编号（共同随机数：同编号 = 同一副补出来的牌）
   */
  function run(action, i) {
    box.why = '';
    if (!balanced) {
      box.why = '未见牌堆补不出来（牌数对不上）';
      return null;
    }
    if (!action) return null;

    if (action.type === 'breach' && action.kind === 'peek') {
      // 偷看买到的是【信息】，而模拟里的策略是写死的 —— 知道了也不会改变它怎么打。
      // 硬要给一个数，只会得到「偷看和行动前完全一样」的假结果。
      box.why = '偷看是信息型破例：模拟里的策略不会因为多知道一张牌而改变打法，算不出它的价值';
      return null;
    }

    const w = buildWorld(i);

    if (action.type === 'breach') {
      if (action.kind !== 'destroy') {
        box.why = `破例类型 ${action.kind} 不参与模拟`;
        return null;
      }
      const gone = destroyInWorld(w, selfId, action);
      if (!gone) {
        box.why = '这个销毁目标在世界里不存在';
        return null;
      }
      const winner = playOut(w);
      const penalty = typeof action.penalty === 'number' ? action.penalty : 0;
      return {
        won: winner === selfId,
        score: (winner === selfId ? 1 : 0) - penalty,
        penalty,
      };
    }

    const applied = applyInWorld(w, selfId, action);
    if (!applied.ok) {
      box.why = applied.why || '这个动作在世界里走不通';
      return null;
    }
    const winner = playOut(w);
    return { won: winner === selfId, score: winner === selfId ? 1 : 0 };
  }

  return {
    /** 不是精确解：值依赖对手怎么打，只能采样 */
    exact: false,
    metric: 'win',
    /**
     * 报的是【实际跑的那套】，不是调用方请求的那套（见构造参数处的说明）。
     * 引擎与界面都读这个字段来决定给用户看什么话。
     */
    simPolicy: 'steady',
    phase,
    balanced,
    /** 引擎读的是这个字段，必须给字符串（见 box 的说明） */
    get lastReason() {
      return box.why;
    },
    run,
    noteFor(action) {
      if (action && action.type === 'hit') return '换牌之后这一轮的胜率（对手会稳健应对）';
      return '';
    },
    snapshot() {
      return { pool: pool.length, seen: seen.length, burned: burned.length, oppSlots, balanced };
    },
  };
}
