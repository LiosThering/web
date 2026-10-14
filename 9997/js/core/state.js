/**
 * state.js — 不可变牌局状态 + 事件流日志
 *
 * 设计原则
 * ------------------------------------------------------------------
 * 1. 状态只能通过 applyEvent 变更，事件流是唯一的事实来源。
 * 2. 每个事件带 audience 字段，决定它对谁可见：
 *      'public'      所有人都能看到
 *      ['p1','p2']   仅列出的观察者能看到
 *    于是「聊天记录」和「出牌记录」天然统一在一条事件流里，
 *    并且可以被视角投影层直接过滤，不需要维护两套历史。
 * 3. 状态不可变，applyEvent 返回新对象，便于回放与撤销。
 * ------------------------------------------------------------------
 */

import { BACK, FACE, VIS, indexCards, revealFor } from './cards.js';

/**
 * 已销毁的牌所处的牌区。
 *
 * 销毁（destroy）与「换个位置」的全部分歧就在这个 zone：
 *   · play / discard / showdown 只是把牌挪到别处，牌【还在牌局里】；
 *   · destroy 是把它从牌局里【拿掉】——不在任何人手上、不在桌面、
 *     不可数、不可抢、不可被规则再次引用。
 *
 * 但 state.cards 里仍然留着它的记录。这不是「删一半」，而是刻意的：
 * 投影层是唯一的事实出口，只要它不再投影这张牌，牌局里就没有它。
 * 留记录的收益有两个，且都很难事后补：
 *   1. 纸牌守恒仍可断言 —— 「在场的 + 已销毁的 = 全副」，
 *      否则整副牌凭空少几张，守恒类自检只能被迫放宽成「允许少牌」；
 *   2. 回放可复现 —— 事件流里那条 destroy 指向的 id 仍然解得开。
 */
export const VOID_ZONE = 'void';

/** 创建一局初始状态 */
export function createState({ ruleSetId, players, seed = Date.now(), meta = {} } = {}) {
  return {
    ruleSetId,
    seed,
    seq: 0,
    phase: 'idle',
    round: 0,
    turn: null,
    players: players.map((p) => ({
      id: p.id,
      name: p.name,
      isHuman: !!p.isHuman,
      hand: [],
      score: 0,
      alive: true,
      folded: false,
    })),
    cards: {},
    /**
     * 规则包的私有状态位。
     * 内核【不理解】这里面的内容，只负责克隆与合并 —— 叫地主进度、
     * 当前这一手最大的牌、倍数这类东西归规则包自己管，
     * 内核不必为每种玩法长出新字段。
     */
    ruleState: {},
    log: [],
    result: null,
    meta: { ...meta },
  };
}

function deepClone(v) {
  // 只有纯数据会进规则包状态位，structuredClone 安全；
  // 老环境退化成 JSON 往返也够用。
  if (v === null || typeof v !== 'object') return v;
  try {
    return structuredClone(v);
  } catch {
    return JSON.parse(JSON.stringify(v));
  }
}

function cloneRuleState(rs) {
  if (!rs || typeof rs !== 'object') return {};
  return deepClone(rs);
}

function cloneState(s) {
  return {
    ...s,
    players: s.players.map((p) => ({ ...p, hand: [...p.hand] })),
    cards: Object.fromEntries(
      Object.entries(s.cards).map(([k, c]) => [k, { ...c, reveal: { ...c.reveal } }])
    ),
    ruleState: cloneRuleState(s.ruleState),
    log: [...s.log],
    meta: { ...s.meta },
  };
}

/**
 * 应用一个事件，返回新状态。
 * ev = { type, actorId?, payload?, audience?, note? }
 */
export function applyEvent(state, ev) {
  const next = cloneState(state);
  next.seq = state.seq + 1;
  const event = {
    seq: next.seq,
    t: Date.now(),
    audience: 'public',
    ...ev,
  };
  next.log.push(event);
  reduce(next, event);
  return next;
}

/** 批量应用 */
export function applyEvents(state, events) {
  return events.reduce((s, ev) => applyEvent(s, ev), state);
}

/**
 * 深度遍历，找出所有【指向这批牌 id 的引用路径】。
 *
 * 这是销毁功能的配套审计工具，给自检用。
 *
 * 为什么必须有这么一个东西：销毁一张牌之后会留下的错误全是静默的。
 * 手牌里多一个悬空 id，投影层 filter(Boolean) 一挡就看不见了；
 * 规则包的私有状态位里多一个悬空 id（比如斗地主的「当前这一手」），
 * 它就只在算牌点时表现为 undefined，把那一手算成一个不存在的点数。
 * 两种情况都不会抛异常、不会破坏牌局、分数照样守恒 —— 只能靠主动扫。
 *
 * 内核只保证【手牌】不出现悬空引用（见 destroy 的 reducer）。
 * 规则包的私有状态位归规则包自己净化，这里提供检查的手段，不越界替它改。
 *
 * @returns {string[]} 形如 `$.ruleState.lead.cardIds[0]` 的路径列表（空数组＝干净）
 */
export function findCardRefs(root, cardIds, path = '$') {
  const want = cardIds instanceof Set ? cardIds : new Set(cardIds || []);
  const hits = [];
  const walk = (node, at, depth) => {
    if (node === null || node === undefined) return;
    if (typeof node === 'string') {
      if (want.has(node)) hits.push(at);
      return;
    }
    if (typeof node !== 'object') return;
    // 深度上限是防御性的：规则包的私有状态位应当是纯数据，
    // 万一哪天有人把一个带环的结构塞进去，审计不该跟着一起挂掉。
    if (depth > 12) return;
    if (Array.isArray(node)) {
      node.forEach((v, i) => walk(v, `${at}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node)) walk(v, `${at}.${k}`, depth + 1);
  };
  walk(root, path, 0);
  return hits;
}

function findPlayer(state, id) {
  return state.players.find((p) => p.id === id);
}

function reduce(state, ev) {
  const p = ev.payload || {};
  switch (ev.type) {
    case 'game:start':
      state.phase = 'playing';
      break;

    case 'deal': {
      state.cards = { ...state.cards, ...indexCards(p.deck || []) };
      for (const [pid, ids] of Object.entries(p.hands || {})) {
        const player = findPlayer(state, pid);
        if (player) player.hand = [...ids];
        for (const cid of ids) {
          if (state.cards[cid]) {
            const card = state.cards[cid];
            /**
             * 只有【这张牌是刚进场的】才给它盖成「仅自己可见」。
             *
             * 一条牌局里可能发很多次牌（21 点每要一张就是一次发牌）。
             * 如果每次都把朝向重置，那么：荷官的明牌会在第二次发牌时
             * 被重新盖成暗牌、玩家自己亮出来的牌也会缩回去 —— 而且
             * 没有任何报错，只是信息悄悄地少了。
             * 已经到手的牌，朝向是它自己的状态，不该被一次新发牌覆盖。
             */
            const isNew = card.zone === 'deck';
            card.ownerId = pid;
            card.zone = 'hand';
            if (isNew) card.reveal = revealFor(VIS.SELF);
          }
        }
      }
      break;
    }

    case 'turn':
      state.turn = p.playerId ?? null;
      break;

    case 'round:start':
      state.round = p.round ?? state.round + 1;
      break;

    case 'play': {
      const { playerId, cardIds = [] } = p;
      const player = findPlayer(state, playerId);
      if (player) player.hand = player.hand.filter((c) => !cardIds.includes(c));
      for (const cid of cardIds) {
        const card = state.cards[cid];
        if (!card) continue;
        card.zone = 'table';
        card.reveal = revealFor('all');
      }
      break;
    }

    case 'reveal': {
      const card = state.cards[p.cardId];
      if (card) card.reveal = revealFor(p.mode);
      break;
    }

    /**
     * 弃牌：把牌从手牌丢到桌面并公开。
     * 与 play 的区别是它【不构成一次出牌】—— 不参与比大小，
     * 也不改变出牌权。规则包用它实现「违规甩牌」这类破例动作。
     */
    case 'discard': {
      const { playerId, cardIds = [] } = p;
      const player = findPlayer(state, playerId);
      if (player) player.hand = player.hand.filter((c) => !cardIds.includes(c));
      for (const cid of cardIds) {
        const card = state.cards[cid];
        if (!card) continue;
        card.zone = 'table';
        card.ownerId = null;
        card.reveal = revealFor(VIS.ALL);
      }
      break;
    }

    /**
     * 亮牌比大小：一手牌打完了，把它整手摊开。
     *
     * 与 play / discard 的区别在【保留归属】——ownerId 不置空，谁的那手牌
     * 仍然对得上。这有三个用处：结算明细能追溯、记牌器能按座位归类、
     * 以及投影层那句「已亮出的」只会去数还捏在手里的牌（zone === 'hand'），
     * 于是已经摊开的旧牌不会累积成一张越拉越长的假手牌。
     *
     * 21 点的结算、以后梭哈的摊牌都走这一条。
     */
    case 'showdown': {
      const { playerId, cardIds = [] } = p;
      const player = findPlayer(state, playerId);
      if (player) player.hand = player.hand.filter((c) => !cardIds.includes(c));
      for (const cid of cardIds) {
        const card = state.cards[cid];
        if (!card) continue;
        card.zone = 'table';
        card.reveal = revealFor(VIS.ALL);
      }
      break;
    }

    /**
     * 销毁：把牌从牌局里彻底拿掉。
     *
     * 与 play / discard / showdown 的区别是「牌还在不在牌局里」，
     * 不是「牌在哪个位置」。见 VOID_ZONE 的说明。
     *
     * 内核在这里多做一件事：【把所有手牌里的这个 id 一并摘掉】。
     * 这一条不能推给规则包。悬空引用是静默的 ——
     *   · 投影层读牌面走 `state.cards[cid]` 再 filter(Boolean)，
     *     引用悬空只会让那一张牌凭空消失，不报错；
     *   · 而 handCount 是直接读 `p.hand.length` 的，
     *     于是同一份投影会同时说「手牌 5 张」和「列出 4 张」；
     *   · 规则包回头拿这些 id 去查牌面 / 传给引擎，就是 undefined 一路往下传。
     * 让内核保证「手牌里不会出现已销毁的牌」，这类错就没有发生的余地。
     */
    case 'destroy': {
      const { cardIds = [] } = p;
      const gone = new Set(cardIds);
      for (const player of state.players) {
        if (player.hand.some((c) => gone.has(c))) {
          player.hand = player.hand.filter((c) => !gone.has(c));
        }
      }
      for (const cid of cardIds) {
        const card = state.cards[cid];
        if (!card) continue;
        card.zone = VOID_ZONE;
        card.ownerId = null;
        // 朝向也压成「谁都不给看」：万一将来有哪条路径漏掉了 zone 判断，
        // 也过不了第二道门（exposed 是按 reveal.public 筛的）。
        card.reveal = revealFor(VIS.NONE);
      }
      break;
    }

    case 'score': {
      const player = findPlayer(state, p.playerId);
      if (player) player.score += p.delta || 0;
      break;
    }

    case 'fold': {
      const player = findPlayer(state, p.playerId);
      if (player) player.folded = true;
      break;
    }

    case 'transfer': {
      // 牌易主（破例抢牌、或者规则把底牌发给地主）。牌的朝向位默认保持原样：
      // 如果原主人把它设成「所有人都看不见」，抢过来的人同样看不见 ——
      // 这是抢牌本身的代价之一，不是 bug。
      // 例外是规则明确要求「这张牌同时也要翻开」（斗地主的底牌）。
      const { fromId, toId, cardId, reveal } = p;
      const from = findPlayer(state, fromId);
      if (from) from.hand = from.hand.filter((c) => c !== cardId);
      const to = findPlayer(state, toId);
      if (to && !to.hand.includes(cardId)) to.hand.push(cardId);
      const card = state.cards[cardId];
      if (card) {
        card.ownerId = toId;
        card.zone = 'hand';
        if (reveal) card.reveal = revealFor(reveal);
      }
      break;
    }

    // 规则包的私有状态位：内核只做合并，不解释内容
    case 'rule:state': {
      if (p.replace && typeof p.replace === 'object') {
        state.ruleState = cloneRuleState(p.replace);
      }
      if (p.patch && typeof p.patch === 'object') {
        const merged = { ...state.ruleState };
        // 用深拷贝逐键赋值：null 与数字/布尔/字符串是合法取值，
        // 不能被「对象合并」顺手丢掉（例如 lead: null 表示「当前没人出牌」）。
        for (const [k, v] of Object.entries(p.patch)) merged[k] = deepClone(v);
        state.ruleState = merged;
      }
      if (Array.isArray(p.delete)) {
        for (const k of p.delete) delete state.ruleState[k];
      }
      break;
    }

    case 'game:end':
      state.phase = 'over';
      state.result = p.result || null;
      break;

    // speak / note / profile:patch / error / breach / reject / announce
    // 只入日志，不改牌局结构
    case 'speak':
    case 'note':
    case 'profile:patch':
    case 'error':
    case 'breach':
    case 'reject':
    case 'announce':
    case 'private':
    case 'discard':
    case 'showdown':
    default:
      break;
  }
}

// ---------------------------------------------------------------------------
// 事件构造器（保证类型与字段一致性）
// ---------------------------------------------------------------------------

export const ev = {
  gameStart: (ruleSetId) => ({ type: 'game:start', payload: { ruleSetId } }),

  /**
   * 发牌。
   *
   * audience 是 'system' 而不是 'public'：这个 payload 里带着完整的洗牌
   * 顺序和「谁拿到哪几张」，是全项目最敏感的一份数据。内核当然需要它
   * （建牌表、发牌），但绝不能让它进入任何投影结果 —— 否则 AI 只要读一遍
   * 事件流就知道所有对手的手牌。因此它只供 reducer 使用，投影层对所有人
   * （包括上帝视角）都不放行。reducer 不检查 audience，发牌照常生效。
   */
  deal: (deck, hands) => ({ type: 'deal', payload: { deck, hands }, audience: 'system' }),

  roundStart: (round) => ({ type: 'round:start', payload: { round } }),

  turn: (playerId) => ({ type: 'turn', payload: { playerId } }),

  speak: (playerId, text) => ({
    type: 'speak',
    actorId: playerId,
    payload: { text },
    audience: 'public',
  }),

  play: (playerId, cardIds) => ({
    type: 'play',
    actorId: playerId,
    payload: { playerId, cardIds },
    audience: 'public',
  }),

  /** 弃牌：不构成出牌，只把牌丢到桌面公开（破例甩牌用） */
  discard: (playerId, cardIds, text) => ({
    type: 'discard',
    actorId: playerId,
    payload: { playerId, cardIds, text },
    audience: 'public',
  }),

  /** 摊牌：一手牌打完，整手公开（仍然对得上归属）。21 点的结算走这条 */
  showdown: (playerId, cardIds, text) => ({
    type: 'showdown',
    actorId: playerId || null,
    payload: { playerId: playerId || null, cardIds, text },
    audience: 'public',
  }),

  /**
   * 销毁：把牌从牌局里彻底拿掉（不是挪位置）。
   *
   * audience 是 'public'，而且【牌面必须公开】—— 这一条是硬约束，不是体验偏好。
   *
   * 理由：两个胜率引擎（21 点的精确解、斗地主的补全模拟）都是靠
   * 「整副牌 − 我看得见的牌 = 未见牌堆」推出来的。牌一旦销毁，它就不在
   * 任何人的视线里了；如果它销毁成什么点数也没人知道，那未见牌堆就变成
   * 一个「缺了一张、但缺的是哪张不确定」的集合 —— 21 点那种逐位精确的
   * 递推就不成立了，只能退化成对若干种可能取平均的近似解。
   * 公开牌面之后，整副牌的构成仍是一份确定的知识，引擎照旧精确、可复现。
   *
   * 所以「全投影不可见」管的是【这张牌本身】：它不在座位手牌里、不在桌面、
   * 不在记牌器里、也不参与任何计数与规则判断；而「它曾经存在过、现在已经
   * 没了、少的是一个 10」是公开信息，会经 view.burned 给到引擎与提示词。
   */
  destroy: (playerId, cardIds, text) => ({
    type: 'destroy',
    actorId: playerId || null,
    payload: { playerId: playerId || null, cardIds, text },
    audience: 'public',
  }),

  /** 只给某一个人看的一条记录（偷看这类破例的信息产出） */
  privateNote: (playerId, text) => ({
    type: 'private',
    actorId: null,
    payload: { text },
    audience: [playerId],
  }),

  /**
   * 调整一张牌对别人可见不可见。
   * text 是可选的一句话说明（「亮出明牌」「翻开暗牌」）—— 不写就退成
   * 通用文案「调整了自己一张牌的可见性」。这条文案只能描述【动作】，
   * 不能写牌面：投影层对看不见的牌只给 id 和背面，写了就漏。
   */
  reveal: (playerId, cardId, mode, text) => ({
    type: 'reveal',
    actorId: playerId,
    payload: { cardId, mode, text },
    audience: 'public',
  }),

  pass: (playerId) => ({
    type: 'pass',
    actorId: playerId,
    payload: {},
    audience: 'public',
  }),

  score: (playerId, delta) => ({
    type: 'score',
    actorId: playerId,
    payload: { playerId, delta },
    audience: 'public',
  }),

  fold: (playerId) => ({
    type: 'fold',
    actorId: playerId,
    payload: { playerId },
    audience: 'public',
  }),

  gameEnd: (result) => ({ type: 'game:end', payload: { result }, audience: 'public' }),

  /**
   * 规则包的私有状态位。内核不解释内容，只负责克隆与合并。
   *   ev.ruleState({ patch: {...} })   浅合并（推荐：内层结构整体替换）
   *   ev.ruleState({ replace: {...} }) 整体覆盖
   *   ev.ruleState({ delete: ['k'] })  删除某个键（用于清空「当前一手」）
   */
  ruleState: ({ patch, replace, delete: del } = {}) => ({
    type: 'rule:state',
    payload: { patch, replace, delete: del },
    audience: 'public',
  }),
  /**
   * 系统公告（不是角色台词）。
   * 用来播报「谁叫了几分」「谁是地主」「底牌是什么」这类规则事件，
   * 全桌可见，并且会进历史记录。
   */
  announce: (playerId, text, kind = 'info') => ({
    type: 'announce',
    actorId: playerId || null,
    payload: { text, kind },
    audience: 'public',
  }),

  /**
   * 破例（违规）行为。公开事件 —— 一旦有人破例，全桌都知道是谁干的。
   * text 只描述「做了什么」，不含任何被抢走的牌面信息。
   */
  breach: (playerId, kind, text) => ({
    type: 'breach',
    actorId: playerId,
    payload: { kind, text },
    audience: 'public',
  }),

  /**
   * 牌易主。只给当事双方看：抢的人知道自己抢到了什么，
   * 被抢的人知道自己少了什么，其余人只看到上面那个 breach 公告。
   * opts.reveal 用于规则要求「这张牌同时对全桌翻开」的场合（斗地主底牌）。
   */
  transfer: (fromId, toId, cardId, label, opts = {}) => ({
    type: 'transfer',
    actorId: toId,
    payload: { fromId, toId, cardId, label, reveal: opts.reveal },
    audience: Array.isArray(opts.audience) ? opts.audience : [fromId, toId],
  }),

  /** 本地规则拒绝了某个提案动作 */
  reject: (playerId, action, reason) => ({
    type: 'reject',
    actorId: playerId,
    payload: { action, reason },
    audience: 'public',
  }),

  error: (playerId, message) => ({
    type: 'error',
    actorId: playerId,
    payload: { message },
    audience: playerId ? [playerId] : 'public',
  }),
};
