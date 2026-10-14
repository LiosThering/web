/**
 * combo.js — 斗地主牌型识别与比较
 *
 * 这一层只做一件事：把「一堆牌」翻译成「一个牌型」，并回答
 * 「A 能不能压过 B」。它不碰状态机，也不碰任何事件，纯函数，
 * 因此可以脱离整个项目单独验证。
 *
 * 点数排序（斗地主特有，与扑克直觉不同）
 * ------------------------------------------------------------------
 *   3 < 4 < … < 10 < J < Q < K < A < 2 < 小王 < 大王
 * 编码成整数：3..14 是 3..A，15 是 2，16 是小王，17 是大王。
 * 顺子/连对/飞机一律【不许带 2 和王】，所以它们只允许在 3..14 之间
 * 连续 —— 这一条由 MAX_CHAIN_RANK 统一兜住。
 */

export const COMBO = {
  SINGLE: 'single',
  PAIR: 'pair',
  TRIPLE: 'triple',
  TRIPLE_ONE: 'triple_one',
  TRIPLE_PAIR: 'triple_pair',
  STRAIGHT: 'straight',
  STRAIGHT_PAIR: 'straight_pair',
  PLANE: 'plane',
  PLANE_SINGLE: 'plane_single',
  PLANE_PAIR: 'plane_pair',
  FOUR_TWO: 'four_two',
  FOUR_TWO_PAIR: 'four_two_pair',
  BOMB: 'bomb',
  ROCKET: 'rocket',
};

export const COMBO_LABEL = {
  [COMBO.SINGLE]: '单张',
  [COMBO.PAIR]: '对子',
  [COMBO.TRIPLE]: '三张',
  [COMBO.TRIPLE_ONE]: '三带一',
  [COMBO.TRIPLE_PAIR]: '三带二',
  [COMBO.STRAIGHT]: '顺子',
  [COMBO.STRAIGHT_PAIR]: '连对',
  [COMBO.PLANE]: '飞机',
  [COMBO.PLANE_SINGLE]: '飞机带单',
  [COMBO.PLANE_PAIR]: '飞机带对',
  [COMBO.FOUR_TWO]: '四带二',
  [COMBO.FOUR_TWO_PAIR]: '四带两对',
  [COMBO.BOMB]: '炸弹',
  [COMBO.ROCKET]: '王炸',
};

export const RANK = { TWO: 15, JOKER_SMALL: 16, JOKER_BIG: 17 };
/** 顺子/连对/飞机的上限：A。2 与王不参与连续牌型 */
export const MAX_CHAIN_RANK = 14;

const RANK_NAME = {
  11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '2', 16: '小王', 17: '大王',
};

export function rankName(v) {
  return RANK_NAME[v] || String(v);
}

/** 斗地主用的一副牌（54 张）的点数表 */
export function ddzRanks() {
  const out = [];
  for (let v = 3; v <= 15; v++) out.push({ v, label: rankName(v) });
  return out;
}

/** 斗地主里 2 和小王/大王是不参与连续牌型的，判断一个点能否进顺子 */
export function isChainable(rank) {
  return rank >= 3 && rank <= MAX_CHAIN_RANK;
}

// ---------------------------------------------------------------------------
// 统计与基础判断
// ---------------------------------------------------------------------------

/** 按点数分组，返回 [{rank, n}]，按点数升序 */
export function groupByRank(cards) {
  const m = new Map();
  for (const c of cards || []) {
    if (!c) continue;
    m.set(c.rank, (m.get(c.rank) || 0) + 1);
  }
  return [...m.entries()]
    .map(([rank, n]) => ({ rank, n }))
    .sort((a, b) => a.rank - b.rank);
}

function isRun(ranks) {
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// 牌型识别
// ---------------------------------------------------------------------------

/**
 * 识别一手牌。
 * @returns {{ok:boolean, combo?:object, reason?:string}}
 *   combo = { type, rank, size, ranks, groups, label }
 *   rank 是这手牌的「主点数」，比较大小只看它
 */
export function parseCombo(cards) {
  const list = (cards || []).filter(Boolean);
  const n = list.length;
  if (!n) return { ok: false, reason: '没有选任何牌' };

  const ids = new Set(list.map((c) => c.id));
  if (ids.size !== n) return { ok: false, reason: '同一张牌被重复选择了' };

  const g = groupByRank(list);
  const mk = (type, rank) => ({
    ok: true,
    combo: {
      type,
      rank,
      size: n,
      ranks: g.map((x) => x.rank),
      groups: g,
      label: comboLabel(type, rank, n),
    },
  });

  // 王炸 / 单张 / 对子 / 三张 / 炸弹
  if (n === 2 && g.length === 2 && g[0].rank === RANK.JOKER_SMALL && g[1].rank === RANK.JOKER_BIG) {
    return mk(COMBO.ROCKET, RANK.JOKER_BIG);
  }
  if (n === 1) return mk(COMBO.SINGLE, g[0].rank);
  if (n === 2 && g.length === 1) return mk(COMBO.PAIR, g[0].rank);
  if (n === 3 && g.length === 1) return mk(COMBO.TRIPLE, g[0].rank);
  if (n === 4 && g.length === 1) return mk(COMBO.BOMB, g[0].rank);

  // 三带一 / 三带二
  if (n === 4 && g.length === 2) {
    const t = g.find((x) => x.n === 3);
    const o = g.find((x) => x.n === 1);
    if (t && o) return mk(COMBO.TRIPLE_ONE, t.rank);
  }
  if (n === 5 && g.length === 2) {
    const t = g.find((x) => x.n === 3);
    const p = g.find((x) => x.n === 2);
    if (t && p) return mk(COMBO.TRIPLE_PAIR, t.rank);
  }

  // 顺子：≥5 张单牌连续
  if (n >= 5 && g.every((x) => x.n === 1)) {
    const ranks = g.map((x) => x.rank);
    if (isRun(ranks) && ranks[ranks.length - 1] <= MAX_CHAIN_RANK) {
      return mk(COMBO.STRAIGHT, ranks[ranks.length - 1]);
    }
  }

  // 连对：≥3 对连续
  if (n >= 6 && n % 2 === 0 && g.every((x) => x.n === 2)) {
    const ranks = g.map((x) => x.rank);
    if (isRun(ranks) && ranks[ranks.length - 1] <= MAX_CHAIN_RANK) {
      return mk(COMBO.STRAIGHT_PAIR, ranks[ranks.length - 1]);
    }
  }

  // 纯飞机：≥2 个连续三张
  if (n >= 6 && n % 3 === 0 && g.every((x) => x.n === 3)) {
    const ranks = g.map((x) => x.rank);
    if (isRun(ranks) && ranks[ranks.length - 1] <= MAX_CHAIN_RANK) {
      return mk(COMBO.PLANE, ranks[ranks.length - 1]);
    }
  }

  // 飞机带翅膀：在「三张及以上」的点数里找连续段，再验翅膀
  const tripleRanks = g.filter((x) => x.n >= 3).map((x) => x.rank);
  for (let k = tripleRanks.length; k >= 2; k--) {
    for (let s = 0; s + k <= tripleRanks.length; s++) {
      const run = tripleRanks.slice(s, s + k);
      if (!isRun(run) || run[run.length - 1] > MAX_CHAIN_RANK) continue;

      const rest = g.map((x) => ({ ...x }));
      for (const r of run) {
        const item = rest.find((x) => x.rank === r);
        item.n -= 3;
      }
      const left = rest.filter((x) => x.n > 0);
      const leftCount = left.reduce((a, b) => a + b.n, 0);
      const top = run[run.length - 1];

      // n 个三张 + n 张散牌
      if (leftCount === k && left.every((x) => x.n === 1)) return mk(COMBO.PLANE_SINGLE, top);
      // n 个三张 + n 个对子
      if (leftCount === k * 2 && left.every((x) => x.n === 2)) return mk(COMBO.PLANE_PAIR, top);
    }
  }

  // 四带二 / 四带两对
  const four = g.find((x) => x.n === 4);
  if (four) {
    const others = g.filter((x) => x.rank !== four.rank);
    const otherCount = others.reduce((a, b) => a + b.n, 0);
    if (n === 6 && otherCount === 2) return mk(COMBO.FOUR_TWO, four.rank);
    if (n === 8 && others.length === 2 && others.every((x) => x.n === 2)) {
      return mk(COMBO.FOUR_TWO_PAIR, four.rank);
    }
  }

  return { ok: false, reason: '这组牌不构成任何合法牌型' };
}

export function comboLabel(type, rank, size) {
  const base = COMBO_LABEL[type] || type;
  switch (type) {
    case COMBO.SINGLE:
    case COMBO.PAIR:
    case COMBO.TRIPLE:
    case COMBO.BOMB:
      return `${base} ${rankName(rank)}`;
    case COMBO.TRIPLE_ONE:
    case COMBO.TRIPLE_PAIR:
    case COMBO.PLANE:
    case COMBO.PLANE_SINGLE:
    case COMBO.PLANE_PAIR:
    case COMBO.FOUR_TWO:
    case COMBO.FOUR_TWO_PAIR:
      return `${base}（主牌 ${rankName(rank)}，共 ${size} 张）`;
    case COMBO.STRAIGHT:
    case COMBO.STRAIGHT_PAIR:
      return `${base}（到 ${rankName(rank)}，共 ${size} 张）`;
    default:
      return base;
  }
}

export function isBomb(combo) {
  return !!combo && (combo.type === COMBO.BOMB || combo.type === COMBO.ROCKET);
}

// ---------------------------------------------------------------------------
// 大小比较
// ---------------------------------------------------------------------------

/**
 * a 能不能压过 b（b 为 null 表示 a 是这一手的第一家，随便出）。
 * 规则：同型同张数比主点数；炸弹压一切非炸弹；王炸压一切。
 */
export function beats(a, b) {
  if (!a) return false;
  if (!b) return true;

  if (a.type === COMBO.ROCKET) return b.type !== COMBO.ROCKET;
  if (b.type === COMBO.ROCKET) return false;

  if (a.type === COMBO.BOMB && b.type === COMBO.BOMB) return a.rank > b.rank;
  if (a.type === COMBO.BOMB) return true;
  if (b.type === COMBO.BOMB) return false;

  if (a.type !== b.type) return false;
  if (a.size !== b.size) return false;
  return a.rank > b.rank;
}

/** 给 LLM 读的一句话解释，说明为什么压不过 */
export function compareReason(a, b) {
  if (!b) return '这是一手新牌，任何合法牌型都可以出。';
  if (!a) return '没有出牌。';
  if (beats(a, b)) return '可以压过。';
  if (a.type === COMBO.ROCKET) return '王炸对王炸，不能压。';
  if (b.type === COMBO.ROCKET) return '王炸是最大的，压不过。';
  if (a.type === COMBO.BOMB || b.type === COMBO.BOMB) {
    return a.type === COMBO.BOMB
      ? `炸弹对炸弹，你的 ${rankName(a.rank)} 小于对方的 ${rankName(b.rank)}。`
      : `对方是炸弹，你出的${COMBO_LABEL[a.type]}不是炸弹，压不过。`;
  }
  if (a.type !== b.type) {
    return `牌型不同：对方出的是${COMBO_LABEL[b.type]}，你必须出同样牌型。`;
  }
  if (a.size !== b.size) {
    return `张数不同：对方 ${b.size} 张，你出了 ${a.size} 张。`;
  }
  return `同型同张数，你的主牌 ${rankName(a.rank)} 小于对方的 ${rankName(b.rank)}。`;
}
