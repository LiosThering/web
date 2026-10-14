/**
 * policy.js — 德州扑克的打法策略（规则包与胜率引擎共用同一份）
 *
 * 为什么要共用
 * ------------------------------------------------------------------
 * 这个策略有两个用处：
 *   · 没有 API Key 时的【本地兜底】（规则包的 heuristic）；
 *   · 胜率引擎里【对手会怎么打】的那套模型（评估官的 policyFor）。
 * 两处各写一份的话，会出现「引擎假设对手很紧，而兜底自己打得很松」——
 * 于是界面上那个胜率数字和实际打法对不上，而且谁也发现不了：
 * 两处都不报错，只是数字悄悄偏了。所以只有这一份。
 *
 * 它只能看【自己看得见的东西】：自己的两张底牌 + 桌上的公共牌 + 公开的
 * 下注额度。看不到别人的底牌，也不去读原始 state（那条通道叫投影）。
 *
 * 强度是「对着随机牌大概能赢多少」的粗估，不是精确胜率 ——
 * 精确胜率由引擎模拟出来。这里只要够用：决定「跟不跟」「加不加」。
 * ------------------------------------------------------------------
 */

import { score7, CAT } from './eval.js';

/** 牌型等级 → 强度基准 */
const CAT_STRENGTH = {
  [CAT.HIGH]: 0.16,
  [CAT.PAIR]: 0.40,
  [CAT.TWO_PAIR]: 0.58,
  [CAT.TRIPS]: 0.71,
  [CAT.STRAIGHT]: 0.80,
  [CAT.FLUSH]: 0.86,
  [CAT.FULL_HOUSE]: 0.92,
  [CAT.QUADS]: 0.97,
  [CAT.STRAIGHT_FLUSH]: 1.0,
};

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/**
 * 这一手牌大概有多强（0~1）。
 * @param hole  自己的两张底牌（对象数组，{rank, suit}）
 * @param board 公共牌（0~5 张）
 */
export function handStrength(hole, board = []) {
  const h = (hole || []).filter(Boolean);
  if (h.length < 2) return 0;

  // ---- 翻牌前：只看两张底牌 ----
  if (!board || board.length < 3) {
    const [a, b] = h.slice().sort((x, y) => y.rank - x.rank);
    if (a.rank === b.rank) {
      // 对子：22 约 0.50，AA 约 0.67（对着随机牌的胜率）
      return clamp(0.50 + (a.rank - 2) * 0.014, 0.45, 0.80);
    }
    let s = 0.28 + (a.rank - 2) * 0.016 + (b.rank - 2) * 0.008;
    if (a.suit === b.suit) s += 0.04;          // 同花
    if (a.rank - b.rank === 1) s += 0.02;      // 连张
    else if (a.rank - b.rank <= 3) s += 0.01;  // 近张
    return clamp(s, 0.14, 0.80);
  }

  // ---- 翻牌后：按成手牌型 + 主牌大小 ----
  const key = score7([...h, ...board]);
  if (!key) return 0;
  const base = CAT_STRENGTH[key[0]] ?? 0.2;
  const adj = ((key[1] || 2) - 2) / 12 * 0.06;
  return clamp(base + adj, 0.05, 1);
}

/**
 * 拿到一手牌该怎么走。
 *
 * 判据是【底池赔率】：跟注需要的胜率 = 要跟的钱 / (跟完之后的底池)。
 * 手里这手牌的强度超过它一截就跟，超过很多就加注。
 *
 * @param strength  handStrength 的结果
 * @param toCall    要跟多少（0 表示没人下注，可以看牌）
 * @param pot       当前底池
 * @param canRaise  这一次能不能加注（短筹码全下之后的加注权会被关掉）
 * @param raiseTo   加注的落点（总投入额），由调用方按底池大小算好
 */
export function chooseAction({ strength, toCall, pot, canRaise, raiseTo }) {
  if (toCall <= 0) {
    if (canRaise && strength >= 0.74) return { type: 'raise', amount: raiseTo };
    return { type: 'check' };
  }
  if (canRaise && strength >= 0.80) return { type: 'raise', amount: raiseTo };
  const need = toCall / (pot + toCall);
  if (strength >= need + 0.08) return { type: 'call' };
  return { type: 'fold' };
}
