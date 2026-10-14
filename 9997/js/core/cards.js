/**
 * cards.js — 牌模型与四态可见性
 *
 * 四态可见性模型
 * ------------------------------------------------------------------
 * 每张牌的朝向由两个独立的枚举位决定：
 *   reveal.owner  — 这张牌的「持有者」看它是正面还是背面
 *   reveal.public — 「其他所有人」看它是正面还是背面
 *
 * 两个布尔位的四种组合正好对应需求的四种展示方式：
 *   owner=face  public=face  →  所有人都可见
 *   owner=face  public=back  →  仅自己可见
 *   owner=back  public=face  →  仅外人可见
 *   owner=back  public=back  →  所有人都不可见
 *
 * 无主牌（公共区域的牌，ownerId 为 null）只受 public 位控制。
 * ------------------------------------------------------------------
 */

export const FACE = 'face';
export const BACK = 'back';

export const SUITS = [
  { id: 'S', label: '黑桃', glyph: '\u2660', red: false },
  { id: 'H', label: '红桃', glyph: '\u2665', red: true },
  { id: 'D', label: '方块', glyph: '\u2666', red: true },
  { id: 'C', label: '梅花', glyph: '\u2663', red: false },
];

const RANK_LABELS = { 11: 'J', 12: 'Q', 13: 'K', 14: 'A', 15: '小王', 16: '大王' };

export function rankLabel(v) {
  return RANK_LABELS[v] || String(v);
}

/**
 * 花色的固定排布次序（黑桃 → 红桃 → 方块 → 梅花）。
 * 只用在「同点数的牌谁先谁后」这一件事上，纯展示，不影响任何牌力判断。
 * 取的是 SUITS 的声明顺序，避免两处各写一份顺序而慢慢对不上。
 */
export const SUIT_INDEX = Object.fromEntries(SUITS.map((s, i) => [s.id, i]));

export function buildRanks(from, to) {
  const out = [];
  for (let v = from; v <= to; v++) out.push({ v, label: rankLabel(v) });
  return out;
}

/** 标准 52 张：2..A，四花色 */
export const STANDARD_RANKS = buildRanks(2, 14);

/**
 * 生成一副牌。
 * opts.jokers   大小王张数（斗地主传 2）
 * opts.jokerBase 王的起始点数。默认 15，正好接在 A(14) 后面；
 *                斗地主把「2」提到 A 之上占掉 15，所以王要从 16 起，
 *                否则 2 和 小王 会撞成同一个点数。
 */
export function makeDeck(opts = {}) {
  const { suits = SUITS, ranks = STANDARD_RANKS, jokers = 0, copies = 1, jokerBase = 15 } = opts;
  const cards = [];
  let n = 0;
  for (let c = 0; c < copies; c++) {
    for (const s of suits) {
      for (const r of ranks) {
        cards.push({
          id: `c${n++}`,
          suit: s.id,
          glyph: s.glyph,
          rank: r.v,
          label: r.label,
          red: s.red,
        });
      }
    }
  }
  for (let i = 0; i < jokers; i++) {
    cards.push({
      id: `c${n++}`,
      suit: 'J',
      glyph: '',
      rank: jokerBase + i,
      label: i === 0 ? '小王' : '大王',
      red: i === 1,
    });
  }
  return cards;
}

/** 把牌数组转成 state.cards 需要的索引表 */
export function indexCards(cards) {
  const map = {};
  for (const c of cards) {
    map[c.id] = {
      ...c,
      ownerId: null,
      zone: 'deck',
      reveal: { owner: BACK, public: BACK },
    };
  }
  return map;
}

/**
 * 把一副洗好的牌重新编号，让 id 既不透露牌面、也不会撞车。
 *
 * 为什么需要这个（两条，都是真踩过的）
 * ------------------------------------------------------------------
 * 1. id 会透露牌面。makeDeck 给的是 c0、c1、c2……按「花色在外、点数在内」
 *    排出来，于是 c37 一算就知道是方块 K。而投影层对【背面牌】是保留 id 的
 *    （渲染层要靠它把「哪张牌占哪一格」对上），所以只要有人把投影里的 id
 *    当索引用一次，整条「背面牌没有牌面字段」的保证就漏了。
 *    牌面读不出来才算真的隔离 —— 这一步把它做成结构上的事实。
 *
 * 2. 21 点会重洗。重洗之后是一副新的 52 张，而旧牌堆里没打完的牌
 *    还躺在别人手上或桌面上。若两副牌共用同一批 id，新牌会在
 *    state.cards 里【覆盖】旧牌 —— ownerId / zone / 朝向一起被重置成
 *    「还没发过的牌」，桌上的牌会凭空消失或变回背面，而且不报错。
 *    所以编号要带上 salt（21 点传牌堆序号）。
 *
 * 同一 (seed, salt) 必得同一批 id，所以复现不受影响：牌局照样由种子决定。
 */
export function opaqueDeck(cards, seed = 0, salt = 0) {
  const seen = new Set();
  const out = [];
  // 前缀是「第几副牌」这一条公开事实（重洗本来就全桌都知道），后面接一段
  // 由种子散列出来的乱码。中间那个连字符不是装饰：少了它，s1 会同时匹配
  // s10、s11…… 于是第 10 副牌的牌会被算进第 1 副的计数里。
  const tag = `s${salt | 0}-`;
  let n = 0;
  for (const c of cards) {
    let h = (seed >>> 0) ^ Math.imul((salt | 0) + 1, 0x9e3779b1);
    h = (h ^ Math.imul(n + 1, 0x85ebca6b)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
    h = (h ^ (h >>> 16)) >>> 0;
    let id = `${tag}${h.toString(36)}`;
    // 理论上可能撞（32 位空间里放 52 个），撞了就往下挪一格 ——
    // 便宜且可复现，比「反正不会撞」的假设可靠。
    while (seen.has(id)) {
      h = (h + 1) >>> 0;
      id = `${tag}${h.toString(36)}`;
    }
    seen.add(id);
    out.push({ ...c, id });
    n++;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 四态可见性
// ---------------------------------------------------------------------------

export const VIS = {
  ALL: 'all',
  SELF: 'self',
  OTHERS: 'others',
  NONE: 'none',
};

export const VIS_META = {
  [VIS.ALL]: { label: '所有人都可见', short: '全明', hint: '自己和外人都看得到正面' },
  [VIS.SELF]: { label: '仅自己可见', short: '私明', hint: '自己看正面，外人看背面' },
  [VIS.OTHERS]: { label: '仅外人可见', short: '反暗', hint: '外人看正面，自己反而看不到' },
  [VIS.NONE]: { label: '所有人都不可见', short: '全暗', hint: '双方都只能看到背面' },
};

export const VIS_ORDER = [VIS.ALL, VIS.SELF, VIS.OTHERS, VIS.NONE];

/** 由两个朝向位反推属于哪一种展示方式 */
export function visibilityOf(card) {
  const s = card.reveal.owner === FACE;
  const o = card.reveal.public === FACE;
  if (s && o) return VIS.ALL;
  if (s && !o) return VIS.SELF;
  if (!s && o) return VIS.OTHERS;
  return VIS.NONE;
}

/** 按展示方式生成朝向位 */
export function revealFor(mode) {
  switch (mode) {
    case VIS.ALL:
      return { owner: FACE, public: FACE };
    case VIS.SELF:
      return { owner: FACE, public: BACK };
    case VIS.OTHERS:
      return { owner: BACK, public: FACE };
    case VIS.NONE:
    default:
      return { owner: BACK, public: BACK };
  }
}

/** 从一个展示方式切到下一个（右键翻牌循环用） */
export function nextVisibility(mode) {
  const i = VIS_ORDER.indexOf(mode);
  return VIS_ORDER[(i + 1) % VIS_ORDER.length];
}

/**
 * 某个观察者实际看到这张牌的哪一面。
 * 这是判断信息隔离的唯一依据。
 */
export function faceTo(card, viewerId) {
  if (card.ownerId === null || card.ownerId === undefined) return card.reveal.public;
  return card.ownerId === viewerId ? card.reveal.owner : card.reveal.public;
}
