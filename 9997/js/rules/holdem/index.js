/**
 * index.js — 德州扑克规则包（梭哈）
 *
 * 玩法
 * ------------------------------------------------------------------
 *   2-4 人。每人两张只有自己看得见的底牌，桌上五张公共牌（翻牌 3 张、
 *   转牌 1 张、河牌 1 张），最后用「自己的两张 + 公共的五张」里最好的五张
 *   比大小。一共四轮下注：翻牌前、翻牌、转牌、河牌。
 *   每轮轮到你能做五件事之一：看牌（过牌）/ 跟注 / 加注 / 全下 / 弃牌。
 *
 * 一局 = 一手牌
 * ------------------------------------------------------------------
 * 内核的时序是「本轮 → 结算 → 下一轮」，一个 `state.round` 配一次
 * `resolveRound`。德州正好有四轮下注，所以直接对上：
 *   round 1 翻牌前 → resolveRound 发翻牌 → round 2 …
 *   round 4 河牌   → resolveRound 摊牌结算 → 终局
 * 不另造「第几手牌」这一层嵌套：一局一手，打完了再开一局。
 *
 * 筹码就是 player.score
 * ------------------------------------------------------------------
 * 下注时立刻 `ev.score(pid, -n)` 把筹码从人身上挪进底池，
 * 结算时再 `ev.score(pid, +payout)` 把底池分回去。
 * 好处是「谁还有多少钱」这件事只有一个来源：界面上座位旁边那个数字
 * 就是他的实时筹码；`outcome` 也不用另算，读 score 即可。
 *
 * 但规则包【不读】state.players[].score 来决定判断 —— 它自己记一份
 * `rs.chips`。原因是时序：规则包是在事件被应用【之前】跑的，
 * 刚发出去的那条扣筹码事件此刻还不在 state 里。靠 state 读会静默算错
 * （读到的永远是动作之前的筹码），这正是比大小那份注释里记过的同一个坑。
 * 两份数据由同一段代码同时更新，所以不会漂。
 *
 * 底池按【总投入】分层，不看「谁全下了」这种叙述
 * ------------------------------------------------------------------
 * 具体分层与结算是 pot.js 的事。这里只记一件事：`rs.contrib[pid]`
 * 是【整手牌】投进去的总数，不是「这一轮投了多少」。
 * 这样做的好处是「要跟到多少」有一个统一答案 —— 全桌投入额的最大值。
 * 第一轮投了 20、第二轮对手再加到 30，你需要补的就是 30−20=10，
 * 不需要另开一个「本轮投入」的表，也就不会出现两张表对不上的经典 bug。
 * ------------------------------------------------------------------
 */

import { makeDeck, opaqueDeck, VIS } from '../../core/cards.js';
import {
  act, destroyCandidates, pickDeterministic, registerRuleSet, resolveDestroy, RETURN,
} from '../../core/rules.js';
import { makeRng, shuffle } from '../../core/rng.js';
import { ev } from '../../core/state.js';
import { keyText, score7 } from './eval.js';
import { handStrength, chooseAction } from './policy.js';
import { settleHand } from './pot.js';

/** 一共有几轮下注（翻牌前 / 翻牌 / 转牌 / 河牌） */
const MAX_ROUNDS = 4;

/** 轮次名。下标就是轮次，第 0 项空着，免得处处 −1 */
const STAGE_NAME = ['', '翻牌前', '翻牌', '转牌', '河牌'];

/** 每个人开局的筹码 */
const START_CHIPS = 100;

/** 盲注：小盲 1，大盲 2。大盲同时也是加注的最小增量 */
const SMALL_BLIND = 1;
const BIG_BLIND = 2;

/** 破例代价（单位是筹码，不是分） */
const PEEK_PENALTY = 10;
const DESTROY_PENALTY = 15;

/** 每个阶段【新发】的公共牌张数，下标是阶段 */
const NEW_BOARD = [0, 0, 3, 1, 1];

/** 弃牌按钮上的字。德州里的弃牌只是放弃这一手，不是整局认输 */
const FOLD_LABEL = '弃牌';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const rsOf = (state) => state.ruleState || {};
const findPlayer = (state, id) => state.players.find((p) => p.id === id) || null;
const nameOf = (state, id) => (findPlayer(state, id) || {}).name || id;

const clone = (x) => JSON.parse(JSON.stringify(x));

const faceOf = (state, cid) => {
  const c = state.cards[cid];
  return c ? `${c.glyph}${c.label}` : '一张牌';
};
const facesOf = (state, ids) => (ids || []).map((id) => faceOf(state, id)).join(' ');

/** 手上还剩多少筹码。规则包自己记的那一份，不读 state */
const chipsOf = (rs, pid) => Math.max(0, rs.chips && rs.chips[pid] ? rs.chips[pid] : 0);

/** 还能不能行动：没弃牌，而且还有筹码 */
const canAct = (rs, pid) => !rs.folded[pid] && chipsOf(rs, pid) > 0;

/** 还没弃牌的人 */
const contendersOf = (rs) => (rs.order || []).filter((pid) => !rs.folded[pid]);

/**
 * 这一轮要跟到多少 —— 全桌投入额的最大值。
 *
 * 注意它把【已经弃牌的人】也算进来。看起来该排除，其实不用：
 *   · 弃牌的人若曾经是最大的那个，剩下的人本来也已经跟到了同一水位；
 *   · 真正需要「把弃牌者的钱吐出来」的情形由 pot.js 处理
 *     （超出在局者最高投入的那部分原样退回），与这里无关。
 * 不排除换来的是「这个数一旦算出来就不会再变」，少一类状态。
 */
function levelOf(rs) {
  let m = 0;
  for (const pid of rs.order || []) m = Math.max(m, rs.contrib[pid] || 0);
  return m;
}

/** 还差多少才跟平 */
const needOf = (rs, pid) => Math.max(0, levelOf(rs) - (rs.contrib[pid] || 0));

/** 最小加注增量：一轮开始时是大盲，有人真加注后跟着涨 */
const minRaiseOf = (rs) => Math.max(BIG_BLIND, rs.minRaiseInc || 0);

/** 加注能加到的最低落点（总投入额） */
const raiseFloorOf = (rs) => levelOf(rs) + minRaiseOf(rs);

/** 从某个座位开始绕一圈，找出还能行动的人 */
function actingOrder(rs, seatIdx) {
  const n = (rs.order || []).length;
  const out = [];
  for (let k = 0; k < n; k++) {
    const pid = rs.order[(seatIdx + k) % n];
    if (canAct(rs, pid)) out.push(pid);
  }
  return out;
}

/** 小盲位。两人桌时庄家自己就是小盲，这是唯一一处人数会改变位置规则的地方 */
const sbSeatOf = (rs) => {
  const n = rs.order.length;
  return n === 2 ? rs.dealerSeat % n : (rs.dealerSeat + 1) % n;
};
const bbSeatOf = (rs) => (sbSeatOf(rs) + 1) % rs.order.length;

/** 某个阶段从谁开始行动：翻牌前是大盲的下一位，翻牌后是庄家的下一位 */
const firstSeatOf = (rs, stage) =>
  stage === 1 ? (bbSeatOf(rs) + 1) % rs.order.length : (rs.dealerSeat + 1) % rs.order.length;

/**
 * 有人加注之后，把该重新表态的人排成一队。
 *
 * 为什么是「重建」而不是「把剩下的补进去」：加注把水位抬高，
 * 之前已经跟平的人现在又欠了 —— 他们必须重新拿到行动机会。
 * 重建的判据是「还欠着」而不是「之前做过什么」，所以不需要记录
 * 「谁已经行动过」这类容易对不上的历史。
 */
function reopenQueue(rs, fromPid) {
  const n = rs.order.length;
  const start = (rs.order.indexOf(fromPid) + 1) % n;
  const lvl = levelOf(rs);
  const out = [];
  for (let k = 0; k < n; k++) {
    const pid = rs.order[(start + k) % n];
    if (pid === fromPid) continue;
    if (!canAct(rs, pid)) continue;
    if ((rs.contrib[pid] || 0) >= lvl) continue;
    out.push(pid);
  }
  return out;
}

/** 出队 */
function dequeue(rs, pid) {
  const q = rs.queue || [];
  const i = q.indexOf(pid);
  if (i >= 0) q.splice(i, 1);
  rs.queue = q;
}

/**
 * 每次动作之后的收尾：把不能再行动的人踢出队列。
 *
 * 比别处多一条：只剩一个没弃牌的人时，直接清空队列。
 * 少了这一条，「其他人都弃了、只剩我」的那个人还会被轮一次 ——
 * 他有筹码、也还没弃牌，队列判据上看不出他已经赢了，
 * 于是牌局会继续问他「要不要跟注」，而底池其实已经定了。
 */
function pruneQueue(rs) {
  if (contendersOf(rs).length <= 1) {
    rs.queue = [];
    return;
  }
  rs.queue = (rs.queue || []).filter((pid) => canAct(rs, pid));
}

// ---------------------------------------------------------------------------
// 牌堆
// ---------------------------------------------------------------------------

/**
 * 这一局的牌堆。一局只洗一次、只用一副，所以 salt 固定为 0。
 * id 由种子散列而来，不按「c0、c1……」编号 —— 否则背面牌的 id
 * 一算就知道是哪张牌，投影层保留 id 这件事就漏了。
 */
function deckOf(seed) {
  const deck = makeDeck({ jokers: 0 });
  return opaqueDeck(shuffle(deck, makeRng(seed >>> 0)), seed, 0);
}

/** 这个位置是不是已经被盲烧掉了（见破例「销毁」的牌堆分支） */
const isBurned = (rs, pos) => Array.isArray(rs.burned) && rs.burned.includes(pos);

/** 下一张要发的牌停在哪一格、是什么 */
function peekNextDraw(state, rs) {
  let pos = rs.shoePos;
  while (isBurned(rs, pos)) pos += 1;
  return { pos, card: deckOf(state.seed)[pos] };
}

/**
 * 从牌堆顶上连着取 count 张，跳过被烧掉的位置。
 *
 * 用「顺序取 + 跳位」而不是「按下标切一段」，是为了让盲烧真的有效：
 * 烧掉的那张必须谁也不再拿到，后面的人各往前挪一格。
 */
function drawCards(state, rs, count) {
  const deck = deckOf(state.seed);
  const out = [];
  while (out.length < count) {
    while (isBurned(rs, rs.shoePos)) rs.shoePos += 1;
    out.push(deck[rs.shoePos]);
    rs.shoePos += 1;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 手牌
// ---------------------------------------------------------------------------

function handMapOf(rs) {
  const map = {};
  for (const [pid, ids] of Object.entries(rs.hole || {})) {
    if (Array.isArray(ids) && ids.length) map[pid] = [...ids];
  }
  return map;
}

/** 某个人的底牌（牌对象）—— 只有规则包自己算的时候用，不进提示词 */
function holeCardsOf(state, rs, pid) {
  return (rs.hole[pid] || []).map((id) => state.cards[id]).filter(Boolean);
}

function boardCardsOf(state, rs) {
  return (rs.board || []).map((id) => state.cards[id]).filter(Boolean);
}

/**
 * 摊牌时的比较键。
 *
 * 凑不满五张（底牌或公共牌被销毁过）就没有牌力可言 —— 这时给一个
 * 比任何真牌型都小的键，而不是返回 null。返回 null 会让结算那边
 * 拿不到比较键，整注的钱会凭空少掉（pot.js 里有专门为此立的断言）。
 */
function keyOf(state, rs, pid) {
  const key = score7([...holeCardsOf(state, rs, pid), ...boardCardsOf(state, rs)]);
  return key || [-1];
}

/**
 * 从规则包自己的私有状态位里摘掉一张牌。
 *
 * 内核的 destroy 只保证【手牌】不出现悬空引用；hole / ranks 是规则包
 * 自己的平行数组，内核不认识，也就清不掉。只清一个会让索引整体错位。
 */
function purgeCardFromRuleState(rs, cardId) {
  for (const pid of Object.keys(rs.hole || {})) {
    const ids = rs.hole[pid];
    const keep = [];
    for (let i = 0; i < ids.length; i++) if (ids[i] !== cardId) keep.push(i);
    if (keep.length === ids.length) continue;
    rs.hole[pid] = keep.map((i) => ids[i]);
    if (rs.ranks && rs.ranks[pid]) rs.ranks[pid] = keep.map((i) => rs.ranks[pid][i]);
  }
  if (Array.isArray(rs.board)) rs.board = rs.board.filter((id) => id !== cardId);
  if (Array.isArray(rs.pending)) rs.pending = rs.pending.filter((c) => !c || c.id !== cardId);
}

// ---------------------------------------------------------------------------
// 发牌与开轮
// ---------------------------------------------------------------------------

/** 把 n 枚筹码从某人身上挪进底池。返回实际挪了多少（不够就是全押） */
function commit(rs, pid, amt) {
  const a = Math.max(0, Math.min(Math.round(amt), chipsOf(rs, pid)));
  rs.chips[pid] = chipsOf(rs, pid) - a;
  rs.contrib[pid] = (rs.contrib[pid] || 0) + a;
  rs.pot = (rs.pot || 0) + a;
  return a;
}

/** 发公共牌：登记进牌表 → 摆到桌面上、全桌可见 → 公告 */
function dealBoard(state, rs, stage, events) {
  const cards = drawCards(state, rs, NEW_BOARD[stage]);
  if (!cards.length) return;
  const ids = cards.map((c) => c.id);
  rs.board = [...(rs.board || []), ...ids];
  // 先登记再上桌，顺序不能反：play 的 reducer 是去 state.cards 里查牌改朝向的，
  // 查不到就静默跳过 —— 那 3 张翻牌会既不进牌表也不上桌，且不报错。
  events.push(ev.deal(cards, {}));
  events.push(ev.play(null, ids));
  events.push(ev.announce(null, `${STAGE_NAME[stage]}：${facesOf(state, ids)}`, 'deal'));
}

/** 开一个下注轮：定水位、定最小加注、按座位顺序排出该行动的人 */
function openStage(rs, stage, events) {
  rs.stage = stage;
  rs.minRaiseInc = BIG_BLIND;
  rs.queue = actingOrder(rs, firstSeatOf(rs, stage));
  events.push(
    ev.announce(
      null,
      `${STAGE_NAME[stage]}下注开始 —— 底池 ${rs.pot} 枚，第一个人是 ${rs.queue[0] ? `第 ${rs.order.indexOf(rs.queue[0]) + 1} 座` : '（没有）'}。`,
      'round'
    )
  );
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

function settle(state, rs, events) {
  const order = rs.order || [];
  const contenders = contendersOf(rs);

  let keys = null;
  if (contenders.length > 1) {
    keys = {};
    for (const pid of contenders) keys[pid] = keyOf(state, rs, pid);
  }

  const { payouts, deltas, uncalled, pots } = settleHand(rs.contrib, contenders, keys, order);

  // 摊牌：先把牌亮出来（公开信息），再报数字。
  if (contenders.length > 1) {
    for (const pid of contenders) {
      const ids = rs.hole[pid] || [];
      if (ids.length) events.push(ev.showdown(pid, ids));
    }
  }

  for (const pid of order) {
    const got = payouts[pid] || 0;
    rs.chips[pid] = chipsOf(rs, pid) + got;
    if (got > 0) events.push(ev.score(pid, got));
  }
  rs.pot = 0;
  rs.phase = 'done';

  rs.results = order.map((pid) => ({
    playerId: pid,
    folded: !!rs.folded[pid],
    contrib: rs.contrib[pid] || 0,
    hole: [...(rs.hole[pid] || [])],
    key: keys ? keys[pid] || null : null,
    text: keys && keys[pid] ? keyText(keys[pid]) : '',
    payout: payouts[pid] || 0,
    delta: deltas[pid] || 0,
  }));
  rs.pots = pots.map((p) => ({ amount: p.amount, eligible: [...p.eligible] }));
  rs.uncalled = { ...uncalled };

  // 公告
  if (contenders.length <= 1) {
    const w = contenders[0];
    const total = rs.results.reduce((n, r) => n + r.payout, 0);
    events.push(
      ev.announce(w || null, `${w ? nameOf(state, w) : '没有人'} 是唯一没弃牌的人，直接收下底池 ${total} 枚。`, 'good')
    );
    return;
  }

  const best = rs.results
    .filter((r) => !r.folded)
    .reduce((a, b) => (a && compareKeySafe(a.key, b.key) >= 0 ? a : b), null);
  const detail = rs.results
    .filter((r) => !r.folded)
    .map((r) => `${nameOf(state, r.playerId)} ${r.text || '（凑不满五张）'}`)
    .join('；');
  events.push(ev.announce(null, `摊牌：${detail}`, 'info'));
  if (best) {
    events.push(
      ev.announce(best.playerId, `${nameOf(state, best.playerId)} 以「${best.text}」赢下这一手，收回 ${best.payout} 枚。`, 'good')
    );
  }
  if (Object.keys(uncalled).length) {
    const back = Object.entries(uncalled)
      .map(([pid, n]) => `${nameOf(state, pid)} 的 ${n} 枚`)
      .join('、');
    events.push(ev.announce(null, `没人跟的注额原样退回：${back}。`, 'info'));
  }
}

/** 结算公告里比大小用，避免把 eval 的 compareKey 也 import 进来当两个名字 */
function compareKeySafe(a, b) {
  const n = Math.max((a || []).length, (b || []).length);
  for (let i = 0; i < n; i++) {
    const x = (a || [])[i] === undefined ? -1 : a[i];
    const y = (b || [])[i] === undefined ? -1 : b[i];
    if (x !== y) return x - y;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// 规则包
// ---------------------------------------------------------------------------

export const holdem = registerRuleSet({
  id: 'holdem',
  name: '德州扑克',
  minPlayers: 2,
  maxPlayers: 4,
  multiSelect: false,
  /** 弃牌是这一玩法的正常动作，所以按钮要在 */
  allowFold: true,
  foldLabel: FOLD_LABEL,
  /** 动作不指定牌，点牌没有意义 —— 界面据此只摆按钮 */
  cardGesture: 'none',
  description:
    '每人两张暗牌、桌上五张公共牌，用七张里最好的五张比大小。四轮下注，可以看牌、跟注、加注、全下或弃牌。',
  /** 本地兜底允许弃牌：德州里弃牌就是正常打法，不弃会拿着 7-2 一路跟到底 */
  localPolicyAllowFold: true,

  createDeck() {
    return makeDeck({ jokers: 0 });
  },

  deal(players, seed) {
    // 真正的发牌在 start 里做（要先定庄家与盲注），这个方法只为满足契约。
    return { deck: shuffle(makeDeck({ jokers: 0 }), makeRng(seed)), hands: {} };
  },

  // -------------------------------------------------------------------------
  // 开局
  // -------------------------------------------------------------------------

  start(state) {
    const rs = {};
    const events = [ev.gameStart(this.id), ev.roundStart(1)];
    const order = state.players.map((p) => p.id);
    const n = order.length;

    rs.order = order;
    // 庄家位由种子决定（同种子同座位），不固定在第一个人身上 ——
    // 否则种子对复现之外还多带一个「永远是同一家先当庄」的性质。
    rs.dealerSeat = (state.seed >>> 0) % n;
    rs.stage = 1;
    rs.phase = 'bet';
    rs.shoePos = 0;
    rs.burned = [];
    rs.board = [];
    rs.results = [];
    rs.pots = [];
    rs.uncalled = {};
    rs.pending = [];
    rs.hole = {};
    rs.ranks = {};
    rs.contrib = {};
    rs.chips = {};
    rs.folded = {};
    rs.minRaiseInc = BIG_BLIND;
    rs.pot = 0;
    for (const pid of order) {
      rs.hole[pid] = [];
      rs.ranks[pid] = [];
      rs.contrib[pid] = 0;
      rs.chips[pid] = START_CHIPS;
      rs.folded[pid] = false;
    }

    events.push(
      ev.announce(
        null,
        `一手德州扑克开始：每人 ${START_CHIPS} 筹码，盲注 ${SMALL_BLIND}/${BIG_BLIND}，` +
          `第 ${rs.dealerSeat + 1} 座是庄家。`,
        'deal'
      )
    );
    for (const pid of order) events.push(ev.score(pid, START_CHIPS));

    // 底牌：真牌桌是绕圈发的，一圈一张，转两圈。顺序会改变「哪张牌落在谁手里」，
    // 所以不能图省事一次发两张。
    const fresh = drawCards(state, rs, n * 2);
    fresh.forEach((card, i) => {
      const pid = order[i % n];
      rs.hole[pid].push(card.id);
      rs.ranks[pid].push(card.rank);
    });
    events.push(ev.deal(fresh, handMapOf(rs)));
    events.push(ev.announce(null, '发底牌：每人两张只有自己看得见的暗牌。', 'deal'));

    // 盲注：被迫投注。筹码不够就投剩下的（等于全下）。
    const sbPid = order[sbSeatOf(rs)];
    const bbPid = order[bbSeatOf(rs)];
    const sbAmt = commit(rs, sbPid, SMALL_BLIND);
    events.push(ev.score(sbPid, -sbAmt));
    events.push(ev.announce(sbPid, `${nameOf(state, sbPid)} 下小盲 ${sbAmt} 枚`, 'info'));
    const bbAmt = commit(rs, bbPid, BIG_BLIND);
    events.push(ev.score(bbPid, -bbAmt));
    events.push(ev.announce(bbPid, `${nameOf(state, bbPid)} 下大盲 ${bbAmt} 枚`, 'info'));

    rs.queue = actingOrder(rs, firstSeatOf(rs, 1));
    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  // -------------------------------------------------------------------------
  // 界面文字
  // -------------------------------------------------------------------------

  statusLine(state) {
    const rs = rsOf(state);
    if (rs.phase !== 'bet') {
      return rs.phase === 'done' ? `第 ${MAX_ROUNDS}/${MAX_ROUNDS} 轮 · 这一手已经打完` : '';
    }
    const living = contendersOf(rs).length;
    const turn = state.turn ? ` · 轮到 ${nameOf(state, state.turn)}` : '';
    return `第 ${rs.stage}/${MAX_ROUNDS} 轮（${STAGE_NAME[rs.stage]}） · 底池 ${rs.pot} 枚 · 还剩 ${living} 家在局${turn}`;
  },

  maxActionsPerTurn() {
    // 一次动作就交回合：德州的每个下注轮里每人只表态一次。
    return 1;
  },

  mustEndTurn(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'bet') return true;
    return (rs.queue || [])[0] !== playerId;
  },

  nextTurn(state) {
    const rs = rsOf(state);
    if (rs.phase !== 'bet') return RETURN;
    const q = rs.queue || [];
    return q.length ? q[0] : RETURN;
  },

  turnHint(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'bet') return '这一手已经打完了。';
    if ((rs.queue || [])[0] !== playerId) return '还没轮到你。';
    const need = needOf(rs, playerId);
    const stack = chipsOf(rs, playerId);
    const mine = holeCardsOf(state, rs, playerId);
    const board = boardCardsOf(state, rs);
    const hand = mine.length ? `你手上是 ${facesOf(state, mine.map((c) => c.id))}` : '你手上没有牌了';
    const boardText = board.length ? `，桌上的公共牌是 ${facesOf(state, board.map((c) => c.id))}` : '';
    const callText = need > 0
      ? `还要跟 ${need} 枚才跟平（现在最高下到 ${levelOf(rs)}）`
      : '现在没人下注，你可以看牌';
    return (
      `轮到你：${hand}${boardText}。筹码 ${stack} 枚，${callText}。` +
      `\n用下方按钮决定：看牌 / 跟注 / 加注到 ${raiseFloorOf(rs)} / 全下 / ${FOLD_LABEL}`
    );
  },

  selectionHint() {
    return '这个玩法不靠点牌：动作在下方按钮上（看牌 / 跟注 / 加注 / 全下 / 弃牌）';
  },

  /** 这一玩法没有「过牌」这个动作 —— 每个按钮都会真的推进牌局 */
  needsPassFallback() {
    return false;
  },

  // -------------------------------------------------------------------------
  // 候选动作
  // -------------------------------------------------------------------------

  legalActions(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'bet') return [];
    if ((rs.queue || [])[0] !== playerId) return [];

    const out = [];
    const my = rs.contrib[playerId] || 0;
    const lvl = levelOf(rs);
    const need = Math.max(0, lvl - my);
    const stack = chipsOf(rs, playerId);

    if (need === 0) {
      out.push(act.check('看牌（过牌）：不投筹码，把决定权交给下一位'));
    } else {
      const pay = Math.min(need, stack);
      out.push(
        act.call(
          pay,
          pay < need
            ? `跟注：筹码不够跟平，把剩下的 ${pay} 枚全部押上（等于全下）`
            : `跟注：投入 ${pay} 枚，跟到 ${lvl}（你这一手总共投入 ${lvl}）`
        )
      );
    }

    const floor = raiseFloorOf(rs);
    if (my + stack >= floor) {
      out.push(
        act.raise(
          floor,
          `加注到 ${floor}（比现在的 ${lvl} 高 ${floor - lvl}，你这一手总共投入 ${floor}）`
        )
      );
    }

    // 跟注就已经是全下时不再重复给一个「全下」按钮：两个按钮是同一件事。
    if (stack > 0 && stack > need) {
      out.push(
        act.allin(`全下：把剩下的 ${stack} 枚全部推进底池（你这一手总共投入 ${my + stack}）`)
      );
    }

    out.push(act.fold(`${FOLD_LABEL}：放弃这一手，已经投进底池的 ${my} 枚不退`));
    return out;
  },

  /**
   * 破例动作。
   *   偷看 —— 看某个对手的一张底牌（内容只进你自己的私有记录）
   *   销毁 —— 把任意一张牌从牌局里彻底拿掉（含盲烧牌堆、毁掉对手的底牌）
   */
  breachActions(state, playerId, opts = {}) {
    if (opts.allowBreach === false) return [];
    const rs = rsOf(state);
    if (rs.phase !== 'bet') return [];
    if ((rs.queue || [])[0] !== playerId) return [];

    const out = [];
    for (const other of state.players) {
      if (other.id === playerId) continue;
      if (rs.folded[other.id]) continue;
      const ids = (rs.hole && rs.hole[other.id]) || [];
      if (!ids.length) continue;
      out.push(
        act.breach('peek', {
          from: other.id,
          penalty: PEEK_PENALTY,
          label: `偷看 ${other.name} 的一张底牌（随机一张，代价 ${PEEK_PENALTY} 筹码，全桌都会知道）`,
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

  /**
   * 本地兜底：按底池赔率决定跟、弃还是加。
   *
   * 只能看自己看得见的东西 —— 自己的底牌、桌上的公共牌、公开的下注额。
   * 这里用上帝视角的话，整张胜率表会跟着一起偏乐观，而且没人发现。
   */
  heuristic(state, playerId, actions) {
    const rs = rsOf(state);
    const byType = (t) => actions.find((a) => a.type === t);
    const need = needOf(rs, playerId);
    const raiseAct = byType('raise');
    const strength = handStrength(
      holeCardsOf(state, rs, playerId).map((c) => ({ rank: c.rank, suit: c.suit })),
      boardCardsOf(state, rs).map((c) => ({ rank: c.rank, suit: c.suit }))
    );
    const pick = chooseAction({
      strength,
      toCall: need,
      pot: Math.max(rs.pot || 0, BIG_BLIND),
      canRaise: !!raiseAct,
      raiseTo: raiseAct ? raiseAct.amount : 0,
    });
    return (
      (pick.type === 'raise' && raiseAct) ||
      (pick.type === 'check' && byType('check')) ||
      (pick.type === 'call' && byType('call')) ||
      byType('check') ||
      byType('call') ||
      byType('allin') ||
      byType('fold') ||
      actions[0] ||
      null
    );
  },

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  validate(state, playerId, action, opts = {}) {
    const rs = rsOf(state);
    if (!action || typeof action !== 'object') return { ok: false, reason: '动作必须是一个对象' };
    if (rs.phase !== 'bet') return { ok: false, reason: '这一手已经打完了' };
    if ((rs.queue || [])[0] !== playerId) return { ok: false, reason: '现在轮到的不是你' };

    const my = rs.contrib[playerId] || 0;
    const lvl = levelOf(rs);
    const need = Math.max(0, lvl - my);
    const stack = chipsOf(rs, playerId);

    switch (action.type) {
      case 'fold':
        return { ok: true };

      case 'check':
        if (need > 0) {
          return { ok: false, reason: `现在还不能看牌：你还要跟 ${need} 枚才跟平` };
        }
        return { ok: true };

      case 'call': {
        if (need <= 0) return { ok: false, reason: '现在没有人下注，用「看牌」就行' };
        const pay = Math.min(need, stack);
        // 金额可以省略（规则自己算），但写了就必须对 ——
        // 静默改写模型报的数是不行的，它会以为自己说的就是规则做的。
        if (action.amount !== undefined && Number(action.amount) !== pay) {
          return { ok: false, reason: `跟注要投 ${pay} 枚，不是 ${action.amount} 枚` };
        }
        return { ok: true };
      }

      case 'raise': {
        const target = Number(action.amount);
        if (!Number.isFinite(target)) return { ok: false, reason: '加注必须写清楚加到多少' };
        if (target <= lvl) {
          return { ok: false, reason: `加注要高于现在的 ${lvl}（你现在的投入是 ${my}）` };
        }
        const floor = raiseFloorOf(rs);
        if (target < floor) {
          return { ok: false, reason: `最小加注是加到 ${floor}（现在的 ${lvl} 再加 ${minRaiseOf(rs)}）` };
        }
        if (target > my + stack) {
          return {
            ok: false,
            reason: `你只剩 ${stack} 枚，最多能加到 ${my + stack} 枚；想全押就用「全下」`,
          };
        }
        return { ok: true };
      }

      case 'allin':
        if (stack <= 0) return { ok: false, reason: '你手上没有筹码了' };
        return { ok: true };

      case 'breach': {
        if (opts.allowBreach === false) return { ok: false, reason: '本局禁止破例动作，你必须守规矩' };
        if (action.kind === 'peek') {
          const victim = findPlayer(state, action.from);
          if (!victim) return { ok: false, reason: `找不到要偷看的对手 ${action.from}` };
          if (victim.id === playerId) return { ok: false, reason: '偷看自己的牌没有意义' };
          const ids = (rs.hole && rs.hole[victim.id]) || [];
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
        return { ok: false, reason: '这个玩法没有跳过：看牌、跟注、加注、全下、弃牌，总要选一个' };

      default:
        return { ok: false, reason: `未知动作类型 ${action.type}` };
    }
  },

  // -------------------------------------------------------------------------
  // 执行
  // -------------------------------------------------------------------------

  apply(state, playerId, action, check = {}) {
    const rs = clone(rsOf(state));
    rs.pending = [];
    const events = [];
    const before = levelOf(rs);

    switch (action.type) {
      case 'check': {
        dequeue(rs, playerId);
        events.push(ev.announce(playerId, `${nameOf(state, playerId)} 看牌（过牌）`, 'play'));
        break;
      }

      case 'call': {
        const pay = commit(rs, playerId, needOf(rs, playerId));
        events.push(ev.score(playerId, -pay));
        dequeue(rs, playerId);
        events.push(
          ev.announce(
            playerId,
            rs.contrib[playerId] >= before
              ? `${nameOf(state, playerId)} 跟注 ${pay} 枚（这一手共投入 ${rs.contrib[playerId]}）`
              : `${nameOf(state, playerId)} 筹码不够跟平，把剩下的 ${pay} 枚全押上`,
            'play'
          )
        );
        break;
      }

      case 'raise': {
        const target = Number(action.amount);
        const pay = commit(rs, playerId, target - (rs.contrib[playerId] || 0));
        events.push(ev.score(playerId, -pay));
        rs.minRaiseInc = Math.max(minRaiseOf(rs), target - before);
        rs.queue = reopenQueue(rs, playerId);
        events.push(
          ev.announce(
            playerId,
            `${nameOf(state, playerId)} 加注到 ${target}（多投 ${pay} 枚，这一手共投入 ${rs.contrib[playerId]}）`,
            'play'
          )
        );
        break;
      }

      case 'allin': {
        const stack = chipsOf(rs, playerId);
        const pay = commit(rs, playerId, stack);
        const after = levelOf(rs);
        events.push(ev.score(playerId, -pay));
        if (after > before) {
          /**
           * 全下把水位抬高了，所以它同时也是一次加注。
           *
           * 一条简化：真实的德州里，「全下但不足一个最小加注」不重开加注权
           * （已经跟平的人不能再加）。这里一律重开。
           * 影响是「多给了一个本来不该有的加注机会」，不会算错钱、不会卡死，
           * 而要忠实实现它得再记一张「谁已经行动过」的表 —— 那张表和队列
           * 很容易对不上，代价大于收益。
           */
          rs.minRaiseInc = Math.max(minRaiseOf(rs), after - before);
          rs.queue = reopenQueue(rs, playerId);
          events.push(
            ev.announce(playerId, `${nameOf(state, playerId)} 全下 ${pay} 枚（水位抬到 ${after}）`, 'play')
          );
        } else {
          dequeue(rs, playerId);
          events.push(ev.announce(playerId, `${nameOf(state, playerId)} 全下 ${pay} 枚`, 'play'));
        }
        break;
      }

      case 'fold': {
        rs.folded[playerId] = true;
        dequeue(rs, playerId);
        events.push(ev.fold(playerId));
        events.push(ev.announce(playerId, `${nameOf(state, playerId)} 弃牌（已投的 ${rs.contrib[playerId] || 0} 枚留在底池里）`, 'info'));
        break;
      }

      case 'breach': {
        if (action.kind === 'peek') {
          const victim = findPlayer(state, action.from);
          const ids = (victim && rs.hole[victim.id]) || [];
          if (!ids.length) break;
          // 看哪一张由本地定：候选里说的是「随机一张」，
          // 若让发起者指定具体牌，他就能借这个动作当探针逐张确认。
          const cid = pickDeterministic(ids, state, 31);
          events.push(ev.breach(playerId, 'peek', `偷看了 ${victim.name} 的一张底牌`));
          events.push(ev.privateNote(playerId, `你偷看到 ${victim.name} 手上的一张是 ${faceOf(state, cid)}`));
          rs.chips[playerId] = (rs.chips[playerId] || 0) - PEEK_PENALTY;
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
             * 还没发出去的牌【根本不在 state.cards 里】（牌堆顺序按种子现推），
             * 所以要先把它登记进牌表，否则 destroy 找不到它，投影层也就报不出
             * burned —— 而 burned 正是胜率引擎用来知道「牌堆少了一张」的唯一凭据。
             * 用一个空 hands 的发牌事件登记：牌进了牌表但谁也没拿到。
             */
            const next = peekNextDraw(state, rs);
            cardId = next.card.id;
            face = `${next.card.glyph}${next.card.label}`;
            rs.burned = [...(rs.burned || []), next.pos];
            events.push(ev.deal([next.card], {}));
          } else {
            face = faceOf(state, cardId);
            purgeCardFromRuleState(rs, cardId);
          }

          const origin = r.random
            ? '（从对手手上抽的，抽之前他也不知道是哪张）'
            : r.shoe
              ? '（盲烧的牌堆顶，烧之前他不知道是哪张）'
              : '';
          events.push(ev.breach(playerId, 'destroy', `把 ${face} 从牌局里彻底销毁了${origin}`));
          events.push(ev.destroy(playerId, [cardId], `销毁 ${face}`));
          rs.chips[playerId] = (rs.chips[playerId] || 0) - DESTROY_PENALTY;
          events.push(ev.score(playerId, -DESTROY_PENALTY));
          break;
        }
        break;
      }

      default:
        return [];
    }

    pruneQueue(rs);
    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  // -------------------------------------------------------------------------
  // 轮次收尾
  // -------------------------------------------------------------------------

  isRoundComplete(state) {
    const rs = rsOf(state);
    return rs.phase !== 'bet' || !(rs.queue || []).length;
  },

  /**
   * 一个下注轮结束之后怎么办。
   *
   * 三种去向：
   *   1. 只剩一家没弃牌 → 直接收下底池，不摊牌；
   *   2. 还有得打       → 发下一阶段的公共牌，开新的一轮；
   *   3. 没得打了       → 要么是河牌轮已经打完，要么是所有人都全下了。
   *                       后者要把剩下的公共牌一次发完（真实牌桌也这么干），
   *                       再摊牌 —— 不然后面几轮就成了「没人投钱、
   *                       却也不发牌」的空转。
   */
  resolveRound(state) {
    const rs = clone(rsOf(state));
    const events = [];
    rs.pending = [];

    const contenders = contendersOf(rs);
    const stillBet = contenders.filter((pid) => canAct(rs, pid)).length;

    if (contenders.length > 1 && rs.stage < MAX_ROUNDS && stillBet >= 2) {
      // 正常推进：发下一阶段的公共牌
      const next = rs.stage + 1;
      dealBoard(state, rs, next, events);
      openStage(rs, next, events);
      pruneQueue(rs);
      events.push(ev.ruleState({ replace: rs }));
      return events;
    }

    if (contenders.length > 1 && rs.stage < MAX_ROUNDS) {
      // 都全下了：把剩下的公共牌一次发完，直接摊牌
      for (let st = rs.stage + 1; st <= MAX_ROUNDS; st++) dealBoard(state, rs, st, events);
      events.push(ev.announce(null, '所有人都已经全下 —— 剩下的公共牌一次发完，直接摊牌。', 'info'));
    }

    settle(state, rs, events);
    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  isTerminal(state) {
    return rsOf(state).phase === 'done';
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
   * 【全桌都看得见】的东西 —— 谁的底牌是什么，走 describeTable 那条
   * 视角通道，或者 turnHint（它带观察者），不在这里写。
   *
   * 可以写：轮次、公共牌（已经翻在桌上，人人都看得见）、底池、
   * 每家的筹码与已投入额（筹码堆在桌上，谁都能数）、谁弃了牌、
   * 现在的水位。这些恰好就是真人坐在牌桌上能看到的一切。
   */
  describe(state) {
    const lines = [
      `玩法：${this.name}（梭哈）（${this.minPlayers}-${this.maxPlayers} 人）`,
      `每人发两张只有自己看得见的底牌，桌上还有五张公共牌（翻牌 3 张、转牌 1 张、河牌 1 张）。`,
      '用「自己的两张 + 公共的五张」里最好的五张比大小，牌型从大到小是：',
      '  同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌。',
      `一共四轮下注：${STAGE_NAME.slice(1).join('、')}。每一轮里，轮到你时五选一：`,
      '  看牌（过牌）—— 没人下注时，不投筹码，把决定权交给下一位；',
      `  跟注 —— 投到和当前最高的那家一样多；`,
      `  加注 —— 在最高水位之上再加（最小加注增量是 ${BIG_BLIND} 枚，也就是大盲）；`,
      '  全下 —— 把剩下的筹码一次推进底池；',
      '  弃牌 —— 放弃这一手，已经投进底池的筹码不退。',
      `盲注：翻牌前，庄家左手第一家被迫投小盲 ${SMALL_BLIND} 枚、下一家投大盲 ${BIG_BLIND} 枚，`,
      '  所以一开始底池里就有钱可争。行动从大盲的下一位开始绕圈；翻牌之后从庄家的下一位开始。',
      '底池按【投入额】分层：投入少的人只争得起自己能出的那一层（主池），',
      '  多出来的钱进边池，只有投入够多的人才够格争。',
      '  如果某一家投的比其他人能跟的还多，多出来的那部分没人跟，会原样退给他。',
      '只剩一家没弃牌时，他直接收下底池，不用摊牌。',
      '注意：弃牌之后你之前投进去的筹码就归别人了 —— 弃牌不是「不玩了」，是「放弃这一把的钱」。',
      '',
      `【破例】偷看某个对手的一张底牌（扣 ${PEEK_PENALTY} 筹码）、把任意一张牌【彻底销毁】（扣 ${DESTROY_PENALTY} 筹码），都是规则不允许的。`,
      '  销毁是【真的把那张牌从牌局里拿掉】：不在牌堆里、也不在任何人手上。',
      '  毁掉对手的底牌会让他的七张凑不满，摊牌时牌力按最弱算。',
      '  销毁对手手上的牌时，你看不见是哪张，只能随机毁掉一张；毁完全桌都知道毁掉的是哪张。',
    ];

    const rs = rsOf(state);
    if (!rs.order) return lines.join('\n');

    lines.push('');
    lines.push(
      rs.phase === 'done'
        ? '【当前】这一手已经打完，正在看结果。'
        : `【当前】第 ${rs.stage}/${MAX_ROUNDS} 轮（${STAGE_NAME[rs.stage]}）。底池 ${rs.pot} 枚。`
    );
    const board = rs.board || [];
    if (board.length) lines.push(`  公共牌：${facesOf(state, board)}`);
    else lines.push('  公共牌：还没发（翻牌前）');

    lines.push(
      `  各家筹码：${rs.order
        .map((pid) => {
          const bits = [`${chipsOf(rs, pid)} 枚`, `已投 ${rs.contrib[pid] || 0}`];
          if (rs.folded[pid]) bits.push('已弃牌');
          else if (!canAct(rs, pid)) bits.push('已全下');
          return `${nameOf(state, pid)}（${bits.join('，')}）`;
        })
        .join(' · ')}`
    );
    const live = contendersOf(rs).map((pid) => nameOf(state, pid));
    lines.push(`  还没弃牌：${live.length ? live.join('、') : '（没有了）'}`);
    if (rs.phase === 'bet') {
      lines.push(`  这一轮要跟到 ${levelOf(rs)}；最小加注增量 ${minRaiseOf(rs)}`);
    }
    return lines.join('\n');
  },
});

// ---------------------------------------------------------------------------
// 给自检与胜率评估官用的导出
//
// 这些不是「内部实现不小心漏出来了」，而是【规则本身】：水位怎么算、
// 谁还能行动、下一手从谁开始、加注的地板在哪。
//
// 为什么胜率评估官要拿这份导出而不是自己再写一遍：评估官内部要跑一个
// 轻量的世界（把看不见的牌补全之后接着打完），它必须和真实牌局用同一套
// 判据。各写一份的话会出现「模拟里认为可以加注、真牌桌上却被拒」这种
// 走偏 —— 两处都不报错，只是胜率悄悄偏了，谁也发现不了。所以判据只有
// 这一份，模拟器 import 它。
// ---------------------------------------------------------------------------

export {
  MAX_ROUNDS, STAGE_NAME, START_CHIPS, SMALL_BLIND, BIG_BLIND,
  PEEK_PENALTY, DESTROY_PENALTY, NEW_BOARD, FOLD_LABEL,
  deckOf, levelOf, needOf, minRaiseOf, raiseFloorOf, chipsOf, canAct, contendersOf,
  actingOrder, reopenQueue, dequeue, pruneQueue,
  sbSeatOf, bbSeatOf, firstSeatOf, VIS,
};
