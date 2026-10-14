/**
 * doudizhu/index.js — 斗地主规则包
 *
 * 这不再是占位规则，而是一套完整玩法：54 张牌、叫地主、跟牌、
 * 炸弹倍数、地主与农民的对抗胜负。
 *
 * 与内核的分工
 * ------------------------------------------------------------------
 * 内核只提供：事件流、视角投影、回合调度、破例通道。
 * 斗地主的私有进度（谁是地主、底牌、这一手最大的牌、倍数）全都放在
 * state.ruleState 里，由本文件读写，内核不解释其内容。
 *
 * 一次「回合」在这里的含义
 * ------------------------------------------------------------------
 * 牌桌上的一巡 = 内核的一个 round。
 *   出牌方出了牌 → 其余两家各回应一次（跟牌或过牌）→ 全过 → 一巡结束
 *   → 内核调 resolveRound，把出牌权交给这一手最大的人 → 开新的一巡
 * 有人把牌出光时立即收束，不再让剩下的人空转。
 *
 * 回合内可以行动多次（默认上限 2）：
 *   第 1 次可以是破例动作（例如抢牌），第 2 次才是正经出牌。
 *   出过牌或过过牌，本回合立即结束。
 */

import { FACE, makeDeck, opaqueDeck } from '../../core/cards.js';
import { act, destroyCandidates, registerRuleSet, resolveDestroy, RETURN } from '../../core/rules.js';
import { derivedIndex, makeRng, shuffle } from '../../core/rng.js';
import { ev } from '../../core/state.js';
import {
  beats, COMBO, COMBO_LABEL, compareReason, isBomb, parseCombo, rankName,
} from './combo.js';
import { enumerateAll, enumerateBeating } from './enumerate.js';

/** 一回合内最多行动几次（留给「先破例、再出牌」两段式） */
const MAX_ACTIONS_PER_TURN = 2;
/** 破例代价（分），在最终结算之外额外扣 */
const BREACH_PENALTY = 2;
/**
 * 销毁的代价（分）。
 *
 * 定得比抢牌高：抢牌是把牌换个人拿，那张牌还会被打出来；
 * 销毁是让它彻底不在牌局里，对所有人都是净损失。同样价的话，
 * 「抢」会被「烧」严格支配，两个选择里就只剩一个了。
 */
const DESTROY_PENALTY = 4;
/** 单次枚举上限，避免候选动作把提示词撑爆 */
const ENUM_LIMIT = 40;
/** 每个对手最多列几张「指定位置」的抢牌候选（看不见的牌彼此等价，列多了只是噪声） */
const STEAL_ID_LIMIT = 2;

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const ddzRanks = (() => {
  const out = [];
  for (let v = 3; v <= 15; v++) out.push({ v, label: rankName(v) });
  return out;
})();

function findPlayer(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

function rsOf(state) {
  return state.ruleState || {};
}

function handCards(state, playerId) {
  const p = findPlayer(state, playerId);
  if (!p) return [];
  return p.hand.map((cid) => state.cards[cid]).filter(Boolean);
}

function cardLabel(state, cid) {
  const c = state.cards[cid];
  return c ? `${c.glyph}${c.label}` : '一张牌';
}

function labels(state, ids) {
  return (ids || []).map((cid) => cardLabel(state, cid)).join(' ');
}

/**
 * 取「本阶段」的事件：从最近一次 round:start / game:start / deal 之后算起。
 * deal 也算分界，是因为流局重发之后叫分记录要作废。
 */
function phaseEvents(state) {
  const out = [];
  for (const e of state.log) {
    if (e.type === 'round:start' || e.type === 'game:start' || e.type === 'deal') out.length = 0;
    else out.push(e);
  }
  return out;
}

/** 本阶段内该玩家有没有过「过牌」记录 */
function passedRecently(state, playerId) {
  return phaseEvents(state).some((e) => e.type === 'pass' && e.actorId === playerId);
}

/** 玩家本轮（本回合）是否已经出牌或过牌 —— 用于判定回合该结束了 */
function actedThisTurn(state, playerId) {
  const log = state.log;
  let idx = -1;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === 'turn' && log[i].payload?.playerId === playerId) {
      idx = i;
      break;
    }
  }
  if (idx < 0) return false;
  return log
    .slice(idx)
    .some((e) => e.actorId === playerId && (e.type === 'play' || e.type === 'pass'));
}

/** 活着的座位顺序 */
function seatOrder(state) {
  return state.players.filter((p) => p.alive).map((p) => p.id);
}

/** 从 fromId 开始顺时针找到第一个没在 acted 里的活人 */
function nextPending(state, fromId, acted = []) {
  const order = seatOrder(state);
  const i = order.indexOf(fromId);
  if (i < 0) return null;
  for (let k = 1; k < order.length; k++) {
    const id = order[(i + k) % order.length];
    if (!acted.includes(id)) return id;
  }
  return null;
}

/** 是否有人已经走完（手牌为空） */
function someoneOut(state) {
  return state.players.some((p) => p.alive && p.hand.length === 0);
}

/** 叫分记录（含被降级成「不叫」的空白回合同理） */
function bidsOf(state) {
  return rsOf(state).bids || {};
}

function hasBid(state, playerId) {
  if (bidsOf(state)[playerId] != null) return true;
  // 智能体什么都没做时，主干会补一条 pass，等价于「不叫」
  return passedRecently(state, playerId);
}

function currentTopBid(state) {
  return Math.max(0, ...Object.values(bidsOf(state)).map((n) => Number(n) || 0));
}

// ---------------------------------------------------------------------------
// 手牌强度（本地兜底叫分用）
// ---------------------------------------------------------------------------

export function handStrength(cards) {
  let s = 0;
  const cnt = new Map();
  for (const c of cards) cnt.set(c.rank, (cnt.get(c.rank) || 0) + 1);
  if (cnt.has(16)) s += 0.8;
  if (cnt.has(17)) s += 0.8;
  if (cnt.has(16) && cnt.has(17)) s += 0.6;
  s += (cnt.get(15) || 0) * 0.5;
  for (const [, n] of cnt) if (n === 4) s += 0.9;
  s += (cnt.get(14) || 0) * 0.2;
  return s;
}

/**
 * 从最后一次发牌算起，每个人各出过几手牌。
 *
 * 春天 / 反春天要的就是这个数：「一张没出」和「只出过一手」是两个必须精确
 * 知道的边界。事件日志里本来就有，不必另立状态位 —— 另立就会在流局重发、
 * 换玩法、读档这些路径上跟真相脱节。
 */
function playCounts(state) {
  const log = state.log || [];
  let from = 0;
  for (let i = log.length - 1; i >= 0; i--) {
    if (log[i].type === 'deal') { from = i; break; }
  }
  const out = {};
  for (const e of log.slice(from)) {
    if (e.type === 'play' && e.actorId) out[e.actorId] = (out[e.actorId] || 0) + 1;
  }
  return out;
}

/**
 * 结算：地主一个人对上一整队农民，所以地主这边的进出必须是「农民人数 × 倍数」。
 *
 * 写成固定的 2 会只在三人斗地主里凑巧零和（+2 对 −1 −1），四人下就漏了
 * 一分出来（+2 对 −1 −1 −1）。桌面上的分数必须守恒，否则「地主胜率」这个
 * 概念本身就失去意义 —— 样本里的期望值不再等于场上的期望值。
 *
 * 倍数顺序：叫分底分 → 场上每出一次炸弹/王炸 ×2 → 春天再 ×2。
 */
function settle(state) {
  const rs = rsOf(state);
  const landlord = rs.landlord;
  const outId = state.players.find((p) => p.hand.length === 0)?.id ?? null;
  const landlordWon = !!landlord && outId === landlord;
  // 农民人数决定地主这边的进出：三人是 2，四人是 3
  const farmers = Math.max(1, state.players.filter((p) => p.id !== landlord).length);

  // 春天 / 反春天。这两条是斗地主里倍数跳得最凶的一种，漏掉它结算就是错的。
  const plays = playCounts(state);
  let spring = null;
  if (landlord) {
    const farmersIdle = state.players.every((p) => p.id === landlord || !plays[p.id]);
    if (landlordWon && farmersIdle) spring = 'spring';
    else if (!landlordWon && (plays[landlord] || 0) <= 1) spring = 'anti';
  }

  const base = Math.max(1, rs.multiplier || 1);
  const mult = spring ? base * 2 : base;

  const deltas = {};
  for (const p of state.players) {
    if (p.id === landlord) deltas[p.id] = (landlordWon ? 1 : -1) * farmers * mult;
    else deltas[p.id] = landlordWon ? -mult : mult;
  }
  return { landlord, landlordWon, mult, base, spring, outId, deltas, farmers };
}

// ---------------------------------------------------------------------------
// 规则包
// ---------------------------------------------------------------------------

export const doudizhu = registerRuleSet({
  id: 'doudizhu',
  name: '斗地主',
  minPlayers: 3,
  maxPlayers: 4,
  /** 支持一次选中多张牌再出（人类操作需要） */
  multiSelect: true,
  /** 斗地主没有认输，页面据此隐藏「认输」按钮 */
  allowFold: false,
  description: '54 张牌，叫地主，地主一人对上一整队农民。先出完手牌的一方获胜，炸弹翻倍，春天再翻一倍。',

  createDeck() {
    // 固定重编号：id 不再按「花色在外、点数在内」排，读一眼反解不出牌面。
    // 之所以放在 createDeck 而不是发牌那一步 —— 补全世界（doudizhu-sim 的
    // createDealer）是【只拿得到投影】的，它靠 createDeck 重建「哪个 id 是几点」
    // 这张对照表；如果发牌时再按种子改一次 id，这张表就对不上了，
    // 整个视角补全会静默失准（实测症状：未知牌堆凭空多出 20 张）。
    // 重编号不依赖种子，所以两边算出来必然一致。
    return opaqueDeck(makeDeck({ ranks: ddzRanks, jokers: 2, jokerBase: 16 }), 0, 0);
  },

  /** 3 人各 17 张留 3 张底牌；4 人各 13 张留 2 张底牌 */
  deal(players, seed) {
    const size = players.length;
    const bottomCount = size === 4 ? 2 : 3;
    const per = (54 - bottomCount) / size;
    const deck = shuffle(this.createDeck(), makeRng(seed));
    const hands = {};
    players.forEach((p, i) => {
      hands[p.id] = deck.slice(i * per, (i + 1) * per).map((c) => c.id);
    });
    const bottom = deck.slice(size * per).map((c) => c.id);
    return { deck, hands, bottom };
  },

  start(state) {
    const { deck, hands, bottom } = this.deal(state.players, state.seed);
    return [
      ev.gameStart(this.id),
      ev.deal(deck, hands),
      ev.ruleState({ replace: baseRuleState(state, bottom) }),
      ev.announce(
        null,
        `发牌完毕，每人 ${hands[state.players[0].id].length} 张，底牌已扣下。开始叫地主。`
      ),
    ];
  },

  // -------------------------------------------------------------------------
  // 回合调度
  // -------------------------------------------------------------------------

  maxActionsPerTurn(state) {
    return rsOf(state).phase === 'bid' ? 1 : MAX_ACTIONS_PER_TURN;
  },

  /**
   * 本回合该收手了？
   * 叫地主阶段：叫过一次就完。
   * 出牌阶段：出过牌或过过牌就完 —— 但在此之前允许先做一个破例动作，
   * 所以「一回合多次选择」在斗地主里依然成立。
   */
  mustEndTurn(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase === 'bid') return hasBid(state, playerId);
    if (rs.phase !== 'play') return true;
    return actedThisTurn(state, playerId);
  },

  /**
   * 本回合结束之后，是否需要替他补一手「过牌」。
   *
   * 斗地主里「亮牌」是允许的，但它不构成出牌也不构成过牌。如果一个人
   * 整回合只亮牌，出牌权那边就永远等不到他的回应，牌局会原地打转。
   * 所以这里要求：没出过牌也没过过牌，就补一条过牌记录。
   */
  needsPassFallback(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return false;
    return !actedThisTurn(state, playerId);
  },

  nextTurn(state) {
    const rs = rsOf(state);

    if (rs.phase === 'bid') {
      if (rs.landlord) return RETURN; // 有人叫满 3 分，地主已定
      const pending = (rs.bidOrder || []).filter((pid) => !hasBid(state, pid));
      return pending.length ? pending[0] : RETURN;
    }

    if (rs.phase !== 'play') return RETURN;

    // 有人走完就立刻收束，不再让剩下的人空转
    if (someoneOut(state)) return RETURN;

    const lead = rs.lead || null;
    if (!lead) {
      // 新的一巡，出牌权在这个人手上。防呆：他若连牌都不肯出，
      // 把他跳过，否则整局会原地打转。
      if (passedRecently(state, rs.leaderId)) return RETURN;
      return rs.leaderId;
    }

    const pending = seatOrder(state).filter(
      (id) => id !== lead.playerId && !(rs.acted || []).includes(id)
    );
    if (!pending.length) return RETURN;
    return nextPending(state, lead.playerId, rs.acted || []);
  },

  // -------------------------------------------------------------------------
  // 候选动作
  // -------------------------------------------------------------------------

  legalActions(state, playerId) {
    const rs = rsOf(state);
    const player = findPlayer(state, playerId);
    if (!player || !player.alive) return [act.pass('你已不在局中')];

    if (rs.phase === 'bid') {
      const top = currentTopBid(state);
      const out = [];
      for (const s of [3, 2, 1]) {
        if (s > top) out.push({ type: 'bid', score: s, label: `叫 ${s} 分` });
      }
      out.push({ type: 'bid', score: 0, label: '不叫' });
      return out;
    }

    if (rs.phase !== 'play') return [act.pass('当前阶段不能出牌')];
    if (!player.hand.length) return [act.pass('你已经把牌出完了')];

    const cards = handCards(state, playerId);
    const lead = rs.lead || null;
    // 自己就是上一手最大的那家时，不需要跟自己的牌
    const target = lead && lead.playerId !== playerId ? lead.combo : null;
    const list = target
      ? enumerateBeating(cards, target, { limit: ENUM_LIMIT })
      : enumerateAll(cards, { limit: ENUM_LIMIT });

    /**
     * 枚举是「便宜优先」排序再截断的，于是最贵的那一手 ——
     * 通常是长顺子、长连对 —— 会被挤掉。可「一把出完」恰恰是直接赢的一手，
     * 少了它，候选表会把致胜招藏起来（实测：12 张一条顺子的手牌，
     * 候选里只剩散牌）。所以这里单独把它找回来，并且放在最前面。
     */
    const whole = cards.length > 1 ? parseCombo(cards) : null;
    if (whole?.ok && !list.some((d) => d.cardIds.length === cards.length)) {
      if (!target || beats(whole.combo, target)) {
        list.unshift({ combo: whole.combo, cardIds: cards.map((c) => c.id) });
      }
    }

    const out = list.map((d) => ({
      type: 'play',
      cards: d.cardIds,
      label: `${d.combo.label} —— ${labels(state, d.cardIds)}`,
    }));

    // 亮牌：把手上的大牌摊给全桌。不改变胜负，但是一种真实的威慑信号。
    const seen = new Set();
    for (const c of [...cards].sort((a, b) => b.rank - a.rank)) {
      if (seen.has(c.rank)) continue;
      seen.add(c.rank);
      if (seen.size > 3) break;
      out.push(act.reveal(c.id, 'all', `把 ${c.glyph}${c.label} 亮给全桌看（威慑）`));
    }

    if (target) out.push(act.pass('压不过，或者想留着牌'));
    return out;
  },

  /**
   * 破例动作：规则不允许，但智能体可以选择做。
   * 本地兜底策略【绝不】碰这里 —— 要不要耍赖只由 LLM 自己决定。
   *
   * 抢牌有三种抢法，区别全在「你到底知不知道抢到的是什么」：
   *   1. 抢一张【已经亮出来】的牌 —— 桌上看得见，抢到手是确定的收益
   *   2. 抢一张【指定位置】的牌 —— 牌面你看不见，只能指认「他手上第几张」
   *   3. 随便抢一张 —— 连位置都不挑
   * 第 2 种和第 3 种在信息上其实是等价的（看不见的牌彼此没有差别），
   * 但保留它，是因为「我抢了他第三张」这件事会被记住：那张牌将来一旦被
   * 翻开，抢的人立刻知道当初抢的是什么。信息可以迟到，但不能没有。
   */
  breachActions(state, playerId, opts = {}) {
    if (opts.allowBreach === false) return [];
    const rs = rsOf(state);
    if (rs.phase !== 'play') return [];
    const player = findPlayer(state, playerId);
    if (!player || !player.alive || !player.hand.length) return [];

    const out = [];
    for (const other of state.players) {
      if (other.id === playerId || !other.alive || !other.hand.length) continue;

      const visible = [];
      const hidden = [];
      for (const cid of other.hand) {
        const c = state.cards[cid];
        if (!c) continue;
        (c.reveal.public === FACE ? visible : hidden).push(cid);
      }

      for (const cid of visible) {
        const c = state.cards[cid];
        out.push(
          act.breach('steal', {
            from: other.id,
            card: cid,
            penalty: BREACH_PENALTY,
            label: `抢走 ${other.name} 那张看得见的 ${c.glyph}${c.label}（他把它亮出来了，抢到手是确定的）`,
          })
        );
      }

      const picks = hidden.length <= STEAL_ID_LIMIT
        ? hidden
        : [hidden[0], hidden[hidden.length - 1]];
      for (const cid of picks) {
        const pos = other.hand.indexOf(cid) + 1;
        out.push(
          act.breach('steal', {
            from: other.id,
            card: cid,
            penalty: BREACH_PENALTY,
            label: `抢 ${other.name} 手上从左数第 ${pos} 张（牌面你看不见，抢到算运气）`,
          })
        );
      }

      out.push(
        act.breach('steal', {
          from: other.id,
          pick: 'random',
          penalty: BREACH_PENALTY,
          label: `从 ${other.name} 手上随便抢一张（连位置都不挑）`,
        })
      );
      out.push(
        act.breach('peek', {
          target: other.id,
          penalty: BREACH_PENALTY,
          label: `偷看 ${other.name} 的一张手牌（只有你知道看到了什么）`,
        })
      );
    }

    const cheapest = [...handCards(state, playerId)]
      .sort((a, b) => a.rank - b.rank)
      .slice(0, 3);
    for (const c of cheapest) {
      out.push(
        act.breach('extraplay', {
          cards: [c.id],
          penalty: BREACH_PENALTY,
          label: `违规甩掉一张 ${c.glyph}${c.label}（不构成出牌，但你的手牌少一张）`,
        })
      );
    }

    /**
     * 销毁：把一张牌从牌局里彻底拿掉。
     * 目标是「任意牌」——自己手上的、台面上已经打出来的、对手手上的，
     * 甚至还没轮到谁手里的底牌。看不见的牌只能按人头随机（见 rules.js）。
     */
    const leadIds = new Set((rs.lead && rs.lead.cardIds) || []);
    for (const a of destroyCandidates(state, playerId, { penalty: DESTROY_PENALTY })) {
      // 后果要说清楚：毁掉台面上正在比大小的那张，这一巡会作废。
      // 不说的话，模型是在不知道自己会改写出牌权的情况下做这个决定。
      if (a.pick === 'card' && leadIds.has(a.cardId)) {
        a.label += '（这张正在台面上比大小：销毁它会让这一巡作废，重新由出牌权的人领出）';
      }
      out.push(a);
    }

    return out;
  },

  /** 本地兜底用的贪心：叫分看牌力，出牌挑最便宜的能压过的一手 */
  heuristic(state, playerId, actions) {
    const rs = rsOf(state);
    const list = actions || [];

    if (rs.phase === 'bid') {
      const cards = handCards(state, playerId);
      const want = handStrength(cards) >= 2.4 ? 3 : handStrength(cards) >= 1.4 ? 2 : handStrength(cards) >= 0.7 ? 1 : 0;
      const bids = list.filter((a) => a.type === 'bid' && a.score <= want && a.score > 0);
      return bids.length ? bids[0] : list.find((a) => a.type === 'bid' && a.score === 0) || null;
    }

    const plays = list.filter((a) => a.type === 'play');
    if (plays.length) return plays[0]; // 枚举已按「便宜优先」排好序
    return list.find((a) => a.type === 'pass') || null;
  },

  // -------------------------------------------------------------------------
  // 校验与执行
  // -------------------------------------------------------------------------

  validate(state, playerId, action, opts = {}) {
    const rs = rsOf(state);
    const player = findPlayer(state, playerId);
    if (!player) return { ok: false, reason: `玩家 ${playerId} 不存在于此局` };
    if (!action || typeof action !== 'object') {
      return { ok: false, reason: '动作必须是一个对象' };
    }

    switch (action.type) {
      case 'bid': {
        if (rs.phase !== 'bid') return { ok: false, reason: '现在不是叫地主阶段' };
        const next = nextTurnForBid(state);
        if (next !== playerId) {
          return { ok: false, reason: `现在还没轮到你叫分（当前该 ${nameOf(state, next)} 叫）` };
        }
        const score = Number(action.score);
        if (![0, 1, 2, 3].includes(score)) {
          return { ok: false, reason: '叫分只能是 0（不叫）、1、2、3' };
        }
        const top = currentTopBid(state);
        if (score !== 0 && score <= top) {
          return { ok: false, reason: `已经有人叫到 ${top} 分，你要叫就必须叫得比它高` };
        }
        if (score === 3 && top === 3) return { ok: false, reason: '已经是 3 分了' };
        return { ok: true };
      }

      case 'play': {
        if (rs.phase !== 'play') return { ok: false, reason: '现在还不能出牌，先叫完地主' };
        const cards = action.cards;
        if (!Array.isArray(cards) || !cards.length) {
          return { ok: false, reason: '出牌必须指定要出哪些牌' };
        }
        for (const cid of cards) {
          if (!player.hand.includes(cid)) {
            const c = state.cards[cid];
            return {
              ok: false,
              reason: c
                ? `牌 ${c.glyph}${c.label} 不在你手上（它属于别人或已经在桌面上了）`
                : `牌 ${cid} 不存在`,
            };
          }
        }
        const picked = cards.map((cid) => state.cards[cid]).filter(Boolean);
        const parsed = parseCombo(picked);
        if (!parsed.ok) return { ok: false, reason: `这不是一个合法牌型：${parsed.reason}` };

        const lead = rs.lead || null;
        const target = lead && lead.playerId !== playerId ? lead.combo : null;
        if (target && !beats(parsed.combo, target)) {
          return {
            ok: false,
            reason: `压不过对方的${COMBO_LABEL[target.type]}。${compareReason(parsed.combo, target)}`,
          };
        }
        return { ok: true };
      }

      case 'reveal': {
        if (!player.hand.includes(action.card)) {
          return { ok: false, reason: '只能翻自己手上的牌' };
        }
        return { ok: true };
      }

      case 'pass': {
        if (rs.phase === 'bid') return { ok: false, reason: '叫地主阶段请用「不叫」，不要用「过牌」' };
        const lead = rsOf(state).lead || null;
        const target = lead && lead.playerId !== playerId ? lead.combo : null;
        if (!target) {
          return { ok: false, reason: '这一轮由你先出牌，你必须出一手牌，不能过' };
        }
        return { ok: true };
      }

      case 'fold':
        return { ok: false, reason: '斗地主没有认输，牌出完了自然结束' };

      case 'breach': {
        if (opts.allowBreach === false) {
          return { ok: false, reason: '本局禁止破例动作，你必须守规矩' };
        }
        if (rs.phase !== 'play') return { ok: false, reason: '叫地主阶段不能耍赖' };
        if (action.kind === 'steal' || action.kind === 'peek') {
          const key = action.kind === 'steal' ? 'from' : 'target';
          const victim = findPlayer(state, action[key]);
          if (!victim) return { ok: false, reason: `找不到对手 ${action[key]}` };
          if (victim.id === playerId) return { ok: false, reason: '不能对自己下手' };
          if (!victim.alive) return { ok: false, reason: `${victim.name} 已经不在局中` };
          if (!victim.hand.length) return { ok: false, reason: `${victim.name} 手上没牌了` };
          if (action.kind === 'steal' && action.card && !victim.hand.includes(action.card)) {
            return { ok: false, reason: '你要抢的那张牌已经不在他手上了' };
          }
          return { ok: true, breach: true, kind: action.kind, penalty: BREACH_PENALTY };
        }
        if (action.kind === 'extraplay') {
          const cards = action.cards;
          if (!Array.isArray(cards) || cards.length !== 1) {
            return { ok: false, reason: '违规甩牌一次只能指定一张' };
          }
          if (!player.hand.includes(cards[0])) {
            return { ok: false, reason: '要甩掉的牌不在你手上' };
          }
          return { ok: true, breach: true, kind: 'extraplay', penalty: BREACH_PENALTY };
        }
        if (action.kind === 'destroy') {
          const r = resolveDestroy(state, playerId, action);
          if (!r.ok) return { ok: false, reason: r.reason };
          return { ok: true, breach: true, kind: 'destroy', penalty: DESTROY_PENALTY };
        }
        return { ok: false, reason: `未定义的破例类型 ${action.kind}` };
      }

      default:
        return { ok: false, reason: `未知动作类型 ${action.type}` };
    }
  },

  apply(state, playerId, action, check = {}) {
    const rs = rsOf(state);

    switch (action.type) {
      case 'bid': {
        const score = Number(action.score);
        const bids = { ...bidsOf(state), [playerId]: score };
        return [
          ev.ruleState({ patch: { bids, landlord: score === 3 ? playerId : rs.landlord ?? null } }),
          ev.announce(playerId, score === 0 ? '不叫' : `叫 ${score} 分`, score === 3 ? 'big' : 'info'),
        ];
      }

      case 'play': {
        const picked = action.cards.map((cid) => state.cards[cid]).filter(Boolean);
        const parsed = parseCombo(picked);
        const combo = parsed.ok ? parsed.combo : null;
        const events = [
          ev.play(playerId, action.cards),
          ev.ruleState({
            patch: {
              lead: combo ? { playerId, cardIds: [...action.cards], combo } : rs.lead ?? null,
              acted: [],
            },
          }),
        ];
        if (combo && isBomb(combo)) {
          const next = Math.max(1, rs.multiplier || 1) * 2;
          events.push(ev.ruleState({ patch: { multiplier: next } }));
          events.push(ev.announce(null, `出现${COMBO_LABEL[combo.type]}！倍数翻倍，现在是 ${next} 倍。`, 'big'));
        }
        return events;
      }

      case 'pass':
        return [
          ev.pass(playerId),
          ev.ruleState({ patch: { acted: [...(rs.acted || []), playerId] } }),
        ];

      case 'reveal':
        return [ev.reveal(playerId, action.card, action.mode)];

      case 'breach': {
        const penalty = check.penalty ?? action.penalty ?? BREACH_PENALTY;
        if (action.kind === 'steal') {
          const victim = findPlayer(state, action.from);
          if (!victim || !victim.hand.length) return [];
          /**
           * 抢哪一张：
           *   指定了 card（看得见的牌 / 指定了位置的那张）→ 就抢它
           *   没指定 → 由本地按局面确定性地抽一张（同种子同结果，可回放）
           * 抢的人看不见牌面时，公告里也不能写牌面 —— 那是只有他才知道的信息。
           */
          const specified = action.card && victim.hand.includes(action.card) ? action.card : null;
          const cardId = specified
            || victim.hand[derivedIndex(state.seed, state.log.length * 7 + 1, victim.hand.length)];
          const card = state.cards[cardId];
          const openToAll = !!card && card.reveal.public === FACE;
          const events = [
            ev.breach(
              playerId,
              'steal',
              openToAll && specified
                ? `抢走了 ${victim.name} 已经亮出来的 ${card.glyph}${card.label}`
                : `硬抢了 ${victim.name} 一张手牌`
            ),
            ev.transfer(victim.id, playerId, cardId, cardLabel(state, cardId)),
            ev.score(playerId, -penalty),
          ];
          return events;
        }
        if (action.kind === 'peek') {
          const victim = findPlayer(state, action.target);
          if (!victim || !victim.hand.length) return [];
          const pick = derivedIndex(state.seed, state.log.length * 11 + 3, victim.hand.length);
          const cardId = victim.hand[pick];
          return [
            ev.breach(playerId, 'peek', `偷看了 ${victim.name} 一张手牌`),
            ev.privateNote(playerId, `你偷看到 ${victim.name} 的一张牌是 ${cardLabel(state, cardId)}。`),
            ev.score(playerId, -penalty),
          ];
        }
        if (action.kind === 'extraplay') {
          const cid = action.cards[0];
          return [
            ev.breach(playerId, 'extraplay', `违规甩掉了一张牌`),
            ev.discard(playerId, [cid], '违规甩牌'),
            ev.score(playerId, -penalty),
          ];
        }
        if (action.kind === 'destroy') {
          const r = resolveDestroy(state, playerId, action);
          if (!r.ok) return [];
          const card = state.cards[r.cardId];
          const face = card ? `${card.glyph}${card.label}` : '一张牌';
          // 从对手手上抽的：他没翻过这张牌，所以他是「抽走之后才知道」，
          // 公告里说清这一点 —— 否则看起来像他点着名烧了对手的某张牌。
          const origin = r.random ? '（从对手手上抽的，抽之前他也不知道是哪张）' : '';
          const events = [
            ev.breach(playerId, 'destroy', `把 ${face} 从牌局里彻底销毁了${origin}`),
            ev.destroy(playerId, [r.cardId], `销毁 ${face}`),
            ev.score(playerId, -penalty),
          ];
          const patch = destroyPatch(rs, r.cardId);
          if (Object.keys(patch).length) events.push(ev.ruleState({ patch }));
          return events;
        }
        return [];
      }

      default:
        return [];
    }
  },

  // -------------------------------------------------------------------------
  // 一巡的收尾
  // -------------------------------------------------------------------------

  isRoundComplete(state) {
    const rs = rsOf(state);
    if (rs.phase === 'bid') {
      if (rs.landlord) return true;
      return (rs.bidOrder || []).every((pid) => hasBid(state, pid));
    }
    if (rs.phase !== 'play') return false;
    if (someoneOut(state)) return true;
    const lead = rs.lead || null;
    if (!lead) return !rs.leaderId || passedRecently(state, rs.leaderId);
    return !seatOrder(state).some(
      (id) => id !== lead.playerId && !(rs.acted || []).includes(id)
    );
  },

  /** 把底牌发给地主，并把牌局推进到出牌阶段 */
  finalizeLandlord(state, landlordId) {
    const rs = rsOf(state);
    const bottom = rs.bottom || [];
    const bid = Number(bidsOf(state)[landlordId]) || 0;
    const events = [
      ev.announce(
        null,
        `${nameOf(state, landlordId)} 成为地主${bid ? `（叫 ${bid} 分）` : ''}，底牌是 ${labels(state, bottom)}。`,
        'big'
      ),
      ev.ruleState({
        patch: {
          phase: 'play',
          landlord: landlordId,
          leaderId: landlordId,
          bottomShown: true,
        },
      }),
    ];
    for (const cid of bottom) {
      // 底牌是全桌公开信息，不是地主的私密牌：
      // 翻开这件事并进 transfer 里，不再单独发 reveal 事件 ——
      // 否则牌桌上会凭空多出三条「有人调整了可见性」的噪声。
      events.push(
        ev.transfer(null, landlordId, cid, cardLabel(state, cid), { reveal: 'all' })
      );
    }
    return events;
  },

  resolveRound(state) {
    const rs = rsOf(state);

    if (rs.phase === 'bid') {
      const order = rs.bidOrder || [];
      if (rs.landlord) return this.finalizeLandlord(state, rs.landlord);
      if (!order.every((pid) => hasBid(state, pid))) return [];

      const top = currentTopBid(state);
      if (top > 0) {
        const winner = order.find((pid) => Number(bidsOf(state)[pid]) === top) || order[0];
        return this.finalizeLandlord(state, winner);
      }

      // 三家都不叫：正常规则是重新发牌
      if ((rs.redeals || 0) >= 2) {
        // 连发三轮还是没人叫，再兜下去整局就废了 —— 直接按牌力指定
        const best = [...state.players].sort(
          (a, b) => handStrength(handCards(state, b.id)) - handStrength(handCards(state, a.id))
        )[0];
        return [
          ev.announce(
            null,
            `连续 ${(rs.redeals || 0) + 1} 轮没有人叫地主，按牌力指定 ${best.name} 当地主。`,
            'big'
          ),
          ...this.finalizeLandlord(state, best.id),
        ];
      }
      const seed2 = state.seed + ((rs.redeals || 0) + 1) * 7919;
      const { deck, hands, bottom } = this.deal(state.players, seed2);
      return [
        ev.announce(null, `没有人叫地主，重新发牌（第 ${(rs.redeals || 0) + 2} 次）。`),
        ev.deal(deck, hands),
        ev.ruleState({
          replace: {
            ...baseRuleState(state, bottom),
            redeals: (rs.redeals || 0) + 1,
          },
        }),
      ];
    }

    if (rs.phase !== 'play') return [];

    // 有人走完：直接结算，不再让剩下的人空转
    if (someoneOut(state)) {
      const s = settle(state);
      const farmersText = s.landlordWon ? '农民' : `地主 ${nameOf(state, s.landlord)}`;
      const text = s.landlordWon
        ? `地主 ${nameOf(state, s.landlord)} 先把牌出完，${farmersText}告负。`
        : `农民先把牌出完，${farmersText}告负。`;
      const springWord = s.spring === 'spring' ? '春天' : s.spring === 'anti' ? '反春天' : '';
      const springWhy = s.spring === 'spring'
        ? '（农民一张牌都没出过）'
        : s.spring === 'anti' ? '（地主只出过一手牌）' : '';
      const multText = springWord
        ? `底分 1 × ${s.base} 倍，${springWord}${springWhy}再 ×2 = ${s.mult} 倍`
        : `底分 1 × ${s.mult} 倍`;
      return [
        ...state.players
          .filter((p) => (s.deltas[p.id] || 0) !== 0)
          .map((p) => ev.score(p.id, s.deltas[p.id])),
        ...(springWord
          ? [ev.announce(null, `${springWord}！${springWhy}每个农民的进出翻倍。`, 'big')]
          : []),
        ev.announce(null, `对局结束：${text}${multText}。`, 'big'),
      ];
    }

    const lead = rs.lead || null;
    if (lead) {
      return [
        ev.ruleState({ patch: { lead: null, acted: [], leaderId: lead.playerId } }),
        ev.announce(null, `${nameOf(state, lead.playerId)} 这一手最大，接下来由他先出牌。`),
      ];
    }

    // 没有 lead 也没人走完：出牌权那家一直没出牌，顺给下一个（防死循环）
    const fallback = nextPending(state, rs.leaderId, []) || seatOrder(state)[0];
    return [
      ev.ruleState({ patch: { leaderId: fallback, acted: [] } }),
      ev.announce(
        null,
        `${nameOf(state, rs.leaderId)} 没有出牌，出牌权顺给 ${nameOf(state, fallback)}。`
      ),
    ];
  },

  isTerminal(state) {
    return rsOf(state).phase === 'play' && someoneOut(state);
  },

  outcome(state) {
    const s = settle(state);
    const farmerIds = state.players.filter((p) => p.id !== s.landlord).map((p) => p.id);
    return {
      winners: s.landlordWon ? [s.landlord] : farmerIds,
      landlord: s.landlord,
      landlordWon: s.landlordWon,
      multiplier: s.mult,
      baseMultiplier: s.base,
      spring: s.spring,
      farmers: farmerIds.length,
      deltas: s.deltas,
      outId: s.outId,
      scores: Object.fromEntries(state.players.map((p) => [p.id, p.score])),
      rounds: state.round,
    };
  },

  /**
   * 给 LLM 看的规则文本。
   * 注意：这里拿到的是【原始状态】，所以只能写全桌公开的信息 ——
   * 底牌是公开的（规则要求），别人的手牌不是，一个字都不能出现。
   */
  describe(state) {
    const rs = rsOf(state);
    // 这套规则文本要同时服务三人和四人局。写死「另外两家」「三家都不叫」
    // 会让四人的智能体读到一套对不上牌桌的规则 —— 它据此做的判断全歪。
    const nPlayers = state && state.players ? state.players.length : 3;
    const nFarmers = Math.max(1, nPlayers - 1);
    const lines = [
      `玩法：斗地主（54 张牌，${nPlayers} 人局，每人 ${((54 - (nPlayers === 4 ? 2 : 3)) / nPlayers)} 张）。`,
      `目标：谁先把手上的牌出完，谁所在的一方获胜。地主一个人一队，另外 ${nFarmers} 家是农民，合作对抗地主。`,
      '',
      '【叫地主】每人依次叫 1 / 2 / 3 分，或者不叫。叫分最高的当地主并拿走底牌；',
      `有人叫满 3 分则立刻结束叫分。${nPlayers} 家都不叫要重新发牌。`,
      '',
      '【出牌】地主先出。之后每一轮由「上一手最大」的人先出，其余各家依次跟牌：',
      '跟牌必须出【同样牌型、同样张数、且点数更大】的一手；压不过就过牌。',
      '其余人都过了，出牌权就回到那个最大的人手上，他重新自由出牌。',
      '',
      '【牌型】',
      '  单张 / 对子 / 三张',
      '  三带一（三张 + 任意 1 张）、三带二（三张 + 任意 1 对）',
      '  顺子：≥5 张点数连续的单牌，不含 2 和王',
      '  连对：≥3 对点数连续的对子，不含 2 和王',
      '  飞机：≥2 个点数连续的三张，可以带等量的单牌或等量的对子',
      '  四带二：4 张同点 + 2 张单牌；四带两对：4 张同点 + 2 对',
      '  炸弹：4 张同点，能压过任何非炸弹的牌型',
      '  王炸：小王 + 大王，最大，压过一切',
      '',
      '【点数大小】3 < 4 < 5 < 6 < 7 < 8 < 9 < 10 < J < Q < K < A < 2 < 小王 < 大王',
      '',
      '【倍数】底分 1，每出现一次炸弹或王炸，倍数翻倍。',
      `  地主赢：地主 +${nFarmers}×倍数，每个农民 −倍数；地主输：地主 −${nFarmers}×倍数，每个农民 +倍数。`,
      '  春天：地主出完牌而农民一张都没出过，倍数再翻一倍（×2）。',
      '  反春天：农民赢下牌局而地主只出过一手牌，倍数同样再翻一倍（×2）。',
      '',
      '【亮牌】你可以把自己手上的大牌亮给全桌看。它不改变输赢，但会改变对手对你的判断。',
      '【破例】抢牌 / 偷看 / 违规甩牌 / 销毁都是规则不允许的，做了会额外扣分并全桌公示。',
      '  抢牌有三种抢法：抢一张【已经亮出来】的牌（抢到什么是确定的）；',
      '  抢某个人手上【指定位置】的那一张（牌面你看不见，抢到算运气）；',
      '  或者随便抢一张。看不见的牌彼此没有差别，怎么选都不会更准。',
      '  销毁是把一张牌【彻底移出牌局】：它不在任何人手上、也不在牌堆里，谁也用不了了。',
      `  销毁对手手上的牌时你看不见是哪张，只能随机毁一张；毁掉之后全桌都会知道是哪张（扣分最多，${DESTROY_PENALTY} 分）。`,
    ];

    if (state) {
      const me = findPlayer(state, state.turn);
      const who = (id) => nameOf(state, id);

      if (rs.phase === 'bid') {
        const top = currentTopBid(state);
        lines.push('');
        lines.push('【当前进度】正在叫地主。');
        lines.push(
          `已经叫过的：${
            Object.keys(bidsOf(state)).length
              ? Object.entries(bidsOf(state))
                  .map(([pid, n]) => `${who(pid)} ${n === 0 ? '不叫' : `叫 ${n} 分`}`)
                  .join('，')
              : '还没有人叫'
          }。当前最高 ${top} 分。`
        );
      } else if (rs.phase === 'play') {
        lines.push('');
        lines.push('【当前进度】');
        lines.push(
          `地主是 ${who(rs.landlord)}，目前 ${Math.max(1, rs.multiplier || 1)} 倍。`
        );
        if (rs.bottomShown) {
          lines.push(`底牌（已公开，归地主）：${labels(state, rs.bottom)}`);
        }
        for (const p of state.players) {
          lines.push(`  · ${who(p.id)} 手上还有 ${p.hand.length} 张`);
        }
        const lead = rs.lead || null;
        if (lead) {
          const samePerson = lead.playerId === state.turn;
          lines.push(
            samePerson
              ? '现在轮到你重新自由出牌（上一手是你自己的牌，已经没人压得过）。'
              : `现在台上最大的一手是 ${who(lead.playerId)} 出的${lead.combo?.label || '牌'}：${labels(state, lead.cardIds)}。`
          );
          if (!samePerson) {
            lines.push('你要么出比它更大的一手，要么过牌。');
          }
        } else {
          lines.push('现在台上没有牌，轮到你自由出牌（什么合法牌型都可以）。');
        }
      }
      if (me && rs.phase === 'play' && rs.lead && rs.lead.playerId !== me.id) {
        lines.push('');
        lines.push(`提醒：现在轮到你（${who(me.id)}）跟牌。`);
      }
    }

    return lines.join('\n');
  },

  /** 页面状态栏用的一句话 */
  statusLine(state) {
    const rs = rsOf(state);
    if (rs.phase === 'bid') {
      const top = currentTopBid(state);
      return `叫地主中 · 当前最高 ${top} 分`;
    }
    if (rs.phase === 'play') {
      const parts = [`地主 ${nameOf(state, rs.landlord)}`, `${Math.max(1, rs.multiplier || 1)} 倍`];
      if (rs.bottomShown) parts.push(`底牌 ${labels(state, rs.bottom)}`);
      return parts.join(' · ');
    }
    return '';
  },
});

// ---------------------------------------------------------------------------
// 模块级辅助
// ---------------------------------------------------------------------------

/** 座位名。找不到人时给一句人话，别把 undefined 播出去 */
function nameOf(state, id) {
  return findPlayer(state, id)?.name || '（未知）';
}

/** 叫地主阶段「接下来该谁叫」——validate 需要用它来判断越权 */
function nextTurnForBid(state) {
  const rs = rsOf(state);
  if (rs.landlord) return null;
  const pending = (rs.bidOrder || []).filter((pid) => !hasBid(state, pid));
  return pending.length ? pending[0] : null;
}

/**
 * 从规则包自己的私有状态位里把一张牌摘干净，返回该写回的事件补丁。
 *
 * 内核只保证【手牌】不出现悬空引用（见 state.js 的 destroy）；
 * bottom / lead 这些只有规则包认识的字段得自己清。
 * 漏掉的后果全是静默的：
 *   · bottom 不清 —— 提示词会继续说「底牌是 ♠K」，而那张牌已经不在牌局里，
 *     模型据此以为地主手上捏着它；
 *   · lead 不清 —— 台面上那一手已经少了一张，却还按原来的牌型比大小。
 *
 * 写成「返回补丁」而不是「就地改 rs」，是因为 apply 里的 rs 是 state 上
 * 那一份的【活引用】：就地改等于绕过事件流直接改状态，回放就复现不出来
 * 同一局了。所有进度变化都必须走 ev.ruleState。
 *
 * @returns 一个可直接交给 ev.ruleState({ patch }) 的对象（可能为空）
 */
function destroyPatch(rs, cardId) {
  const patch = {};

  if (Array.isArray(rs.bottom) && rs.bottom.includes(cardId)) {
    patch.bottom = rs.bottom.filter((c) => c !== cardId);
  }

  const lead = rs.lead;
  if (lead && Array.isArray(lead.cardIds) && lead.cardIds.includes(cardId)) {
    /**
     * 台面上这一手正在被比大小，拆掉其中一张之后它就没有定义了
     * （「一对 7」少一张是什么？没人答得上来）。
     * 处理方式是【取消这一巡】：lead 清空、回过牌的人清零，
     * 出牌权回到 leaderId —— nextTurn 对「lead 为空」本来就是这个走法，
     * 所以不需要为销毁单开一条路径。谁再出一手，acted 会被重新置空。
     */
    patch.lead = null;
    patch.acted = [];
  }
  return patch;
}

/** 一局叫地主阶段的开局状态位（重发时也要用同一份，避免两处漂移） */
function baseRuleState(state, bottom) {
  return {
    phase: 'bid',
    bids: {},
    bidOrder: state.players.map((p) => p.id),
    landlord: null,
    bottom: [...bottom],
    bottomShown: false,
    multiplier: 1,
    lead: null,
    acted: [],
    leaderId: null,
    redeals: 0,
  };
}

export { ddzRanks, parseCombo };
