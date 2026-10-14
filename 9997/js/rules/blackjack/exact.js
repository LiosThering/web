/**
 * exact.js — 21 点的精确概率引擎（零采样）
 *
 * 这里不算蒙特卡洛。21 点的胜负完全由「补牌的顺序」决定，而补牌顺序的
 * 每一种可能都在牌堆里列得出来 —— 所以赢面是一个【能精确算出来的数】，
 * 采样只会给它加噪声。
 *
 * 怎么算的
 * ------------------------------------------------------------------
 * 1. 整副牌压成 10 个【点数组】（2,3,4,5,6,7,8,9,10,A）。同组内的牌完全可互换，
 *    所以这不是近似，是等价类 —— 52 张牌的组合数一下就掉到几千种。
 * 2. 庄家的行为是定死的（<17 必须要牌，≥17 停），所以「明牌 + 未见牌堆」
 *    能推出庄家最终点数的【精确分布】，递归枚举即可。
 * 3. 玩家的每个动作，都用这个分布 + 递归算精确的胜/负/平概率。
 *    最优动作就是这些精确值的 argmax —— 不需要优化器，也不需要训练。
 *
 * 两种牌堆模型 × 两种偷看规则，四个组合的差别都是真实的
 * ------------------------------------------------------------------
 *   infinite = true  抽牌后【放回】：每次抽牌的概率恒定。
 *                    这是教科书基本策略表的假设，也是牌堆模型无关的那一套。
 *   infinite = false 抽牌后【扣减】：真实单副牌，抽走一张就少一张。
 *
 *   peek = true  庄家明牌是 A 或 10 时先偷看暗牌，是黑杰克就当场收局。
 *                于是玩家决策时「庄家一定没有黑杰克」，分布要条件化。
 *   peek = false 不偷看（欧式），暗牌到庄家补牌时才翻。
 *
 * 这四项不是可有可无的开关。实测：不条件化（peek=false）时，单副牌下
 * 「11 对 10」的最优动作是【要牌】；条件化之后变成【双倍】——
 * 与 Wong 的 6 副牌表（要牌 11.8 分 / 双倍 17.8 分）一致。
 * 差别大到足以改变策略，所以它必须是显式参数，不能藏在某处默认值里。
 * ------------------------------------------------------------------
 */

import {
  FULL_COUNTS, GROUP_VALUES, addCard, countTotal, faceValue, groupOfRank, handTotal, isNatural, isPair,
} from './hand.js';

/** 一副牌的组数 */
const G = GROUP_VALUES.length;

/** 一副牌的总张数 */
const FULL_TOTAL = FULL_COUNTS.reduce((a, b) => a + b, 0);

/** 庄家停牌的界限：小于它必须要牌 */
const DEALER_STAND = 17;

/**
 * 天然 21 点的赔率。
 *
 * 它改的是【钱】不是【概率】：天然 21 点的赢面和平手的 21 点完全一样，
 * 但赢了赔 1.5 倍。所以这一项只能体现在期望值上 ——
 * 如果拿一个统一的 bet=1 去算，天然 21 点的价值会被系统性地低估 1/3，
 * 于是「要不要拿天然 21 点去分牌 / 双倍」这类判断会整片算错。
 */
const NATURAL_BET = 1.5;

/** 放过牌的累积计数，用来在自检和界面里说明「这次算了多少」，而不是凭感觉说很准 */
export const exactStats = { nodes: 0, memoHits: 0 };

const memoDealer = new Map();
const memoCont = new Map();
const memoBest = new Map();

/** 记忆表上限：防止一局活太久时无限膨胀（到了就整体清空，重新算） */
const MEMO_CAP = 300000;

export function resetExactStats() {
  exactStats.nodes = 0;
  exactStats.memoHits = 0;
  memoDealer.clear();
  memoCont.clear();
  memoBest.clear();
}

export function memoSize() {
  return memoDealer.size + memoCont.size + memoBest.size;
}

function guardMemo(map) {
  if (map.size > MEMO_CAP) map.clear();
}

/**
 * 牌堆模型 + 偷看规则，被打包成一个对象往下传。
 * 拆成两个布尔参数到处传的话，任何一处漏传都会静默算成另一个规则 ——
 * 这正是「同一份代码悄悄算出两套数」的经典成因。
 */
function modelKey(m) {
  return `${m.infinite ? 'I' : 'F'}${m.peek ? 'P' : '-'}`;
}

function countsKey(counts, model) {
  if (model.infinite) return modelKey(model);
  return `${modelKey(model)}${counts.join('.')}`;
}

const DEFAULT_MODEL = { infinite: false, peek: true };

// ---------------------------------------------------------------------------
// 庄家的最终点数分布
// ---------------------------------------------------------------------------

/**
 * 庄家最终点数的精确分布。
 *
 * @param upValue  庄家明牌的面值（2..11，11 代表 A）。它【不在】counts 里。
 * @param counts   未见牌堆的计数向量。庄家的暗牌就在这里面 —— 它是一张
 *                 「均匀随机的未知牌」，所以直接按概率抽就行了，不需要
 *                 枚举「暗牌具体是哪张」。
 * @param model    { infinite, peek }
 *
 * peek = true 时要把「天然 21 点」那一支整个条件掉再归一化。
 * 漏掉这一步的后果很具体：11 对 10 会算成「不该双倍」，因为双倍多押的
 * 那一份被算成会输给庄家的黑杰克，而实际上那一份根本来不及下注。
 *
 * @returns {{ totals: Float64Array, bust:number, natural:number }}
 *   totals[17..21] 是最终落在这些点数的概率；natural 是「两张牌就 21 点」的概率
 *   （它同时被计入 totals[21]，因为结算时两者对玩家的含义不同）。
 *   peek = true 时 natural 恒为 0 —— 那些局面在决策时已经不存在了。
 */
export function dealerOutcome(upValue, counts, model = DEFAULT_MODEL) {
  const key = `${upValue}|${countsKey(counts, model)}`;
  const cached = memoDealer.get(key);
  if (cached) {
    exactStats.memoHits++;
    return cached;
  }

  const totals = new Float64Array(22);
  let bust = 0;
  let natural = 0;

  const stock = model.infinite ? FULL_COUNTS : counts;

  const recur = (total, soft, cards, p) => {
    exactStats.nodes++;
    if (total > 21) {
      bust += p;
      return;
    }
    if (total >= DEALER_STAND) {
      totals[total] += p;
      if (cards === 2 && total === 21) natural += p;
      return;
    }
    const n = model.infinite ? FULL_TOTAL : countTotal(stock);
    if (!n) {
      // 牌堆空了。单副牌里庄家一个人抽不到这一步，但真到了就按现状停手，
      // 而不是假装还有牌可抽 —— 那会算出一个不存在的概率。
      totals[Math.min(total, 21)] += p;
      return;
    }
    for (let g = 0; g < G; g++) {
      const c = stock[g];
      if (!c) continue;
      const pg = c / n;
      const nv = addCard(total, soft, GROUP_VALUES[g]);
      if (!model.infinite) stock[g]--;
      recur(nv.total, nv.soft, cards + 1, p * pg);
      if (!model.infinite) stock[g]++;
    }
  };

  recur(upValue, upValue === 11, 1, 1);

  if (model.peek && natural > 0) {
    // 条件化到「庄家没有黑杰克」。注意要先从 totals[21] 里减掉天然那一支
    // 再归一化，否则天然 21 点会留在分布里冒充「补出来的 21 点」，
    // 等于偷看根本没生效。
    const keep = 1 - natural;
    totals[21] -= natural;
    for (let t = 0; t < totals.length; t++) totals[t] /= keep;
    bust /= keep;
    natural = 0;
  }

  const out = { totals, bust, natural };
  guardMemo(memoDealer);
  memoDealer.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

const EMPTY = { win: 0, lose: 0, push: 0 };

/**
 * 「庄家是天然 21 点」的【无条件】概率 —— 偷看口径做联合条件化时要用它。
 *
 * 为什么要单独抽一个函数：dealerOutcome 在 peek=true 时会把 natural 清成 0
 * （那是它该做的事 —— 条件化之后那一支确实不存在了），所以想读「没被条件化
 * 之前天然占多少」就只能去问 peek=false 的那一份。两份共用同一个记忆表，
 * key 里带了 F/I 与 P/-，不会互相覆盖。
 */
function naturalProb(upValue, counts, model) {
  return dealerOutcome(upValue, counts, { infinite: model.infinite, peek: false }).natural;
}

/**
 * 偷看口径下「我抽到第 g 组」这一张牌的条件化权重。
 *
 * 真牌桌的顺序是：先发完牌（含暗牌），庄家偷看，然后我才行动。所以
 * 「庄家不是黑杰克」不只是对庄家分布的约束 —— 它是【整局已知的条件】，
 * 连「我接下来会抽到哪张」的概率都要跟着它重新归一。
 *
 *   无条件抽到 g 的概率          pg = c_g / n
 *   抽走 g 之后庄家仍非天然的概率  1 - nat_g
 *   无条件非天然的概率            1 - nat_0
 *   ⇒ P(抽到 g | 非天然) = pg · (1 - nat_g) / (1 - nat_0)
 *
 * 「我抽走的牌」与「庄家是否黑杰克」是相关的（抽走一张 10 会让暗牌更不像 10），
 * 所以这个修正系数不等于 1。明牌是 A 时天然占比最高（约 31%），这项最强：
 * 实测 5 张小牌堆上能让双倍的赢面差 3.3 个百分点。
 *
 * 无限牌堆口径下它恒等于 1（抽牌不改变牌堆构成），所以教科书那一套不受影响。
 */
function drawWeight(pg, upValue, counts, model, cond, denom) {
  if (!cond) return pg;
  return (pg * (1 - naturalProb(upValue, counts, model))) / denom;
}

/** 偷看是否需要在抽牌这一层做联合条件化；denom 是归一因子 */
function peekCond(model, upValue, counts, n) {
  if (!model.peek || model.infinite) return { cond: false, denom: 1 };
  // 明牌不是 10/A 时庄家不可能是黑杰克，条件化不影响任何东西
  if (!(upValue >= 10)) return { cond: false, denom: 1 };
  const denom = 1 - naturalProb(upValue, counts, model);
  if (!(denom > 0) || n <= 0) return { cond: false, denom: 1 };
  return { cond: true, denom };
}

/**
 * 「我现在停手」的精确战绩。
 *
 * 两条容易写错的地方：
 *   · 庄家的【天然 21 点】压过我的任何点数，包括我的天然 21 点 ——
 *     那是平局，不是赢。它和「庄家补出来的 21 点」必须分开算：
 *     我的 21 点对庄家补出来的 21 点是平局，对天然 21 点却是输。
 *   · 我不到 17 点的时候其实一场都赢不了（庄家不会停在 17 以下），
 *     所以爆牌之外的低点数全部落在「输」这一栏 —— 把它写成「平」是
 *     一个很自然但代价很大的笔误。
 */
export function standStats(total, natural, d) {
  // 爆牌：什么都赢不了。防御性分支 —— 正常流程里爆牌的那一手会被直接判负，
  // 根本轮不到来问「停手值多少」，但算分牌的子手时确实可能走到这里。
  if (total > 21) return { win: 0, lose: 1, push: 0 };

  let win = d.bust;
  let lose = 0;
  let push = 0;

  for (let t = 17; t <= 20; t++) {
    const p = d.totals[t];
    if (!p) continue;
    if (total > t) win += p;
    else if (total === t) push += p;
    else lose += p;
  }

  const pNat = d.natural;
  const pOther21 = d.totals[21] - pNat;
  if (pNat) {
    if (natural) push += pNat;
    else lose += pNat;
  }
  if (pOther21) {
    if (total === 21) push += pOther21;
    else lose += pOther21;
  }

  return { win, lose, push };
}

// ---------------------------------------------------------------------------
// 玩家侧的递归
// ---------------------------------------------------------------------------

/**
 * 继续决策的战绩（只有在 要牌 / 停牌 之间选）。
 *
 * 用在「已经要过牌」之后：手里 ≥3 张时不能双倍、也不能再分，
 * 所以后续的决策空间只有这两个动作。取价值高的那个。
 */
function contStats(total, soft, upValue, counts, model) {
  const key = `${total}.${soft ? 1 : 0}|${upValue}|${countsKey(counts, model)}`;
  const cached = memoCont.get(key);
  if (cached) {
    exactStats.memoHits++;
    return cached;
  }
  exactStats.nodes++;

  const d = dealerOutcome(upValue, counts, model);
  const stay = standStats(total, false, d);
  const draw = hitStats(total, soft, upValue, counts, model);

  const out = draw.win - draw.lose > stay.win - stay.lose + 1e-15 ? draw : stay;
  guardMemo(memoCont);
  memoCont.set(key, out);
  return out;
}

/** 「再要一张」的精确战绩（抽到爆牌算输） */
function hitStats(total, soft, upValue, counts, model) {
  let win = 0;
  let lose = 0;
  let push = 0;

  const stock = model.infinite ? FULL_COUNTS : counts;
  const n = model.infinite ? FULL_TOTAL : countTotal(stock);
  if (!n) return EMPTY;
  const { cond, denom } = peekCond(model, upValue, stock, n);

  for (let g = 0; g < G; g++) {
    const c = stock[g];
    if (!c) continue;
    const pg = c / n;
    const nv = addCard(total, soft, GROUP_VALUES[g]);
    if (!model.infinite) counts[g]--;
    const w = drawWeight(pg, upValue, counts, model, cond, denom);

    if (nv.total > 21) {
      lose += w;
    } else {
      const s = contStats(nv.total, nv.soft, upValue, counts, model);
      win += w * s.win;
      lose += w * s.lose;
      push += w * s.push;
    }

    if (!model.infinite) counts[g]++;
  }

  return { win, lose, push };
}

/**
 * 一手两牌的精确战绩（要牌 / 停牌 / 双倍 三选一）。
 *
 * @param opts.allowDouble  能不能双倍
 * @param opts.naturalOk    这手牌有没有资格算天然 21 点。分牌之后的 21 点
 *                          【不算】天然，这是通行规则，也是分牌策略里
 *                          必须区分的一点（差 0.5 倍赔率）。
 */
function bestTwoCardStats(ranks, upValue, counts, model, { allowDouble = true, naturalOk = true } = {}) {
  const t = handTotal(ranks);
  if (t.total >= 21) {
    const natural = naturalOk && isNatural(ranks);
    return { stats: standStats(t.total, natural, dealerOutcome(upValue, counts, model)), action: 'stand' };
  }

  const key = `${ranks.join('.')}|${upValue}|${countsKey(counts, model)}|${allowDouble ? 1 : 0}${naturalOk ? 1 : 0}`;
  const cached = memoBest.get(key);
  if (cached) {
    exactStats.memoHits++;
    return cached;
  }

  const natural = naturalOk && isNatural(ranks);
  const stay = { stats: standStats(t.total, natural, dealerOutcome(upValue, counts, model)), action: 'stand' };
  const draw = { stats: hitStats(t.total, t.soft, upValue, counts, model), action: 'hit' };

  let best = draw.stats.win - draw.stats.lose > stay.stats.win - stay.stats.lose + 1e-15 ? draw : stay;

  if (allowDouble) {
    const doubled = { stats: oneCardStats(t.total, t.soft, upValue, counts, model), action: 'double', bet: 2 };
    if ((doubled.stats.win - doubled.stats.lose) * 2 > best.stats.win - best.stats.lose + 1e-15) {
      best = doubled;
    }
  }

  guardMemo(memoBest);
  memoBest.set(key, best);
  return best;
}

/** 双倍：只准再要一张，然后必须停手。抽爆算输。 */
function oneCardStats(total, soft, upValue, counts, model) {
  let win = 0;
  let lose = 0;
  let push = 0;

  const stock = model.infinite ? FULL_COUNTS : counts;
  const n = model.infinite ? FULL_TOTAL : countTotal(stock);
  if (!n) return EMPTY;
  const { cond, denom } = peekCond(model, upValue, stock, n);

  for (let g = 0; g < G; g++) {
    const c = stock[g];
    if (!c) continue;
    const pg = c / n;
    const nv = addCard(total, soft, GROUP_VALUES[g]);
    if (!model.infinite) counts[g]--;
    const w = drawWeight(pg, upValue, counts, model, cond, denom);
    if (nv.total > 21) {
      lose += w;
    } else {
      const s = standStats(nv.total, false, dealerOutcome(upValue, counts, model));
      win += w * s.win;
      lose += w * s.lose;
      push += w * s.push;
    }
    if (!model.infinite) counts[g]++;
  }

  return { win, lose, push };
}

/**
 * 分牌的战绩。
 *
 * 精确到什么程度，说清楚：
 *   · 两手的【第二张牌】是穷举的 —— 所有组合都按真实概率加权，这部分是精确的。
 *   · 两手后续的补牌【各自独立估值】—— 忽略了两手之间抢同一张牌的耦合。
 *     这是教科书算分牌时的通行做法；单副牌下它有微小偏差，方向是
 *     「略微高估」，因为实际上一手多抽走的牌会削掉另一手的好牌。
 *
 * 分 A 单独处理：分完之后每边只补一张，不能再要也不能双倍（通行规则）。
 * 规则包只允许分一次（两手），所以这里不需要「再分」的递归 ——
 * 这不是省事，是规则真的只到这一步，引擎和规则包必须对齐。
 */
function splitStats(pairRankValue, upValue, counts, model) {
  const isAces = pairRankValue === 11;

  let win = 0;
  let lose = 0;
  let push = 0;
  let weight = 0;

  const stockOuter = model.infinite ? FULL_COUNTS : counts;
  const nOuter = model.infinite ? FULL_TOTAL : countTotal(stockOuter);
  const rankFor = (v) => (v === 11 ? 14 : v);
  const { cond, denom } = peekCond(model, upValue, stockOuter, nOuter);

  for (let a = 0; a < G; a++) {
    const ca = stockOuter[a];
    if (!ca) continue;
    const pa = ca / nOuter;
    if (!model.infinite) counts[a]--;

    const stockInner = model.infinite ? FULL_COUNTS : counts;
    const nInner = model.infinite ? FULL_TOTAL : countTotal(stockInner);

    for (let b = 0; b < G; b++) {
      const cb = stockInner[b];
      if (!cb) continue;
      const pb = nInner ? cb / nInner : 1;
      if (!model.infinite) counts[b]--;

      const handA = [rankFor(pairRankValue), rankFor(GROUP_VALUES[a])];
      const handB = [rankFor(pairRankValue), rankFor(GROUP_VALUES[b])];

      let sA;
      let sB;
      if (isAces) {
        // 分 A：只补一张就停手，而且这一手不算天然 21 点（只赔 1 倍）
        const d = dealerOutcome(upValue, counts, model);
        sA = standStats(handTotal(handA).total, false, d);
        sB = standStats(handTotal(handB).total, false, d);
      } else {
        sA = bestTwoCardStats(handA, upValue, counts, model, { allowDouble: true, naturalOk: false }).stats;
        sB = bestTwoCardStats(handB, upValue, counts, model, { allowDouble: true, naturalOk: false }).stats;
      }

      // 分牌要连抽两张（两手各补一张），所以条件化也得两层一起做：
      //   P(a, b | 非天然) = P(a)·P(b|a)·P(非天然 | a,b) / P(非天然)
      // 最后那个系数就是「连这两张都抽走之后，庄家仍然不是黑杰克」的概率。
      const p = cond
        ? (pa * pb * (1 - naturalProb(upValue, counts, model))) / denom
        : pa * pb;
      win += p * (sA.win + sB.win) * 0.5;
      lose += p * (sA.lose + sB.lose) * 0.5;
      push += p * (sA.push + sB.push) * 0.5;
      weight += p;

      if (!model.infinite) counts[b]++;
    }
    if (!model.infinite) counts[a]++;
  }

  if (weight > 0) {
    win /= weight;
    lose /= weight;
    push /= weight;
  }
  return { win, lose, push };
}

// ---------------------------------------------------------------------------
// 对外入口
// ---------------------------------------------------------------------------

/**
 * 算出一手牌现在每个可选动作的精确战绩。
 *
 * @param ranks   这手牌的点数数组（14 代表 A）
 * @param upRank  庄家明牌的点数
 * @param counts  未见牌堆的计数向量。调用方要保证已经扣掉：我看得见的一切牌
 *                （我自己的手牌、庄家明牌、已经亮出来的牌）。
 * @param model   { infinite, peek }
 * @returns {{ stand, hit, double, split, best }}
 *   每项是 { win, lose, push, ev, bet }；ev 是【以原始注为单位的期望净收益】，
 *   所以双倍那一项天然是两倍上下，不会被误读成「双倍和停牌差不多」。
 *   win 是这一手赢钱的概率（平局不算赢），供胜率引擎直接使用。
 *   split 只有在这手牌确实是对子时才返回。
 */
export function evaluateHand({
  ranks, upRank, counts, infinite = false, peek = true, allowDouble = true, allowSplit = true,
} = {}) {
  const model = { infinite: !!infinite, peek: !!peek };
  const upValue = faceValue(upRank);
  const stock = model.infinite ? FULL_COUNTS : counts;
  const t = handTotal(ranks);
  const natural = isNatural(ranks);

  const withEv = (s, bet) => ({ ...s, bet, ev: bet * (s.win - s.lose) });
  const out = {};

  // 停手的赌注倍数：天然 21 点赔 1.5 倍，其余都是 1 倍
  out.stand = withEv(standStats(t.total, natural, dealerOutcome(upValue, stock, model)), natural ? NATURAL_BET : 1);

  if (t.total < 21) {
    out.hit = withEv(hitStats(t.total, t.soft, upValue, stock, model), 1);
    if (allowDouble && ranks.length === 2) {
      out.double = withEv(oneCardStats(t.total, t.soft, upValue, stock, model), 2);
    }
  }

  if (allowSplit && isPair(ranks)) {
    out.split = withEv(splitStats(faceValue(ranks[0]), upValue, stock, model), 2);
  }

  // 最优动作：在【已经算出来的】这些里取期望最高的。
  // 注意双倍和分牌的 bet 是 2，所以这里比的是 ev 而不是 win —— 拿「赢面」
  // 去比会把双倍系统性判低：双倍赢的时候赢两份，赢面却和单注一样。
  let best = null;
  for (const name of ['stand', 'hit', 'double', 'split']) {
    const a = out[name];
    if (!a) continue;
    if (!best || a.ev > best.ev + 1e-12) best = { action: name, ev: a.ev, stats: a };
  }
  out.best = best;
  return out;
}

/** 从「我看得见的牌」推未见牌堆。这是精确计算的输入，也是它的信息边界。 */
export function unseenCounts(visibleRanks) {
  const counts = [...FULL_COUNTS];
  for (const r of visibleRanks) counts[groupOfRank(r)]--;
  return counts;
}

export { FULL_TOTAL, G as GROUP_COUNT, DEALER_STAND, NATURAL_BET };
