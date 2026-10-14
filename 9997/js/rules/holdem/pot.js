/**
 * pot.js — 底池分层与结算（含边池）
 *
 * 问题
 * ------------------------------------------------------------------
 * 有人全下、且他的筹码比别人少时，底池要分成几层：
 *   主池  —— 所有人都能争（但只到最少那个人的投入额）
 *   边池  —— 只有投入够多的人能争
 * 分错了不会报错，只会让某个人的钱凭空多出来或少掉，所以值得单独写、单独考。
 *
 * 做法：不看「谁全下了」这种叙述，只看每个人的【总投入】。
 * 把所有人的总投入额去重、从小到大排成阶梯，每一层切一片：
 *   这一片 = Σ 每人在这层区间里投进去的钱
 *   谁有资格 = 没弃牌 且 总投入 >= 这一层的额度
 * 这个定义天然处理了弃牌的人：他的钱留在池里，但他没资格拿回来。
 *
 * 「没人跟」的那部分注额必须单独退回去（这是最容易漏的一笔）
 * ------------------------------------------------------------------
 * 先定一个上限 cap = 【还没弃牌的人里最高的那份投入】。
 *   · 额度在 cap 以内的层 —— 逐层切成主池与边池，有资格者按牌力分；
 *   · 额度超过 cap 的那些钱 —— 谁也跟不了它，不属于任何底池，【原样退回】出钱的人。
 *
 * 为什么非要写这一段：不写的话，这笔钱会变成「有钱、但没有任何人有资格拿」，
 * 从结算里凭空消失 —— 而「每人净赢亏之和恒为 0」是结算唯一那条硬约束。
 * 上一版就是这么写的（那部分被算成「只有他自己够格的顶层」，看起来像是
 * 自动退回了，其实只覆盖了「出钱的人还在局中」这一半情形；一旦出钱的人
 * 已经弃牌，钱就没了）。用 20000 局随机投入额对拍时抓到 4005 局对不上，
 * 才把这条钉出来。退回之后，那批随机局全部成立。
 *
 * 注：本项目里筹码是整数，所以平分时不会出现小数；余数按座位顺序发掉。
 * ------------------------------------------------------------------
 */

import { compareKey } from './eval.js';

/**
 * 把总投入切成若干层底池，并把「没人跟的钱」单独拎出来。
 *
 * @param contrib     { pid: 本手总投入 }
 * @param contenders  还没弃牌的人的 id（弃牌的人出钱但没资格拿）
 * @returns { pots: [{ amount, eligible, level }], uncalled: { pid: 该退给他的金额 } }
 *          pots 里每一层都保证【至少有一个够格的人】—— 够格者为零的那部分
 *          不会进 pots，而是进 uncalled，所以「池子总额 + 退回总额 = 总投入」。
 */
export function buildPots(contrib, contenders) {
  const inHand = (contenders || []).filter(Boolean);
  const all = Object.entries(contrib || {});

  // 上限：还没弃牌的人里最高的那份投入。超过它的钱谁也跟不了。
  const cap = inHand.length
    ? Math.max(...inHand.map((pid) => (contrib || {})[pid] || 0))
    : 0;

  const levels = [...new Set(all.map(([, v]) => v).filter((v) => v > 0 && v <= cap))]
    .sort((a, b) => a - b);

  const pots = [];
  let prev = 0;
  for (const level of levels) {
    let amount = 0;
    const eligible = [];
    for (const [pid, v] of all) {
      amount += Math.max(0, Math.min(v, level) - prev);
      if (v >= level && inHand.includes(pid)) eligible.push(pid);
    }
    if (amount > 0) pots.push({ amount, eligible, level });
    prev = level;
  }

  const uncalled = {};
  for (const [pid, v] of all) {
    if (v > cap) uncalled[pid] = (uncalled[pid] || 0) + (v - cap);
  }
  return { pots, uncalled };
}

/** 退回总额（给断言用：池子总额 + 这个数 必须等于总投入） */
export function uncalledTotal(uncalled) {
  return Object.values(uncalled || {}).reduce((a, b) => a + b, 0);
}

/**
 * 逐层发池。
 * @param pots   buildPots 的 pots
 * @param keys   { pid: 比较键 }
 * @param order  座位顺序 —— 平分时余数按这个顺序发（真实牌桌上是按钮左手第一人先拿）
 * @returns { [pid]: 总共拿回多少 }
 */
export function settlePots(pots, keys, order = []) {
  const paid = {};
  for (const pot of pots) {
    const live = (pot.eligible || []).filter((pid) => keys && keys[pid]);
    if (!live.length) continue;

    let best = live[0];
    for (const pid of live) {
      if (compareKey(keys[pid], keys[best]) > 0) best = pid;
    }
    const winners = live.filter((pid) => compareKey(keys[pid], keys[best]) === 0);

    // 平分。整数筹码除不尽时，余数一枚一枚地按 order 发下去 ——
    // 多出来的那一枚必须落在某个确定的人身上，否则「同种子可复现」就断了。
    const base = Math.floor(pot.amount / winners.length);
    let rest = pot.amount - base * winners.length;
    const seq = order.filter((pid) => winners.includes(pid));
    for (const pid of winners) if (!seq.includes(pid)) seq.push(pid);
    for (const pid of seq) {
      paid[pid] = (paid[pid] || 0) + base + (rest > 0 ? 1 : 0);
      if (rest > 0) rest--;
    }
  }
  return paid;
}

/**
 * 一手牌的战果：谁赢了多少池、净赢多少。
 *
 * @param contrib      { pid: 本手总投入 }
 * @param contenders   还没弃牌的人
 * @param keys         { pid: 比较键 }；只有一个 contender 时可以给 null（不摊牌）
 * @param order        座位顺序
 * @returns { payouts, deltas, uncalled, pots }
 *          deltas 之和恒为 0 —— 这是结算的第一条硬约束（钱只换手，不生不灭）。
 */
export function settleHand(contrib, contenders, keys, order) {
  const { pots, uncalled } = buildPots(contrib, contenders);
  const live = (contenders || []).filter(Boolean);

  /**
   * 要摊牌（多于一个 contender）时，每个够格的人都必须有一手能比的牌。
   *
   * 缺了会怎样：settlePots 会把没有比较键的人从这一层里筛掉，于是那一层
   * 少一个人分 —— 如果一层里【都缺】，整层被跳过，钱就那么没了：
   * deltas 之和不再是 0，而「deltas 之和为 0」正是结算唯一那条硬约束。
   * 这种错不会抛异常，只会让某个人少拿一注，所以宁可在这里把它喊出来。
   * （只剩一个人时不走这条路：不摊牌，底池全归他。）
   */
  if (live.length > 1) {
    const missing = live.filter((pid) => !keys || !keys[pid]);
    if (missing.length) {
      throw new Error(`结算缺手牌：${missing.join('、')} 仍在局中却没有比较键，这一注的钱会凭空少掉`);
    }
  }

  const payouts = keys && live.length > 1
    ? settlePots(pots, keys, order)
    : (() => {
      // 只剩一个人：不用摊牌，底池全归他（含他自己投进去的那部分）
      const only = {};
      if (live.length === 1) only[live[0]] = pots.reduce((n, p) => n + p.amount, 0);
      return only;
    })();

  // 没人跟得上的钱，原样退回出钱的人 —— 与输赢无关，弃牌也一样退
  for (const [pid, amt] of Object.entries(uncalled)) {
    payouts[pid] = (payouts[pid] || 0) + amt;
  }

  const deltas = {};
  for (const pid of Object.keys(contrib || {})) {
    deltas[pid] = (payouts[pid] || 0) - (contrib[pid] || 0);
  }
  return { payouts, deltas, uncalled, pots };
}
