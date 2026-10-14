/**
 * sandbox.js — 沙盒对决（占位规则包）
 *
 * 这不是最终玩法，只是一个最小可跑的规则，用来打通
 * 「发牌 → 视角投影 → LLM 决策 → 本地校验 → 渲染」这条全链路，
 * 同时把「一回合内多次行动」与「破例动作」两套机制先跑通。
 * 等真正玩法（斗地主/21点/比大小/梭哈）确定后替换即可。
 *
 * 规则
 * ------------------------------------------------------------------
 *   2-4 人，每人 5 张牌，共 3 轮。
 *   每人每轮必须出一张牌；点数最大者得 1 分，平局各得 1 分。
 *   一回合内可以行动多次（默认上限 3 次），可以调整自己手牌的
 *   可见性、也可以直接出牌。出牌即视为本回合义务完成，回合结束。
 *   若一整轮烧光行动额度都没出牌，本轮视为弃权（不参与比点）。
 *
 * 破例动作（违规，但智能体可以选择）
 * ------------------------------------------------------------------
 *   抢牌   —— 从对手手上抢走一张（随机），代价：扣 1 分
 *   多出一张 —— 无视「一轮一张」，再出一张牌，代价：扣 1 分
 *   破例一律公开记录，全桌都知道是谁干的。
 */

import { makeDeck, nextVisibility, visibilityOf, VIS_META } from '../core/cards.js';
import { act, destroyCandidates, registerRuleSet, resolveDestroy, RETURN } from '../core/rules.js';
import { makeRng, shuffle } from '../core/rng.js';
import { ev } from '../core/state.js';

const HAND_SIZE = 5;
const MAX_ROUNDS = 3;
/** 一回合内最多行动几次 */
const MAX_ACTIONS_PER_TURN = 3;
/** 一整轮内最多行动几次，超过即视为本轮弃权（防止回合打转） */
const MAX_ACTIONS_PER_ROUND = 6;
/** 破例代价（分） */
const BREACH_PENALTY = 1;
/**
 * 销毁的代价要高过抢牌。
 * 抢牌是「牌易主」，那张牌还在外面、还可能被打出来；销毁是把它从牌局里
 * 拿掉，对所有人（包括被毁的人）都是净损失。代价一样的话，
 * 「抢」就永远劣于「烧」，选择也就不成立了。
 */
const DESTROY_PENALTY = 3;

const OWN_ACTION_TYPES = new Set(['play', 'reveal', 'pass', 'fold']);

/** 取「本轮」的事件：从最近一次 round:start / game:start 之后算起 */
function roundEvents(state) {
  const out = [];
  for (const e of state.log) {
    if (e.type === 'round:start' || e.type === 'game:start') out.length = 0;
    else out.push(e);
  }
  return out;
}

function actionCount(state) {
  const map = new Map();
  for (const e of roundEvents(state)) {
    if (!e.actorId || !OWN_ACTION_TYPES.has(e.type)) continue;
    map.set(e.actorId, (map.get(e.actorId) || 0) + 1);
  }
  return map;
}

function playedThisRound(state) {
  const set = new Set();
  for (const e of roundEvents(state)) {
    if (e.type === 'play' && e.actorId) set.add(e.actorId);
  }
  return set;
}

function playedCardsThisRound(state) {
  const out = [];
  for (const e of roundEvents(state)) {
    if (e.type === 'play' && e.actorId) {
      out.push({ playerId: e.actorId, cardIds: e.payload.cardIds });
    }
  }
  return out;
}

function findPlayer(state, id) {
  return state.players.find((p) => p.id === id);
}

/** 该玩家本轮是否已无继续行动的必要 */
function isDoneThisRound(state, player) {
  if (player.folded) return true;
  if (playedThisRound(state).has(player.id)) return true;
  // 手里一张牌都没有了：本轮他再怎么行动也尽不了「出一张牌」的义务。
  // 不加这一条，被抢光的玩家会被无限地轮回来，整局卡死。
  if (!player.hand.length) return true;
  return (actionCount(state).get(player.id) || 0) >= MAX_ACTIONS_PER_ROUND;
}

export const sandboxDuel = registerRuleSet({
  id: 'sandbox-duel',
  name: '沙盒对决',
  minPlayers: 2,
  maxPlayers: 4,
  description: '每人 5 张牌，共 3 轮，每轮各出一张正面牌比点数，最大者得分。',

  createDeck() {
    return makeDeck({ jokers: 0 });
  },

  deal(players, seed) {
    const deck = shuffle(this.createDeck(), makeRng(seed));
    const hands = {};
    players.forEach((p, i) => {
      hands[p.id] = deck.slice(i * HAND_SIZE, (i + 1) * HAND_SIZE).map((c) => c.id);
    });
    return { deck, hands };
  },

  start(state) {
    const { deck, hands } = this.deal(state.players, state.seed);
    return [ev.gameStart(this.id), ev.deal(deck, hands), ev.roundStart(1)];
  },

  // -------------------------------------------------------------------------
  // 回合推进
  // -------------------------------------------------------------------------

  maxActionsPerTurn() {
    return MAX_ACTIONS_PER_TURN;
  },

  /** 本轮义务（出一张牌）已完成，或额度烧光，或手上已无牌 —— 本回合必须结束 */
  mustEndTurn(state, playerId) {
    const player = findPlayer(state, playerId);
    if (!player) return true;
    if (playedThisRound(state).has(playerId)) return true;
    if (!player.hand.length) return true;
    return (actionCount(state).get(playerId) || 0) >= MAX_ACTIONS_PER_ROUND;
  },

  nextTurn(state) {
    const pending = state.players.filter((p) => p.alive && !isDoneThisRound(state, p));
    return pending.length ? pending[0].id : RETURN;
  },

  // -------------------------------------------------------------------------
  // 候选动作
  // -------------------------------------------------------------------------

  legalActions(state, playerId) {
    const player = findPlayer(state, playerId);
    if (!player || player.folded) return [act.pass('你已出局')];

    const actions = [];

    for (const cid of player.hand) {
      const c = state.cards[cid];
      if (!c) continue;
      actions.push(act.play([cid], `${c.glyph}${c.label}`));
    }

    for (const cid of player.hand) {
      const c = state.cards[cid];
      if (!c) continue;
      const nxt = nextVisibility(visibilityOf(c));
      actions.push(
        act.reveal(cid, nxt, `把 ${c.glyph}${c.label} 改为「${VIS_META[nxt].label}」`)
      );
    }

    actions.push(act.fold());
    return actions;
  },

  /**
   * 破例动作：规则不允许，但智能体可以选择做。
   * 本地兜底策略不会碰这里 —— 只有 LLM 才有资格决定要不要守规矩。
   */
  breachActions(state, playerId, opts = {}) {
    if (opts.allowBreach === false) return [];
    const player = findPlayer(state, playerId);
    if (!player || player.folded) return [];

    const out = [];
    for (const other of state.players) {
      if (other.id === playerId || !other.alive || other.folded) continue;
      if (!other.hand.length) continue;
      out.push(
        act.breach('steal', {
          from: other.id,
          penalty: BREACH_PENALTY,
          label: `从 ${other.name} 手上硬抢一张牌（随机一张，归你）`,
        })
      );
    }
    for (const cid of player.hand) {
      const c = state.cards[cid];
      if (!c) continue;
      out.push(
        act.breach('extraplay', {
          cards: [cid],
          penalty: BREACH_PENALTY,
          label: `无视「一轮只能出一张」，额外打出 ${c.glyph}${c.label}`,
        })
      );
    }

    // 销毁：把牌从牌局里彻底拿掉，谁也没有了
    out.push(...destroyCandidates(state, playerId, { penalty: DESTROY_PENALTY }));

    return out;
  },

  /** 本地兜底策略用的贪心启发式：出最大的牌 */
  heuristic(state, playerId, actions) {
    const rankOf = (a) => state.cards[a.cards?.[0]]?.rank ?? -1;
    const plays = actions.filter((a) => a.type === 'play');
    if (plays.length) {
      return plays.reduce((best, a) => (rankOf(a) > rankOf(best) ? a : best));
    }
    return actions.find((a) => a.type === 'pass') || null;
  },

  // -------------------------------------------------------------------------
  // 校验与执行
  // -------------------------------------------------------------------------

  validate(state, playerId, action, opts = {}) {
    const player = findPlayer(state, playerId);
    if (!player) return { ok: false, reason: `玩家 ${playerId} 不存在于此局` };
    if (!action || typeof action !== 'object') {
      return { ok: false, reason: '动作必须是一个对象' };
    }

    switch (action.type) {
      case 'play': {
        const cards = action.cards;
        if (!Array.isArray(cards) || cards.length === 0) {
          return { ok: false, reason: '出牌动作必须指定要出的牌' };
        }
        for (const cid of cards) {
          if (!player.hand.includes(cid)) {
            const visible = state.cards[cid];
            return {
              ok: false,
              reason: visible
                ? `牌 ${visible.glyph}${visible.label} 不在你手上（它属于别人或已在桌面）`
                : `牌 ${cid} 不存在`,
            };
          }
        }
        if (cards.length > 1) {
          return { ok: false, reason: '本规则每轮只能出一张牌' };
        }
        return { ok: true };
      }

      case 'reveal': {
        if (!player.hand.includes(action.card)) {
          return { ok: false, reason: '只能调整自己手牌的可见性' };
        }
        if (!VIS_META[action.mode]) {
          return { ok: false, reason: `可见性模式 ${action.mode} 不合法` };
        }
        return { ok: true };
      }

      case 'breach': {
        if (opts.allowBreach === false) {
          return { ok: false, reason: '本局禁止破例动作，你必须守规矩' };
        }
        if (action.kind === 'steal') {
          const victim = findPlayer(state, action.from);
          if (!victim) return { ok: false, reason: `找不到要抢的对手 ${action.from}` };
          if (victim.id === playerId) return { ok: false, reason: '不能抢自己的牌' };
          if (!victim.alive || victim.folded) return { ok: false, reason: `${victim.name} 已经不在局中了` };
          if (!victim.hand.length) return { ok: false, reason: `${victim.name} 手上没有牌可抢` };
          return { ok: true, breach: true, kind: 'steal', penalty: BREACH_PENALTY };
        }
        if (action.kind === 'extraplay') {
          const cards = action.cards;
          if (!Array.isArray(cards) || cards.length !== 1) {
            return { ok: false, reason: '破例多出一张时，必须且只能指定一张牌' };
          }
          if (!player.hand.includes(cards[0])) {
            return { ok: false, reason: '要额外打出的牌不在你手上' };
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

      case 'fold':
      case 'pass':
        return { ok: true };

      default:
        return { ok: false, reason: `未知动作类型 ${action.type}` };
    }
  },

  apply(state, playerId, action, check = {}) {
    switch (action.type) {
      case 'play':
        return [ev.play(playerId, action.cards)];

      case 'reveal':
        return [ev.reveal(playerId, action.card, action.mode)];

      case 'breach': {
        const penalty = check.penalty ?? action.penalty ?? BREACH_PENALTY;
        if (action.kind === 'steal') {
          const victim = findPlayer(state, action.from);
          if (!victim || !victim.hand.length) return [];
          // 抢哪一张不由抢的人指定 —— 他看不见对方的手牌，
          // 所以由本地按局面确定性地抽一张（同种子同结果，可回放）。
          const pick = (state.seed + state.log.length * 7) % victim.hand.length;
          const cardId = victim.hand[pick];
          const card = state.cards[cardId];
          const label = card ? `${card.glyph}${card.label}` : '一张牌';
          return [
            ev.breach(playerId, 'steal', `硬抢了 ${victim.name} 一张手牌`),
            ev.transfer(victim.id, playerId, cardId, label),
            ev.score(playerId, -penalty),
          ];
        }
        if (action.kind === 'extraplay') {
          return [
            ev.breach(playerId, 'extraplay', `无视限制，额外打出了一张牌`),
            ev.play(playerId, action.cards),
            ev.score(playerId, -penalty),
          ];
        }

        if (action.kind === 'destroy') {
          // 目标到这里才落定（随机销毁对手的牌在这一步抽）。注意此时
          // 事件还没被应用，state 仍是动作发生前的样子 —— 读牌面读的是对的。
          const r = resolveDestroy(state, playerId, action);
          if (!r.ok || !r.cardId) return [];
          const card = state.cards[r.cardId];
          const face = card ? `${card.glyph}${card.label}` : '一张牌';
          const origin = r.random ? '（他是从对手手上抽的，抽之前他也不知道是哪张）' : '';
          return [
            ev.breach(playerId, 'destroy', `把 ${face} 从牌局里彻底销毁了${origin}`),
            ev.destroy(playerId, [r.cardId], `销毁 ${face}`),
            ev.score(playerId, -penalty),
          ];
        }

        return [];
      }

      case 'fold':
        return [ev.fold(playerId)];

      case 'pass':
        return [ev.pass(playerId)];

      default:
        return [];
    }
  },

  // -------------------------------------------------------------------------
  // 轮次收尾
  // -------------------------------------------------------------------------

  isRoundComplete(state) {
    const alive = state.players.filter((p) => p.alive);
    return alive.length > 0 && alive.every((p) => isDoneThisRound(state, p));
  },

  resolveRound(state) {
    const plays = playedCardsThisRound(state);
    if (!plays.length) return [];

    // 同一玩家可能出了不止一张（破例多出），只算他最大的那张
    const best = new Map();
    for (const p of plays) {
      const rank = state.cards[p.cardIds[0]]?.rank ?? 0;
      const prev = best.get(p.playerId);
      if (!prev || rank > prev.rank) best.set(p.playerId, { playerId: p.playerId, rank });
    }

    const ranks = [...best.values()].sort((a, b) => b.rank - a.rank);
    const top = ranks[0].rank;
    return ranks.filter((r) => r.rank === top).map((w) => ev.score(w.playerId, 1));
  },

  isTerminal(state) {
    return state.round >= MAX_ROUNDS && this.isRoundComplete(state);
  },

  outcome(state) {
    const max = Math.max(...state.players.map((p) => p.score));
    const winners = state.players.filter((p) => p.score === max).map((p) => p.id);
    return {
      winners,
      scores: Object.fromEntries(state.players.map((p) => [p.id, p.score])),
      rounds: state.round,
    };
  },

  describe(state) {
    const lines = [
      `玩法：${this.name}`,
      `人数：${this.minPlayers}-${this.maxPlayers} 人`,
      `每人手牌 ${HAND_SIZE} 张，共 ${MAX_ROUNDS} 轮。`,
      '每轮所有玩家各出 1 张正面牌，点数最大者得 1 分，平局则各得 1 分。',
      `你的回合内最多可以行动 ${MAX_ACTIONS_PER_TURN} 次：可以出牌、也可以调整自己手牌的可见性（这是给对手的信息信号）。`,
      '一旦你本轮出了牌，本回合义务就算完成，回合立即结束。',
      `如果一整轮烧光 ${MAX_ACTIONS_PER_ROUND} 次行动都没出牌，本轮按弃权处理，不参与比点。`,
      '注意：如果你的手牌被抢光，本轮你就无法再出牌了，只能弃权。',
      `破例动作（违规但可选，一律公示）：从对手手上抢一张（扣 ${BREACH_PENALTY} 分）、无视一轮一张的限制多出一张（扣 ${BREACH_PENALTY} 分）、` +
        `把任意一张牌【彻底销毁】（扣 ${DESTROY_PENALTY} 分 —— 那张牌从此不在牌局里，谁也用不了，包括你自己）。`,
      '销毁对手手上的牌时，你看不见是哪张，只能随机毁掉一张；销毁完之后全桌都会知道毁掉的是哪张牌。',
    ];
    if (state) {
      const played = playedThisRound(state);
      const me = state.turn;
      if (me && played.has(me)) lines.push('（你已经出过牌了。）');
    }
    return lines.join('\n');
  },
});
