/**
 * eval.js — 德州扑克的牌力评估
 *
 * 七选五
 * ------------------------------------------------------------------
 * 摊牌时每人 2 张底牌 + 桌上 5 张公共牌 = 7 张，从中挑最好的 5 张。
 * 这里同时给两条实现：
 *
 *   bestOf7(cards)  —— 权威实现：把 C(7,5)=21 种组合逐个评分取最大。
 *                      慢，但「最好的五张是哪五张」这件事它写不出错来。
 *   score7(cards)   —— 快路径：数点数、数花色，直接定型。
 *                      快，但分支多、边界多（三对取哪两对、A 当 1 的顺子……）。
 *
 * 为什么要两条：只有一条的时候，写错了没人知道 —— 它不报错，只是把
 * 葫芦算成两对，然后整张胜率表安静地偏掉。自检里拿 20 万手随机牌对拍，
 * 两条实现必须逐手给出【同一个比较键】，快路径才算数。
 *
 * 比较键
 * ------------------------------------------------------------------
 * 一手牌表示成一个数组 [牌型, 主牌...]：
 *   [8, 高张]                  同花顺
 *   [7, 四条点数, 踢脚]
 *   [6, 三条点数, 对子点数]     葫芦
 *   [5, r1..r5]                同花（点数从大到小）
 *   [4, 高张]                  顺子
 *   [3, 三条点数, 踢脚1, 踢脚2]
 *   [2, 大对, 小对, 踢脚]
 *   [1, 对子点数, 踢脚1..3]
 *   [0, r1..r5]                高牌
 * 按字典序比大小 —— 这正是「先比牌型、同型比点数」。
 * 数组长度不同不会出问题：长度不同的两手牌，牌型必然不同（每一型都写了
 * 该型完整的踢脚个数）。
 * ------------------------------------------------------------------
 */

/** 牌型等级。数字大者赢 */
export const CAT = {
  HIGH: 0,
  PAIR: 1,
  TWO_PAIR: 2,
  TRIPS: 3,
  STRAIGHT: 4,
  FLUSH: 5,
  FULL_HOUSE: 6,
  QUADS: 7,
  STRAIGHT_FLUSH: 8,
};

export const CAT_NAMES = {
  [CAT.HIGH]: '高牌',
  [CAT.PAIR]: '一对',
  [CAT.TWO_PAIR]: '两对',
  [CAT.TRIPS]: '三条',
  [CAT.STRAIGHT]: '顺子',
  [CAT.FLUSH]: '同花',
  [CAT.FULL_HOUSE]: '葫芦',
  [CAT.QUADS]: '四条',
  [CAT.STRAIGHT_FLUSH]: '同花顺',
};

/** 点数的显示名（10/J/Q/K/A） */
const RANK_LABEL = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A' };
export function rankText(r) {
  return RANK_LABEL[r] || String(r);
}

/**
 * 顺子的最高张。
 * @param ranks 点数数组（可含重复 —— 会先去重）
 * @returns 最高张点数；不成顺子返回 0。
 *          A-2-3-4-5 记作「5 高」（不是 A 高）：A 在这里当 1 用。
 */
export function straightHigh(ranks) {
  const u = [...new Set(ranks)].sort((a, b) => b - a);
  for (let i = 0; i + 4 < u.length; i++) {
    if (u[i] - u[i + 4] === 4) return u[i];
  }
  // 最小顺子 A-5：A 当 1。注意它比 6 高顺小，所以只能排在最后判。
  if (u.includes(14) && u.includes(5) && u.includes(4) && u.includes(3) && u.includes(2)) return 5;
  return 0;
}

/** 两张牌的比较键谁大：a > b 返回正数 */
export function compareKey(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i] === undefined ? -1 : a[i];
    const y = b[i] === undefined ? -1 : b[i];
    if (x !== y) return x - y;
  }
  return 0;
}

/**
 * 权威实现：5 张牌评分。
 * 写得笨，但每一步都直白 —— 它是快路径的对照物。
 */
export function score5(cards) {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const flush = cards.every((c) => c.suit === cards[0].suit);
  const sh = straightHigh(ranks);

  const cnt = new Map();
  for (const r of ranks) cnt.set(r, (cnt.get(r) || 0) + 1);
  const groups = [...cnt.entries()]
    .map(([r, n]) => ({ r, n }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const nz = groups.filter((g) => g.n > 1);

  if (flush && sh) return [CAT.STRAIGHT_FLUSH, sh];
  if (groups[0].n === 4) return [CAT.QUADS, groups[0].r, groups[1].r];
  if (groups[0].n === 3 && groups[1] && groups[1].n >= 2) {
    return [CAT.FULL_HOUSE, groups[0].r, groups[1].r];
  }
  if (flush) return [CAT.FLUSH, ...ranks];
  if (sh) return [CAT.STRAIGHT, sh];
  if (groups[0].n === 3) return [CAT.TRIPS, groups[0].r, groups[1].r, groups[2].r];
  if (nz.length >= 2) {
    // 两对：大对、小对、剩余最大那张
    const others = groups.filter((g) => g.r !== nz[0].r && g.r !== nz[1].r).map((g) => g.r);
    return [CAT.TWO_PAIR, nz[0].r, nz[1].r, Math.max(...others)];
  }
  if (nz.length === 1) {
    const kicks = groups.filter((g) => g.r !== nz[0].r).map((g) => g.r);
    return [CAT.PAIR, nz[0].r, ...kicks];
  }
  return [CAT.HIGH, ...ranks];
}

/** C(7,5) 的 21 种组合（预生成，避免每次重算） */
const COMBOS_7_5 = (() => {
  const out = [];
  for (let a = 0; a < 7; a++) {
    for (let b = a + 1; b < 7; b++) {
      for (let c = b + 1; c < 7; c++) {
        for (let d = c + 1; d < 7; d++) {
          for (let e = d + 1; e < 7; e++) out.push([a, b, c, d, e]);
        }
      }
    }
  }
  return out;
})();

/**
 * 权威实现：7 张（或 5/6 张）里最好的那一手。
 * 少于 5 张时返回 null —— 摊牌前还不够成手，这不是错误，是「还没有牌力」。
 */
export function bestOf7(cards) {
  if (!cards || cards.length < 5) return null;
  let best = null;
  for (const idx of COMBOS_7_5) {
    if (idx[4] >= cards.length) continue;
    const key = score5(idx.map((i) => cards[i]));
    if (!best || compareKey(key, best) > 0) best = key;
  }
  return best;
}

/**
 * 快路径：同样输入、同样输出，但不枚举组合。
 *
 * 顺序不能乱：同花顺 → 四条 → 葫芦 → 同花 → 顺子 → 三条 → 两对 → 一对 → 高牌。
 * 每一档都比它下面所有档都大，所以「先撞到哪一档就返回」是对的。
 */
export function score7(cards) {
  if (!cards || cards.length < 5) return null;

  const cnt = new Map();
  const bySuit = { S: [], H: [], D: [], C: [] };
  for (const c of cards) {
    cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
    if (bySuit[c.suit]) bySuit[c.suit].push(c.rank);
  }

  // 同花：某花色够 5 张。7 张牌里最多只可能有一个花色到 5，
  // 但四个都查一遍更省心（也便宜）。
  let flushSuit = null;
  for (const s of ['S', 'H', 'D', 'C']) {
    if (bySuit[s].length >= 5) flushSuit = s;
  }

  if (flushSuit) {
    const sf = straightHigh(bySuit[flushSuit]);
    if (sf) return [CAT.STRAIGHT_FLUSH, sf];
  }

  const groups = [...cnt.entries()]
    .map(([r, n]) => ({ r, n }))
    .sort((a, b) => b.n - a.n || b.r - a.r);
  const top = groups[0];
  /**
   * 踢脚一律「按点数从大到小」取，不能沿用 groups 的顺序。
   *
   * groups 是按【张数】先排的，所以「9 一对 + K 单张」里那个 9 会排在 K 前面。
   * 拿它当踢脚，[三条 9, 5, K] 会写成 [3,9,5,13]，而正确的顺序是 [3,9,13,5] ——
   * 位置一比就错，而且错得很安静（对拍 20 万手时抓到 27 手，全是这一类）。
   */
  const kickers = (exclude) =>
    groups.filter((g) => !exclude.includes(g.r)).map((g) => g.r).sort((a, b) => b - a);

  if (top.n === 4) {
    // 四条：踢脚是「剩下的牌里最大的那张」—— 剩下的可能是一对，也可能是两张单牌
    return [CAT.QUADS, top.r, kickers([top.r])[0]];
  }

  if (top.n === 3) {
    const pair = groups.find((g) => g.n >= 2 && g.r !== top.r);
    if (pair) return [CAT.FULL_HOUSE, top.r, pair.r];
  }

  if (flushSuit) {
    const ranks = bySuit[flushSuit].slice().sort((a, b) => b - a).slice(0, 5);
    return [CAT.FLUSH, ...ranks];
  }

  const sh = straightHigh([...cnt.keys()]);
  if (sh) return [CAT.STRAIGHT, sh];

  if (top.n === 3) {
    return [CAT.TRIPS, top.r, ...kickers([top.r]).slice(0, 2)];
  }

  if (top.n === 2) {
    const pairs = groups.filter((g) => g.n === 2).map((g) => g.r).sort((a, b) => b - a);
    if (pairs.length >= 2) {
      /**
       * 两对：取最大的两对，踢脚是「剩下所有牌里最大的那张」。
       *
       * 这里有一个容易写错的边界：7 张牌里可能出现【三对】。
       * 三对 + 一张（2+2+2+1）时，第三对的那两张要拆开当踢脚用 ——
       * 只从「单张」里找踢脚会把 5,5,4,4,3,3,2 算成踢脚 2，
       * 而正确的五张是 5,5,4,4,3。
       */
      const [hi, lo] = pairs;
      return [CAT.TWO_PAIR, hi, lo, kickers([hi, lo])[0]];
    }
    return [CAT.PAIR, top.r, ...kickers([top.r]).slice(0, 3)];
  }

  return [CAT.HIGH, ...kickers([]).slice(0, 5)];
}

/** 比较键 → 人话（用于公示、提示词、自检输出） */
export function keyText(key) {
  if (!key) return '还没有成手（不足 5 张）';
  const name = CAT_NAMES[key[0]] || `未知牌型 ${key[0]}`;
  switch (key[0]) {
    case CAT.STRAIGHT_FLUSH:
      return key[1] === 14 ? '皇家同花顺' : `同花顺（${rankText(key[1])} 高）`;
    case CAT.QUADS:
      return `四条 ${rankText(key[1])}`;
    case CAT.FULL_HOUSE:
      return `葫芦（${rankText(key[1])} 带 ${rankText(key[2])}）`;
    case CAT.FLUSH:
      return `同花（${rankText(key[1])} 高）`;
    case CAT.STRAIGHT:
      return `顺子（${rankText(key[1])} 高）`;
    case CAT.TRIPS:
      return `三条 ${rankText(key[1])}`;
    case CAT.TWO_PAIR:
      return `两对（${rankText(key[1])} 与 ${rankText(key[2])}）`;
    case CAT.PAIR:
      return `一对 ${rankText(key[1])}`;
    default:
      return `高牌 ${rankText(key[1])}`;
  }
}

/**
 * 一组牌里最好的五张（拿来说明「你赢在哪五张」）。
 * 只在需要展示时调用 —— 它比 score7 贵得多（要枚举 21 种）。
 */
export function bestFive(cards) {
  if (!cards || cards.length < 5) return { key: null, cards: [] };
  let best = null;
  let pick = null;
  for (const idx of COMBOS_7_5) {
    if (idx[4] >= cards.length) continue;
    const five = idx.map((i) => cards[i]);
    const key = score5(five);
    if (!best || compareKey(key, best) > 0) {
      best = key;
      pick = five;
    }
  }
  return { key: best, cards: pick || [] };
}
