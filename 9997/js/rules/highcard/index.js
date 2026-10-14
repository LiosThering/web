/**
 * index.js — 比大小规则包（换牌式）
 *
 * 玩法
 * ------------------------------------------------------------------
 *   2-4 人，每人每轮拿两张暗牌，比两张之和。
 *   轮到的玩家只有两个选择：【换一张】或者【停牌】。
 *   全部停手后一起摊牌，和最大的人赢下这一轮，得 1 分。
 *   一共 4 轮，按总分排名。
 *
 * 为什么是「两张之和」而不是「一张牌」
 * ------------------------------------------------------------------
 * 一张牌比大小是个没有决策的游戏：轮到你时，「换」与「不换」的计算太浅，
 * 而且——更要紧的一条——【破例动作会失去目标】。内核有一条通用底线：
 * 某个人的最后一张牌不能被销毁（否则「他手上没牌了」就等于伪造出
 * 「他打完了」）。每人只持一张牌时，那条底线会让「销毁对手的牌」
 * 这个破例在整局里永远不可用，菜单里只剩「销毁桌面上的弃牌」这种
 * 什么都不影响的选项，「守不守规矩」就不再是一个真实选择了。
 * 两张牌同时解决这两个问题：和是两维的（换哪张、换不换），
 * 而毁掉其中一张会让他的和当场掉一大截。
 *
 * 「换一张」为什么不问玩家换哪张
 * ------------------------------------------------------------------
 * 换掉较小的一张【严格不劣于】换掉较大的那张：新牌来自同一个分布，
 * 而你留下的那一张更大。既然它是弱占优的，就把它写成规则，
 * 玩家只按一个按钮。好处是这一玩法不需要「点牌选中」这套手势
 * （cardGesture: 'none'），和 21 点共用同一条「动作按钮」通路。
 *
 * 同和怎么分胜负
 * ------------------------------------------------------------------
 * 两张之和相等很常见（9+K 与 10+Q 都是 22）。依次往下比：
 *   1. 和大的赢；
 *   2. 和相等，比各自最大的那一张；
 *   3. 还相等，比那张牌的花色（♠ > ♥ > ♦ > ♣）。
 * 第 3 条一定分得出：牌是唯一的，(点数, 花色) 相同的那张牌只有一张，
 * 不可能出现在两家手里。所以本玩法【没有平局】。
 *
 * 牌堆
 * ------------------------------------------------------------------
 * 单副 52 张，【每轮重洗】。一轮最多用掉 4 人 ×（2 张 + 2 次换牌）= 16 张，
 * 离 52 张很远，所以不需要像 21 点那样跨手续用同一副牌，也就没有
 * 「用到第几张了」这条跨轮状态。牌堆顺序仍按种子现推、编号带轮次
 * （opaqueDeck 的 salt = 轮次），于是：
 *   · 上一轮摊在桌上的牌不会和这一轮的牌撞 id；
 *   · 「下一张是什么」不写进任何事件，读牌堆读不出来。
 * ------------------------------------------------------------------
 */

import { makeDeck, opaqueDeck, VIS } from '../../core/cards.js';
import {
  act, destroyCandidates, pickDeterministic, registerRuleSet, resolveDestroy, RETURN,
} from '../../core/rules.js';
import { makeRng, shuffle } from '../../core/rng.js';
import { ev } from '../../core/state.js';

/** 一共打几轮 */
const MAX_ROUNDS = 4;

/** 每人每轮最多换几次牌 */
const MAX_SWAPS = 2;

/** 每人起手几张 */
const HAND_SIZE = 2;

/**
 * 一回合内最多行动几次。
 *
 * 一次行动就交回合（换牌或停牌），这正是要的：
 * 「换完接着换」由下一轮的队尾轮转给回来，而不是靠一个回合里连点两次。
 * 那样做的话，一个回合内能连换两张，别人就完全没机会插话——
 * 而这是个轮流出招的游戏，不是一个人打完再轮到下一个。
 */
const MAX_ACTIONS_PER_TURN = 1;

/** 破例代价：偷看一次扣半分的胜场 */
const PEEK_PENALTY = 0.5;

/**
 * 破例代价：销毁一张牌扣 1.5 分。
 *
 * 定得比偷看高，理由和 21 点那一处相同但更硬：这一玩法里毁掉对手一张牌
 * 会让他的和平均掉 7 点左右，而整轮只值 1 分 —— 代价低于 1 的话，
 * 「烧」会变成严格支配「偷看」的动作，选择就不存在了。
 */
const DESTROY_PENALTY = 1.5;

/** 花色强弱：♠ > ♥ > ♦ > ♣（同点数时的裁决依据） */
const SUIT_RANK = { S: 4, H: 3, D: 2, C: 1 };

function findPlayer(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

function rsOf(state) {
  return state.ruleState || {};
}

function labelOf(state, cid) {
  const c = state.cards[cid];
  return c ? `${c.glyph}${c.label}` : '一张牌';
}

function labelList(state, ids) {
  return (ids || []).map((id) => labelOf(state, id)).join(' ');
}

// ---------------------------------------------------------------------------
// 牌堆：每轮一副，顺序按种子现推
// ---------------------------------------------------------------------------

/**
 * 第 roundNo 轮的牌堆顺序。
 *
 * salt 用轮次：opaqueDeck 会把它编进 id 前缀（`s2-…`），
 * 于是上一轮摊在桌上的牌与这一轮的牌不会互相覆盖。
 * 中间那个连字符不是装饰 —— 少了它，第 1 轮的牌会被算进第 10 轮的计数里。
 */
function deckOf(seed, roundNo) {
  const deck = makeDeck({ jokers: 0 });
  let h = (seed >>> 0) ^ Math.imul((roundNo | 0) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return opaqueDeck(shuffle(deck, makeRng(h)), seed, roundNo | 0);
}

/**
 * 这一轮里已经被烧掉的位置（见破例「盲烧牌堆顶」）。
 * 位置是数组而不是集合：一轮之内的量很小，朴素查找就够，
 * 而数组能被 JSON 原样带进 ruleState / 事件流，回放时不会变类型。
 */
function isBurned(rs, pos) {
  return Array.isArray(rs.burned) && rs.burned.includes(pos);
}

/** 从牌堆顶上取一张，跳过被烧掉的位置 */
function drawOne(state, rs) {
  const deck = deckOf(state.seed, rs.roundNo);
  while (isBurned(rs, rs.shoePos)) rs.shoePos += 1;
  const card = deck[rs.shoePos];
  rs.shoePos += 1;
  return card;
}

/**
 * 【下一次抽牌】会抽到哪一张、在第几个位置。
 * 盲烧牌堆用的就是它 —— 必须跟着 drawOne 的跳位规则走，
 * 自己另写一份判断的话，两处想的会不是同一张牌。
 */
function peekNextDraw(state, rs) {
  let pos = rs.shoePos;
  while (isBurned(rs, pos)) pos += 1;
  const deck = deckOf(state.seed, rs.roundNo);
  return { pos, card: deck[pos] };
}

// ---------------------------------------------------------------------------
// 手牌
// ---------------------------------------------------------------------------

/**
 * 手牌存两份：牌 id 与牌点。
 *
 * 牌点【必须】由规则包自己记 —— 规则包是在事件被应用之前跑的，
 * 这一批刚发出的牌此刻还不在 state 里，回查只能读到 undefined。
 * 那样不会报错，只会静默算错：新摸到的牌不参与求和，
 * 「换一张」的提示语永远显示换之前的和。
 * 这也是 21 点 makeHand 那条注释里的同一个坑，这里再记一次。
 */
function handMapOf(rs) {
  const map = {};
  for (const [pid, ids] of Object.entries(rs.hands || {})) {
    if (Array.isArray(ids) && ids.length) map[pid] = [...ids];
  }
  return map;
}

function sumOf(rs, pid) {
  const ranks = (rs.ranks && rs.ranks[pid]) || [];
  return ranks.reduce((a, b) => a + b, 0);
}

/** 手上较小那张的【位置】。换牌换的就是它 */
function weakerIndex(rs, pid) {
  const ranks = (rs.ranks && rs.ranks[pid]) || [];
  if (ranks.length < 2) return 0;
  return ranks[0] <= ranks[1] ? 0 : 1;
}

/**
 * 从规则包自己的私有状态位里摘掉一张牌。
 * 内核只保证【手牌】不出现悬空引用；hands / ranks 是规则包自己的平行数组，
 * 内核不认识，也就清不掉。只清一个会让索引整体错位 —— 那手牌会算出一个
 * 不存在的和，而且不报错。
 */
function purgeCardFromRuleState(rs, cardId) {
  for (const pid of Object.keys(rs.hands || {})) {
    const ids = rs.hands[pid];
    const keep = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] !== cardId) keep.push(i);
    if (keep.length === ids.length) continue;
    rs.hands[pid] = keep.map((i) => ids[i]);
    rs.ranks[pid] = keep.map((i) => rs.ranks[pid][i]);
  }
  if (Array.isArray(rs.pending)) rs.pending = rs.pending.filter((c) => !c || c.id !== cardId);
}

// ---------------------------------------------------------------------------
// 发一轮牌
// ---------------------------------------------------------------------------

function dealRound(state, rs, events, roundNo) {
  rs.roundNo = roundNo;
  rs.phase = 'play';
  rs.hands = {};
  rs.ranks = {};
  rs.swaps = {};
  rs.stood = {};
  rs.results = [];
  rs.pending = [];
  rs.shoePos = 0;
  rs.burned = [];
  rs.order = state.players.map((p) => p.id);
  rs.queue = [...rs.order];
  for (const id of rs.order) {
    rs.hands[id] = [];
    rs.ranks[id] = [];
    rs.swaps[id] = 0;
    rs.stood[id] = false;
  }

  // 真牌桌是轮着发的：一圈一张，转两圈。顺序会改变「哪张牌落在谁手里」，
  // 所以不能图省事一次发两张。
  const fresh = [];
  for (let k = 0; k < HAND_SIZE; k++) {
    for (const pid of rs.order) {
      const card = drawOne(state, rs);
      rs.hands[pid].push(card.id);
      rs.ranks[pid].push(card.rank);
      fresh.push(card);
    }
  }

  events.push(ev.announce(null, `第 ${roundNo} 轮发牌：每人两张暗牌`, 'deal'));
  events.push(ev.deal(fresh, handMapOf(rs)));
}

// ---------------------------------------------------------------------------
// 比大小
// ---------------------------------------------------------------------------

/** 一手的比较键：和 → 最大单张的点数 → 最大单张的花色 */
function keyOf(state, rs, pid) {
  const ids = (rs.hands && rs.hands[pid]) || [];
  const cards = ids.map((id) => state.cards[id]).filter(Boolean);
  let sum = 0;
  let rank = 0;
  let suit = 0;
  for (const c of cards) {
    sum += c.rank;
    const s = SUIT_RANK[c.suit] || 0;
    if (c.rank > rank || (c.rank === rank && s > suit)) {
      rank = c.rank;
      suit = s;
    }
  }
  return { sum, rank, suit };
}

/** a 是否严格大于 b */
function beats(a, b) {
  if (a.sum !== b.sum) return a.sum > b.sum;
  if (a.rank !== b.rank) return a.rank > b.rank;
  return a.suit > b.suit;
}

// ---------------------------------------------------------------------------
// 规则包
// ---------------------------------------------------------------------------

export const highcard = registerRuleSet({
  id: 'highcard',
  name: '比大小',
  minPlayers: 2,
  maxPlayers: 4,
  multiSelect: false,
  allowFold: false,
  /** 动作不指定牌（换哪张由规则决定），所以点牌没有意义 —— 界面据此只摆按钮 */
  cardGesture: 'none',
  description: '每人两张暗牌，比两张之和。轮到你时可以换掉较小的一张，或停牌。和最大者赢下本轮。',
  /** 本地兜底策略允许弃牌与否：这一玩法没有弃牌，留着这个开关只是显式化 */
  localPolicyAllowFold: false,

  createDeck() {
    return makeDeck({ jokers: 0 });
  },

  deal(players, seed) {
    // 真正的发牌在 start / resolveRound 里做（每轮重洗，一次性发不出来），
    // 这个方法只为满足契约。
    const deck = shuffle(makeDeck({ jokers: 0 }), makeRng(seed));
    return { deck, hands: {} };
  },

  start(state) {
    const rs = {};
    const events = [ev.gameStart(this.id), ev.roundStart(1)];
    dealRound(state, rs, events, 1);
    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  statusLine(state) {
    const rs = rsOf(state);
    if (!rs.hands) return '';
    const left = MAX_SWAPS - (rs.swaps && rs.swaps[state.turn] ? rs.swaps[state.turn] : 0);
    const me = state.turn && rs.hands[state.turn]
      ? ` · 你的和 ${sumOf(rs, state.turn)}（还能换 ${Math.max(0, left)} 次）`
      : '';
    return `第 ${state.round}/${MAX_ROUNDS} 轮${me}`;
  },

  maxActionsPerTurn() {
    return MAX_ACTIONS_PER_TURN;
  },

  mustEndTurn(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return true;
    return (rs.queue || [])[0] !== playerId;
  },

  nextTurn(state) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return RETURN;
    const q = rs.queue || [];
    return q.length ? q[0] : RETURN;
  },

  /**
   * 轮到你时，如果你已经没牌可换，那就只剩「停牌」——
   * 这时提示语必须说清楚原因，否则玩家会以为是 UI 少画了一个按钮。
   */
  turnHint(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return '这一轮已经打完了，正在结算。';
    if ((rs.queue || [])[0] !== playerId) return '还没轮到你。';
    const ids = (rs.hands && rs.hands[playerId]) || [];
    const swaps = (rs.swaps && rs.swaps[playerId]) || 0;
    const left = MAX_SWAPS - swaps;
    const detail = ids.length
      ? `你现在是 ${labelList(state, ids)}，和 ${sumOf(rs, playerId)}`
      : '你手上没有牌了';
    return left > 0
      ? `轮到你了：${detail}，还能换 ${left} 次 —— 用下方按钮决定「换一张 / 停牌」`
      : `轮到你了：${detail}，换牌次数已经用完了，只能停牌`;
  },

  selectionHint() {
    return '这个玩法不靠点牌：动作在下方按钮上';
  },

  /** 这一玩法没有「过牌」这个动作；玩家不动作就是还在想 */
  needsPassFallback() {
    return false;
  },

  // -------------------------------------------------------------------------
  // 候选动作
  // -------------------------------------------------------------------------

  legalActions(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return [];
    if ((rs.queue || [])[0] !== playerId) return [];

    const out = [];
    const left = MAX_SWAPS - ((rs.swaps && rs.swaps[playerId]) || 0);
    const ids = (rs.hands && rs.hands[playerId]) || [];
    if (left > 0 && ids.length >= 2) {
      const wi = weakerIndex(rs, playerId);
      out.push(
        act.hit(`换一张（把较小的 ${labelOf(state, ids[wi])} 弃到桌上，重摸一张；本局还剩 ${left} 次）`)
      );
    }
    out.push(act.stand(`停牌（就以现在这 ${ids.length} 张、和 ${sumOf(rs, playerId)} 结束本轮）`));
    return out;
  },

  /**
   * 破例动作。
   *   偷看 —— 看某个对手手上的一张暗牌（内容只进你自己的私有记录）
   *   销毁 —— 把任意一张牌从牌局里彻底拿掉（含盲烧牌堆、毁掉对手手牌里的一张）
   */
  breachActions(state, playerId, opts = {}) {
    if (opts.allowBreach === false) return [];
    const rs = rsOf(state);
    if (rs.phase !== 'play') return [];
    if ((rs.queue || [])[0] !== playerId) return [];

    const out = [];
    for (const other of state.players) {
      if (other.id === playerId) continue;
      const ids = (rs.hands && rs.hands[other.id]) || [];
      if (!ids.length) continue;
      out.push(
        act.breach('peek', {
          from: other.id,
          penalty: PEEK_PENALTY,
          label: `偷看 ${other.name} 的一张暗牌（随机一张，代价 ${PEEK_PENALTY} 分，全桌都会知道）`,
        })
      );
    }
    out.push(
      ...destroyCandidates(state, playerId, {
        penalty: DESTROY_PENALTY,
        allowShoe: true,
      })
    );
    return out;
  },

  /** 本地兜底：手上的小牌低于「未见牌堆的平均点数」就换 */
  heuristic(state, playerId, actions) {
    const rs = rsOf(state);
    const swap = actions.find((a) => a.type === 'hit');
    const stand = actions.find((a) => a.type === 'stand');
    if (!swap) return stand || actions[0] || null;
    const mine = (rs.ranks && rs.ranks[playerId]) || [];
    return swapWorthwhile(mine, seenRanksFor(state, playerId)) ? swap : (stand || swap);
  },

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  validate(state, playerId, action, opts = {}) {
    const rs = rsOf(state);
    if (!action || typeof action !== 'object') return { ok: false, reason: '动作必须是一个对象' };
    if (rs.phase !== 'play') return { ok: false, reason: '现在不是行动阶段' };
    if ((rs.queue || [])[0] !== playerId) return { ok: false, reason: '现在轮到的不是你' };

    switch (action.type) {
      case 'hit': {
        const left = MAX_SWAPS - ((rs.swaps && rs.swaps[playerId]) || 0);
        if (left <= 0) return { ok: false, reason: `本轮换牌次数已用完（上限 ${MAX_SWAPS} 次）` };
        const ids = (rs.hands && rs.hands[playerId]) || [];
        if (ids.length < 2) return { ok: false, reason: '手上不足两张，没有再换的必要' };
        return { ok: true };
      }
      case 'stand':
        return { ok: true };
      case 'breach': {
        if (opts.allowBreach === false) return { ok: false, reason: '本局禁止破例动作，你必须守规矩' };
        if (action.kind === 'peek') {
          const victim = findPlayer(state, action.from);
          if (!victim) return { ok: false, reason: `找不到要偷看的对手 ${action.from}` };
          if (victim.id === playerId) return { ok: false, reason: '偷看自己的牌没有意义' };
          const ids = (rs.hands && rs.hands[victim.id]) || [];
          if (!ids.length) return { ok: false, reason: `${victim.name} 手上没有牌` };
          return { ok: true, breach: true, kind: 'peek', penalty: PEEK_PENALTY };
        }
        if (action.kind === 'destroy') {
          const r = resolveDestroy(state, playerId, action);
          if (!r.ok) return { ok: false, reason: r.reason };
          return { ok: true, breach: true, kind: 'destroy', penalty: DESTROY_PENALTY };
        }
        return { ok: false, reason: `未定义的破例类型 ${action.kind}` };
      }
      case 'pass':
        return { ok: false, reason: '这个玩法没有跳过：要么换一张，要么停牌' };
      default:
        return { ok: false, reason: `未知动作类型 ${action.type}` };
    }
  },

  // -------------------------------------------------------------------------
  // 执行
  // -------------------------------------------------------------------------

  apply(state, playerId, action, check = {}) {
    const rs = JSON.parse(JSON.stringify(rsOf(state)));
    rs.pending = [];
    const events = [];
    const queue = Array.isArray(rs.queue) ? rs.queue : [];

    switch (action.type) {
      case 'hit': {
        const ids = rs.hands[playerId] || [];
        const ranks = rs.ranks[playerId] || [];
        const wi = weakerIndex(rs, playerId);
        const oldId = ids[wi];
        const oldFace = labelOf(state, oldId);

        // 弃掉较小的那张：进桌面、公开。公开不是体验偏好 ——
        // 两个胜率口径（记牌器、视角补全）都靠「整副牌 − 看得见的牌」
        // 推未见牌堆，牌一旦离开牌局却没人知道是什么，未见牌堆就成了
        // 一个「少了一张但不知道少哪张」的集合，补全世界会补错。
        events.push(ev.discard(playerId, [oldId]));

        // 抽新的一张
        const card = drawOne(state, rs);
        ids[wi] = card.id;
        ranks[wi] = card.rank;
        rs.swaps[playerId] = (rs.swaps[playerId] || 0) + 1;
        rs.pending = [card];
        events.push(ev.deal(rs.pending, handMapOf(rs)));
        rs.pending = [];

        events.push(
          ev.announce(
            playerId,
            `换牌：弃掉 ${oldFace}，摸到一张新的（现在两张之和 ${sumOf(rs, playerId)}）`,
            'play'
          )
        );

        // 换完之后回到队尾：轮转一圈再回来，别人才有机会插话
        const i = queue.indexOf(playerId);
        if (i >= 0) {
          queue.splice(i, 1);
          queue.push(playerId);
        }
        break;
      }

      case 'stand': {
        const i = queue.indexOf(playerId);
        if (i >= 0) queue.splice(i, 1);
        rs.stood[playerId] = true;
        events.push(
          ev.announce(playerId, `停牌：以 ${labelList(state, rs.hands[playerId])}、和 ${sumOf(rs, playerId)} 定下`, 'play')
        );
        break;
      }

      case 'breach': {
        if (action.kind === 'peek') {
          const victim = findPlayer(state, action.from);
          const ids = (victim && rs.hands[victim.id]) || [];
          if (!ids.length) break;
          // 看哪一张由本地定：候选里说的是「随机一张」，
          // 若让发起者指定具体牌，他就能借这个动作当探针逐张确认。
          const cid = pickDeterministic(ids, state, 31);
          events.push(ev.breach(playerId, 'peek', `偷看了 ${victim.name} 的一张暗牌`));
          events.push(ev.privateNote(playerId, `你偷看到 ${victim.name} 手上的一张是 ${labelOf(state, cid)}`));
          events.push(ev.score(playerId, -PEEK_PENALTY));
          break;
        }

        if (action.kind === 'destroy') {
          const r = resolveDestroy(state, playerId, action);
          if (!r.ok) break;

          let cardId = r.cardId;
          let face;

          if (r.shoe) {
            /**
             * 盲烧牌堆顶。
             *
             * 比别处多一步：还没发出去的牌【根本不在 state.cards 里】
             * （牌堆顺序按种子现推，见 deckOf），所以要先把它登记进牌表，
             * 否则 destroy 找不到它，投影层也就报不出 burned ——
             * 而 burned 正是胜率引擎用来知道「牌堆少了一张」的唯一凭据。
             * 用一个空 hands 的发牌事件登记：牌进了牌表但谁也没拿到，
             * 于是它停在 zone 'deck'，紧接着被 destroy 打成 'void'。
             */
            const next = peekNextDraw(state, rs);
            cardId = next.card.id;
            face = `${next.card.glyph}${next.card.label}`;
            rs.burned = [...(rs.burned || []), next.pos];
            events.push(ev.deal([next.card], {}));
          } else {
            const card = state.cards[cardId];
            face = card ? `${card.glyph}${card.label}` : '一张牌';
            purgeCardFromRuleState(rs, cardId);
          }

          const origin = r.random
            ? '（从对手手上抽的，抽之前他也不知道是哪张）'
            : r.shoe ? '（盲烧的牌堆顶，烧之前他不知道是哪张）' : '';
          events.push(ev.breach(playerId, 'destroy', `把 ${face} 从牌局里彻底销毁了${origin}`));
          events.push(ev.destroy(playerId, [cardId], `销毁 ${face}`));
          events.push(ev.score(playerId, -DESTROY_PENALTY));
          break;
        }
        break;
      }

      default:
        return [];
    }

    rs.queue = queue;
    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  // -------------------------------------------------------------------------
  // 轮次收尾
  // -------------------------------------------------------------------------

  isRoundComplete(state) {
    const rs = rsOf(state);
    return rs.phase !== 'play';
  },

  /**
   * 摊牌 + 计分 + 【发下一轮】。
   *
   * 发下一轮挂在这里，是被内核的时序逼出来的：内核只有 start 与
   * resolveRound 两个「规则包可以发事件」的时机，轮与轮之间没有钩子。
   */
  resolveRound(state) {
    const rs = JSON.parse(JSON.stringify(rsOf(state)));
    const events = [];
    rs.pending = [];

    // 摊牌：本轮所有人的牌一起翻到桌面上。这一步同时是记牌器的一条输入，
    // 也是「和是多少」这件事从私有变成公开的那一刻。
    for (const pid of rs.order || []) {
      const ids = (rs.hands && rs.hands[pid]) || [];
      if (ids.length) events.push(ev.showdown(pid, ids));
    }

    const keys = {};
    for (const pid of rs.order || []) keys[pid] = keyOf(state, rs, pid);

    let best = null;
    for (const pid of rs.order || []) {
      if (!best || beats(keys[pid], keys[best])) best = pid;
    }

    rs.results = (rs.order || []).map((pid) => ({
      playerId: pid,
      sum: keys[pid].sum,
      cards: [...(rs.hands[pid] || [])],
      won: pid === best,
    }));

    if (best) {
      events.push(ev.score(best, 1));
      const detail = (rs.order || [])
        .map((pid) => `${findPlayer(state, pid)?.name || pid} ${keys[pid].sum}`)
        .join('、');
      events.push(
        ev.announce(null, `本轮开牌：${detail} —— ${findPlayer(state, best)?.name || best} 赢下这一轮`, 'good')
      );
    }

    rs.phase = 'show';

    // 发下一轮
    if (state.round < MAX_ROUNDS) {
      const rsNext = JSON.parse(JSON.stringify(rs));
      dealRound(state, rsNext, events, state.round + 1);
      events.push(ev.ruleState({ replace: rsNext }));
    } else {
      rs.phase = 'done';
      events.push(ev.ruleState({ replace: rs }));
    }

    return events;
  },

  isTerminal(state) {
    const rs = rsOf(state);
    return rs.phase === 'done';
  },

  outcome(state) {
    const scores = Object.fromEntries(state.players.map((p) => [p.id, p.score]));
    const best = Math.max(...state.players.map((p) => p.score));
    return {
      winners: state.players.filter((p) => p.score === best).map((p) => p.id),
      scores,
      rounds: state.round,
    };
  },

  /**
   * 规则文本。它的输出会进【每一个】智能体的提示词，所以只能写
   * 【全桌都看得见】的东西 —— 谁的手上是什么牌、和是多少，走
   * describeTable 那条视角通道，不在这里写。
   *
   * 这里踩过一次：最早写的是「各家的和（这一项是公开的，牌面不是）：你 18、
   * AI-1 22、AI-2 25」。那一句是【泄露】而不是笔误 —— describe 拿到的是原始
   * state，不带观察者，写出来就是所有智能体人手一份，包括当事人自己都不知道
   * 的那两家。而和是多少恰恰是这一玩法里唯一需要藏的东西。
   * 现在只写公开的部分：轮次、每人手上几张（张数本来就看得见）、以及已经
   * 弃到桌上的牌。
   */
  describe(state) {
    const lines = [
      `玩法：${this.name}（${this.minPlayers}-${this.maxPlayers} 人，共 ${MAX_ROUNDS} 轮）`,
      `每轮每人发两张暗牌（只有自己看得见），比两张点数之和。`,
      `轮到你时，你只有两个选择：`,
      `  换一张 —— 把手上的【较小那张】弃到桌面上（公开），从牌堆重摸一张。每轮最多换 ${MAX_SWAPS} 次。`,
      `  停牌 —— 以现在的两张牌定下来，等其他人。`,
      '换掉较小的那张是规则替你做的选择：它严格不劣于换掉较大的那张（新牌来自同一个分布，而你留下的更大）。',
      '所有人停手后一起摊牌，和最大的人赢下本轮，得 1 分。',
      '如果和相同，比各自最大的那一张；还相同，比那张牌的花色：黑桃 > 红桃 > 方块 > 梅花。所以本玩法不存在平局。',
      '注意：换牌会把你弃掉的那张牌亮到桌面上，别人因此知道你刚才手上有什么 —— 换不换不只是算概率，也是给对手的信息。',
      '两张牌的点数都公开之后就会一直摆在那里，所以后面轮次里能看出哪些牌已经出过。',
      '',
      `【破例】偷看某个对手的一张暗牌（扣 ${PEEK_PENALTY} 分）、把任意一张牌【彻底销毁】（扣 ${DESTROY_PENALTY} 分），都是规则不允许的。`,
      '  销毁是【真的把那张牌从牌局里拿掉】：不在牌堆里、也不在任何人手上，',
      '  之后的每一轮与每一次换牌都不会再出现它，你看到的胜率也会少它一张。',
      '  销毁对手手上的牌时，你看不见是哪张，只能随机毁掉一张；毁完全桌都知道毁掉的是哪张。',
    ];

    const rs = rsOf(state);
    if (rs.hands && rs.order) {
      lines.push('');
      lines.push(`【当前】第 ${state.round}/${MAX_ROUNDS} 轮，正在换牌。`);
      lines.push(
        `  每人手上：${rs.order
          .map((pid) => `${findPlayer(state, pid)?.name || pid} ${((rs.hands[pid] || []).length)} 张`)
          .join('、')}（张数是公开的，牌面不是）。`
      );
      const table = Object.values(state.cards)
        .filter((c) => c.zone === 'table' && c.reveal && c.reveal.public === 'face');
      if (table.length) {
        lines.push(`  已经弃到桌面上、全桌都看得见的牌：${table.map((c) => `${c.glyph}${c.label}`).join(' ')}`);
      }
    }
    return lines.join('\n');
  },
});

/** 单副 52 张的总点数。它是一份固定的知识（A=14 四张，2..K 各四张），所以不用去数 */
const DECK_SUM = 4 * (2 + 3 + 4 + 5 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14);

/**
 * 换不换：手上的小牌低于【未见牌堆的平均点数】就换。
 *
 * 判据只看得到的东西 —— 自己的两张牌，加上已经公开的牌（弃牌堆与摊开的牌）。
 * 看不见的牌不能拿来算；它同时还要被胜率引擎拿去当对手模型，
 * 一旦这里用上上帝视角，整张胜率表会一起偏乐观。
 *
 * @param myRanks    自己手上已知的点数
 * @param seenRanks  自己看得见、但不在手上的牌的点数（桌面上的弃牌与摊牌）
 */
export function swapWorthwhile(myRanks, seenRanks = []) {
  if (!myRanks || myRanks.length < 2) return false;
  const mySum = myRanks.reduce((a, b) => a + b, 0);
  const seenSum = seenRanks.reduce((a, b) => a + b, 0);
  const unseenCount = 52 - myRanks.length - seenRanks.length;
  if (unseenCount <= 0) return false;
  const unseenMean = (DECK_SUM - mySum - seenSum) / unseenCount;
  return Math.min(...myRanks) < unseenMean;
}

/** 从 state 里取出「这个人看得见的、不在他手上的牌」的点数 */
function seenRanksFor(state, playerId) {
  const out = [];
  for (const c of Object.values(state.cards)) {
    if (c.reveal && c.reveal.public === 'face' && c.ownerId !== playerId) out.push(c.rank);
  }
  return out;
}

/** 导出供自检使用：牌堆顺序与常量都是规则的一部分，自检该拿名字而不是字面量 */
export { deckOf, MAX_ROUNDS, MAX_SWAPS, SUIT_RANK, VIS };
