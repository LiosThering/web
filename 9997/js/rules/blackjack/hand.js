/**
 * hand.js — 21 点的手牌模型
 *
 * 这一层只做一件事：把「一串牌」翻译成「这手牌现在是多少点、软不软」。
 * 它是纯函数，不认识牌局、不认识牌堆，所以可以被精确引擎反复调用而不出错。
 *
 * 关于「软」与「硬」
 * ------------------------------------------------------------------
 * A 可以当 11 也可以当 1。一手牌同时存在两种读法的时候，规则规定
 * 取【不超过 21 的最大值】。当那个最大值里有一张 A 正按 11 算，就叫「软」。
 *
 *   A + 6      → 17（软）     A 当 11
 *   A + 6 + 10 → 17（硬）     A 只能当 1（11+16 爆了）
 *   A + A      → 12（软）     一张当 11、一张当 1
 *
 * 为什么必须区分软硬：软 17 再要一张【永远不会爆】（最差是 A 降成 1 变成硬 17），
 * 所以「软 18 该不该要牌」和「硬 18 该不该要牌」是两个完全不同的问题。
 * 把软硬合并成一个数字的实现在这里会直接算错策略。
 * ------------------------------------------------------------------
 */

/** A 的点数下标 */
export const ACE_RANK = 14;

/**
 * 把牌面点数翻成 21 点里的面值。
 * 21 点只有三种点数：2-10 按面值、J/Q/K 都算 10、A 算 11（可降为 1）。
 */
export function faceValue(rank) {
  if (rank === ACE_RANK) return 11;
  return Math.min(rank, 10);
}

/**
 * 手牌点数。
 *
 * @param ranks 点数数组（14 代表 A）
 * @returns {{ total:number, soft:boolean, cards:number }}
 *   total 取「不超过 21 的最大值」；全都超了就给最小值（此时 total > 21，即爆牌）
 *   soft 表示这个最大值里有一张 A 正按 11 算
 *
 * 实现思路：先把所有 A 都当 1 加起来，再一张一张地把 A 升回 11 ——
 * 能升几张升几张。这样不用分支枚举，也不会漏掉「两张 A 只升一张」这种情形。
 */
export function handTotal(ranks) {
  let base = 0;
  let aces = 0;
  for (const r of ranks) {
    if (r === ACE_RANK) {
      aces++;
      base += 1;
    } else {
      base += faceValue(r);
    }
  }
  const canPromote = Math.min(aces, Math.max(0, Math.floor((21 - base) / 10)));
  return { total: base + 10 * canPromote, soft: canPromote > 0, cards: ranks.length };
}

/** 从手牌点数继续补一张之后的点数。value 是 faceValue 的结果。 */
export function addCard(total, soft, value) {
  if (value === 11) {
    // 补到 A：软手直接 +1（原来那张 A 继续当 11）；
    // 硬手能升就升成软手，不能升就还是当 1。
    if (soft) return { total: total + 1, soft: true };
    if (total + 11 <= 21) return { total: total + 11, soft: true };
    return { total: total + 1, soft: false };
  }
  let t = total + value;
  let s = soft;
  // 软手被顶爆的时候，让那张 A 降成 1 —— 常常能救回来
  if (t > 21 && s) {
    t -= 10;
    s = false;
  }
  return { total: t, soft: s };
}

export function isBust(total) {
  return total > 21;
}

/**
 * 天然 21 点（黑杰克）：起手两张就是 21 点。
 *
 * 注意它和「补出来的 21 点」赔率不同（1.5 倍 vs 1 倍），
 * 而且它不吃庄家的 21 点以外的牌型 —— 这些差别全部要在结算里体现，
 * 所以本函数只判断形态，不判断输赢。
 */
export function isNatural(ranks) {
  return ranks.length === 2 && handTotal(ranks).total === 21;
}

/**
 * 能不能分牌。
 *
 * 规则：两张牌面值相同（J/Q/K 互相也算同值），并且还没分过。
 * A 对可以分，但分完之后每边只补一张、不能再要 —— 这条由规则包执行，
 * 这里只回答「这两张牌长得一样吗」。
 */
export function isPair(ranks) {
  if (ranks.length !== 2) return false;
  return faceValue(ranks[0]) === faceValue(ranks[1]);
}

/** 分牌之后这一对是什么（用于策略表的下标：A 对、8 对……） */
export function pairValue(ranks) {
  if (!isPair(ranks)) return null;
  return faceValue(ranks[0]);
}

/** 这手牌还能不能继续做动作（爆了或满 21 就只能停） */
export function canAct(total) {
  return total <= 21;
}

// ---------------------------------------------------------------------------
// 牌堆的分组表示
// ---------------------------------------------------------------------------

/**
 * 21 点里只有「面值」有意义：♠7 和 ♦7 完全等价。
 * 所以整副牌可以压成 10 个组：2,3,4,5,6,7,8,9,10,A。
 *
 * 这个压缩是精确计算能跑得动的前提 —— 52 张牌的组合数按张算是个天文数字，
 * 按 10 个组算只有几千种。而且它不是近似：等价类里的牌确实完全可互换。
 */
export const GROUP_VALUES = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** 一副 52 张牌在这 10 个组里的张数：2-9 各 4 张、10 有 16 张、A 有 4 张 */
export const FULL_COUNTS = [4, 4, 4, 4, 4, 4, 4, 4, 16, 4];

/** 牌面点数 → 组下标 */
export function groupOfRank(rank) {
  return rank === ACE_RANK ? 9 : Math.min(rank, 10) - 2;
}

/** 一组牌（点数数组）→ 计数向量 */
export function countsOfRanks(ranks) {
  const counts = new Array(GROUP_VALUES.length).fill(0);
  for (const r of ranks) counts[groupOfRank(r)]++;
  return counts;
}

/** 计数向量的总张数 */
export function countTotal(counts) {
  let n = 0;
  for (const c of counts) n += c;
  return n;
}
