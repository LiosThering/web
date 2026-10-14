/**
 * index.js — 21 点规则包
 *
 * 玩法
 * ------------------------------------------------------------------
 *   1-3 名玩家 + 一名荷官（庄家）。单副 52 张，用完重洗。
 *   每手牌：每人两张起手，庄家一张明牌、一张暗牌。
 *   玩家依次决定【要牌 / 停牌 / 双倍 / 分牌】，全部停手后轮到庄家。
 *   庄家 17 点以下必须要牌、17 点及以上停（S17）；明牌是 A 或 10 时先偷看暗牌，
 *   是黑杰克就当场收局（美式规则）。
 *   比点数：赢 1 注、平 0、输 −1 注；天然 21 点赔 1.5 注；
 *   双倍 = 只补一张、注翻倍；分牌 = 拆成两手、各补一张（分 A 只补一张）。
 *   一共 6 手，最后按净胜注数排名。
 *
 * 三条规则选择，改了结果就会变，所以写在这里而不是埋在代码里
 * ------------------------------------------------------------------
 *   · 庄家偷看（peek）—— 有它「11 对 10」才是双倍。没有它就不是。
 *     这一条实测差到能翻转最优动作，见 exact.js 的说明。
 *   · 庄家软 17 停（S17）—— H17 会让庄家更强，若干格子会跟着变。
 *   · 只准分一次（两手），分 A 之后只补一张且不能再要。
 *
 * 庄家是怎么表示的（值得单独说）
 * ------------------------------------------------------------------
 * 荷官【是一个座位】，不是玩家：它不出现在人数下拉框里、不建智能体、
 * 永远轮不到它行动。这么做换来三件事：
 *   · 它的牌走的是正常的投影通道 —— 暗牌自动不带牌面字段，渲染层直接能画，
 *     不需要为「庄家」在投影/渲染/提示词里各开一个口子；
 *   · `describeTable` 会如实告诉每个人「庄家：2 张，其中已亮出的有 ♠7」，
 *     连暗牌的存在都说得清楚，而且不会泄露它是什么；
 *   · 它的牌通过 system 级的发牌事件入场，不会把牌面写进任何公开记录。
 * ------------------------------------------------------------------
 */

import { makeDeck, opaqueDeck, rankLabel, VIS, nextVisibility, visibilityOf, VIS_META } from '../../core/cards.js';
import { act, destroyCandidates, registerRuleSet, resolveDestroy, RETURN } from '../../core/rules.js';
import { makeRng, shuffle } from '../../core/rng.js';
import { applyEvents, ev } from '../../core/state.js';
import {
  ACE_RANK, faceValue, handTotal, isBust, isNatural, isPair, groupOfRank,
} from './hand.js';
import { evaluateHand, NATURAL_BET } from './exact.js';
import { buildTable, lookupTable } from './strategy.js';

/** 荷官座位 id。它不是玩家，但必须在 state.players 里才走得到投影。 */
export const DEALER_ID = 'dealer';

/** 一共打几手牌 */
const MAX_ROUNDS = 6;

/** 单副牌用掉多少张就重洗（留一点余量，免得算到一半没牌） */
const RESHUFFLE_AT = 40;

/** 一回合内最多行动几次（一手牌可能连续要很多张） */
const MAX_ACTIONS_PER_TURN = 12;

/** 破例代价：偷看一次扣半注 */
const PEEK_PENALTY = 0.5;

/**
 * 破例代价：销毁一张牌扣 1 注。
 *
 * 定价要压过偷看（半注）。偷看买到的是【信息】：那张牌还在牌桌上，
 * 庄家该拿还是拿得到；销毁买到的是【改变牌局】：那张牌直接不在外面了。
 * 代价定得比偷看低，销毁就会变成严格支配偷看的动作，选择也就不存在了。
 */
const DESTROY_PENALTY = 1;

/** 一手牌的起手注 */
const BASE_BET = 1;

function findPlayer(state, id) {
  return state.players.find((p) => p.id === id) || null;
}

function rsOf(state) {
  return state.ruleState || {};
}

function cardOf(state, cid) {
  return state.cards[cid] || null;
}

/**
 * 牌 → 牌面文字。可以直接给牌 id，也可以直接给一张牌对象。
 *
 * 给牌对象这条路是必须的：本批次刚摸到的牌还没进 state，
 * 拿 id 去查只会得到一句「一张牌」。规则包手上正好有那个对象，所以让它能直接传。
 */
function labelOf(state, ref) {
  const c = ref && typeof ref === 'object' ? ref : cardOf(state, ref);
  return c ? `${c.glyph}${c.label}` : '一张牌';
}

function labelList(state, refs) {
  return (refs || []).map((r) => labelOf(state, r)).join(' ');
}

/**
 * 造一个取值器，额外认识这一批刚发的牌。
 * playDealer 要一次报出庄家所有牌，其中一部分就在本批次里没进 state，靠它兜住。
 */
function labeler(state, drawn = []) {
  const extra = drawn && drawn.length ? new Map(drawn.map((c) => [c.id, c])) : null;
  return (ref) => {
    const c = ref && typeof ref === 'object'
      ? ref
      : (state.cards[ref] || (extra && extra.get(ref)) || null);
    return c ? `${c.glyph}${c.label}` : '一张牌';
  };
}

/** 一手牌的点数。牌点由手牌自己携带，不回查 state —— 理由见 makeHand */
function totalOf(hand) {
  return handTotal(hand && hand.ranks ? hand.ranks : []);
}

// ---------------------------------------------------------------------------
// 牌堆：只存「用掉几张」，不存顺序
// ---------------------------------------------------------------------------

/**
 * 取出第 shoeNo 副牌的顺序。
 *
 * 关键设计：牌堆顺序【从不进入任何事件】。ruleState 里只记「第几副、用掉几张」，
 * 顺序由种子现推。理由是黑杰克最敏感的信息就是「下一张是什么」——
 * 庄家的暗牌、玩家下一张要到的牌全在牌堆顶上。把它写进事件里，
 * 等于把整局牌摊在记录里等人去读。
 *
 * 编号带上 shoeNo（opaqueDeck 的 salt）：重洗后旧牌还躺在桌上，
 * 两副牌共用 id 会互相覆盖。顺带让 id 读不出点数。
 */
function shoeOf(seed, shoeNo) {
  const deck = makeDeck({ jokers: 0 });
  let h = (seed >>> 0) ^ Math.imul((shoeNo | 0) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return opaqueDeck(shuffle(deck, makeRng(h)), seed, (shoeNo | 0) + 1);
}

/**
 * 这一副牌里，哪些位置已经被烧掉了。
 *
 * 为什么需要它：牌堆顺序是【按种子现推】的（见 shoeOf），不是存在 state 里的。
 * 所以「把一张还没发的牌删掉」不能靠从 state.cards 里划掉 —— 那一张
 * 下次照样会被 drawOne 抽出来。必须记下「第几副的第几个位置没了」，
 * 由 drawOne 跳过。位置表按副编号分组，重洗之后互不干扰。
 */
function burnedPositions(rs, shoeNo) {
  const b = rs.burned || {};
  const list = b[shoeNo];
  return Array.isArray(list) ? list : null;
}

function isBurned(rs, shoeNo, pos) {
  const list = burnedPositions(rs, shoeNo);
  return !!list && list.includes(pos);
}

/** 从牌堆顶上取一张（可能触发重洗，并跳过已经烧掉的位置） */
function drawOne(state, rs) {
  // 循环而不是 if：烧掉的位置要跳过，跳过去可能刚好跨过重洗的界线。
  for (;;) {
    if (rs.shoePos >= RESHUFFLE_AT || rs.shoePos >= 52) {
      rs.shoeNo += 1;
      rs.shoePos = 0;
      rs.reshuffled = true;
    }
    if (!isBurned(rs, rs.shoeNo, rs.shoePos)) break;
    rs.shoePos += 1;
  }
  const shoe = shoeOf(state.seed, rs.shoeNo);
  const card = shoe[rs.shoePos];
  rs.shoePos += 1;
  return card;
}

/**
 * 【下一次抽牌】会抽到哪一张，以及它在哪一副的哪个位置。
 *
 * 盲烧牌堆用的就是它：先把「下一张」算出来（这一步要跟着 drawOne 的
 * 重洗与跳位规则走，不能自己另写一份判断，否则两处想的不是同一张牌），
 * 再把这个位置记进烧位表。
 */
function peekNextDraw(state, rs) {
  const probe = {
    shoeNo: rs.shoeNo,
    shoePos: rs.shoePos,
    reshuffled: false,
    burned: rs.burned,
  };
  for (;;) {
    if (probe.shoePos >= RESHUFFLE_AT || probe.shoePos >= 52) {
      probe.shoeNo += 1;
      probe.shoePos = 0;
    }
    if (!isBurned(probe, probe.shoeNo, probe.shoePos)) break;
    probe.shoePos += 1;
  }
  const shoe = shoeOf(state.seed, probe.shoeNo);
  return { shoeNo: probe.shoeNo, pos: probe.shoePos, card: shoe[probe.shoePos] };
}

/**
 * 庄家的明牌。它是「庄家的公开信息」这个概念的载体 ——
 * 【不能销毁】：暗牌会顶到第一张，而 upcardRank 读的正是 ranks[0]，
 * 于是引擎会把暗牌的点数当成明牌来用。那等于白送一次偷看，
 * 而且是所有走射程的候选一起变准，不会有任何报错。
 */
function dealerUpcardId(rs) {
  const h = dealerHand(rs);
  return h.cards.length ? h.cards[0] : null;
}

/**
 * 从规则包自己的私有状态位里把一张牌摘干净。
 *
 * 内核只保证【手牌】不出现悬空引用（见 state.js 的 destroy）。
 * hands / dealer / pending 这些都是规则包自己存的结构，内核不认识，
 * 所以必须由这里负责。漏掉的后果是静默的：cards 与 ranks 是两个平行数组，
 * 只删一个会让后面的点数全部错位 —— 那手牌会算出一个不存在的点数。
 */
function purgeCardFromRuleState(rs, cardId) {
  const strip = (hand) => {
    if (!hand || !Array.isArray(hand.cards)) return;
    const keep = [];
    for (let i = 0; i < hand.cards.length; i++) {
      if (hand.cards[i] !== cardId) keep.push(i);
    }
    if (keep.length === hand.cards.length) return;
    hand.cards = keep.map((i) => hand.cards[i]);
    // ranks 与 cards 一一对应：索引必须【同一批】过滤，
    // 否则剩下的 ranks 会整体错位，点数悄悄算错。
    hand.ranks = keep.map((i) => hand.ranks[i]);
  };
  for (const h of rs.hands || []) strip(h);
  if (rs.dealer && rs.dealer.hand) strip(rs.dealer.hand);
  if (Array.isArray(rs.pending)) rs.pending = rs.pending.filter((c) => !c || c.id !== cardId);
}

/**
 * 摸一张牌给这手牌，并把「这一批新发出的牌」记下来，
 * 最后统一发一个 system 级发牌事件。
 *
 * 牌点是【这里】记下的 —— 见 makeHand 的说明：此刻这张牌还没进 state。
 */
function take(state, rs, hand) {
  const card = drawOne(state, rs);
  hand.cards.push(card.id);
  hand.ranks.push(card.rank);
  rs.pending.push(card);
  return card;
}

// ---------------------------------------------------------------------------
// 手牌结构
// ---------------------------------------------------------------------------

/**
 * 手牌。
 *
 * 【为什么要同时存 ranks】—— 这是一个真踩过的坑，写在这里免得后人改回去。
 *
 * 规则包算牌点的时候，如果去查 state.cards，就会算错：规则包是在事件
 * 【被应用之前】跑的，它这一批刚要发出去的牌此刻还不在 state 里。
 * 后果不是报错，是静默算错：
 *   · 玩家要到的牌不参与爆牌判定 —— 拿到 22 点也不会爆；
 *   · 庄家补到的牌不参与 17 点判定 —— 它会一直补到守卫上限；
 *   · 庄家明牌是 A/10 时的偷看分支永远不触发（因为读到的点数是 undefined）。
 * 而且牌局照样跑完、分数照样守恒，只有胜率悄悄偏掉。
 *
 * 所以：牌点由规则包自己维护，与牌 id 并排存放，谁摸到牌谁负责记。
 * 只有【已经进过 state 的牌】（明牌、上一轮摊开的牌）才回查 state 取牌面文字。
 */
function makeHand(ownerId, ids = [], ranks = [], opts = {}) {
  return {
    ownerId,
    cards: [...ids],
    ranks: [...ranks],
    bet: opts.bet ?? BASE_BET,
    doubled: false,
    done: false,
    fromSplit: !!opts.fromSplit,
    /** 分 A 之后每边只补一张，不能再要也不能双倍 */
    frozen: !!opts.frozen,
    bust: false,
    blackjack: false,
    outcome: null,
    delta: 0,
  };
}

function activeHand(rs) {
  return rs.hands[rs.active] || null;
}

/**
 * 荷官那手牌。它也是一个普通的手牌对象 ——
 * 于是「摸牌记点数」「算总点」「摊牌」三条路对庄家和玩家完全一样，
 * 不需要为庄家各写一份（写两份就一定会有一份忘了改）。
 */
function dealerHand(rs) {
  return rs.dealer && rs.dealer.hand ? rs.dealer.hand : makeHand(DEALER_ID, [], []);
}

/** 每个玩家当前手持的全部牌（分牌之后是两手的并集），用来同步到座位投影 */
function handMapOf(rs, players) {
  const map = {};
  for (const p of players) {
    const ids = rs.hands.filter((h) => h.ownerId === p.id).flatMap((h) => h.cards);
    if (ids.length) map[p.id] = ids;
  }
  const dc = dealerHand(rs).cards;
  if (dc.length) map[DEALER_ID] = [...dc];
  return map;
}

function dealerTotal(rs) {
  return totalOf(dealerHand(rs));
}

/** 庄家明牌（第一张）的牌面点数。取自己记的点数，不回查 state */
function upcardRank(rs) {
  const h = dealerHand(rs);
  return h.ranks.length ? h.ranks[0] : null;
}

// ---------------------------------------------------------------------------
// 未见牌堆：这份实现【不】放在这里
// ---------------------------------------------------------------------------
//
// 「只看观察者看得见的牌，推出未见牌堆」这件事有两处会用到：规则包自己
// 算本地兜底、胜率引擎算精确解。放在两个地方各写一份的代价实测过 ——
// 两边的函数名一模一样，返回值却一个是【计数向量】、一个是
// { counts, visible } 对象，于是「拿规则包那份去读 .counts」得到
// undefined，一路传到精确引擎的计数键里才炸。
//
// 所以只留引擎那一份（engine/blackjack-judge.js 的 unseenFromView），
// 它多做三件规则包不需要但引擎必须做的事：按牌堆编号过滤、按 id 去重、
// 把桌面上摊开的牌也算进「看得见」。规则包内不再放第二份。

// ---------------------------------------------------------------------------
// 发一手新的牌
// ---------------------------------------------------------------------------

/**
 * 发一手新的牌。
 *
 * roundNo 必须显式传进来，不能用 state.round —— 因为「发下一手」这件事发生在
 * resolveRound 里，而内核要到那之后才推进 state.round。读 state.round 会永远
 * 慢一拍（第一手会写成「第 0 手」），且不报错，只是公告上的数字悄悄错了。
 */
function dealRound(state, rs, events, roundNo) {
  const players = state.players.filter((p) => p.id !== DEALER_ID);

  rs.handNo = roundNo;
  rs.hands = [];
  rs.active = 0;
  rs.results = [];
  rs.reshuffled = false;
  rs.dealer = { hand: makeHand(DEALER_ID, [], []), revealed: false, natural: false, total: null };
  rs.pending = [];

  const dHand = rs.dealer.hand;
  const fresh = players.map((p) => makeHand(p.id));
  rs.hands = fresh;

  // 真牌桌是轮着发的：每人一张、庄家一张，转两圈。
  // 顺序会影响「哪张牌落在谁手里」，所以不能图省事一次发两张。
  let upcard = null;
  let hole = null;
  for (let round = 0; round < 2; round++) {
    for (const h of fresh) take(state, rs, h);
    const dc = take(state, rs, dHand);
    if (round === 0) upcard = dc; else hole = dc;
  }

  events.push(
    ev.announce(null, `第 ${roundNo} 手发牌：各两张，庄家明牌 ${labelOf(state, upcard)}`, 'deal')
  );
  events.push(ev.deal(rs.pending, handMapOf(rs, state.players)));
  // 庄家明牌对全桌公开；暗牌保持「谁都看不见」（它是庄家自己的牌，
  // 而庄家不是一个观察者，所以没有任何视角能读到它）
  events.push(ev.reveal(DEALER_ID, upcard.id, VIS.ALL, '亮出明牌'));
  rs.pending = [];

  // 天然 21 点判定
  for (const h of rs.hands) {
    h.blackjack = isNatural(h.ranks);
    if (h.blackjack) h.done = true;
  }
  rs.dealer.natural = isNatural(dHand.ranks);

  // 庄家偷看：明牌是 A 或 10 才有意义
  const upValue = faceValue(dHand.ranks[0]);
  if (upValue === 11 || upValue === 10) {
    if (rs.dealer.natural) {
      rs.phase = 'settle';
      for (const h of rs.hands) h.done = true;
      events.push(ev.announce(null, `庄家亮出黑杰克（${labelOf(state, upcard)} ${labelOf(state, hole)}），这一手到此为止`, 'dealer'));
    } else {
      rs.phase = 'play';
      events.push(ev.announce(null, '庄家看了暗牌（不是黑杰克），继续', 'dealer'));
    }
  } else {
    rs.phase = 'play';
  }

  rs.active = rs.hands.findIndex((h) => !h.done);
  if (rs.active < 0) rs.active = rs.hands.length;
}

// ---------------------------------------------------------------------------
// 庄家补牌与结算
// ---------------------------------------------------------------------------

function playDealer(state, rs, events) {
  const dHand = dealerHand(rs);
  /** 这一轮庄家自己补的牌（本批次还没进 state，报牌面文字要用） */
  const drawn = [];

  // 亮暗牌
  if (!rs.dealer.revealed) {
    rs.dealer.revealed = true;
    if (dHand.cards.length > 1) {
      events.push(ev.reveal(DEALER_ID, dHand.cards[1], VIS.ALL, '翻开暗牌'));
    }
    events.push(ev.deal([], handMapOf(rs, state.players)));
  }

  let guard = 0;
  while (true) {
    // 17 点及以上停（S17：软 17 也停）。点数读的是手牌自己记的 ranks，
    // 所以刚补进来的那张一定算得进去 —— 回查 state 会漏掉它，庄家会一直补到守卫上限。
    if (totalOf(dHand).total >= 17 || guard >= 12) break;
    const card = take(state, rs, dHand);
    drawn.push(card);
    events.push(ev.deal(rs.pending, handMapOf(rs, state.players)));
    rs.pending = [];
    events.push(
      ev.announce(null, `庄家补到 ${labelOf(state, card)}（现在 ${totalOf(dHand).total} 点）`, 'dealer')
    );
    guard++;
  }
  rs.dealer.total = totalOf(dHand).total;
  const say = labeler(state, drawn);
  events.push(
    ev.announce(
      null,
      rs.dealer.total > 21
        ? `庄家 ${dHand.cards.map(say).join(' ')} —— ${rs.dealer.total} 点，爆牌`
        : `庄家 ${dHand.cards.map(say).join(' ')} —— ${rs.dealer.total} 点`,
      'dealer'
    )
  );
}

/**
 * 一手牌对庄家的输赢（以「注」为单位，不含天然 21 点的 1.5 倍）。
 *
 * 三种平局要分清，它们容易写成一种：
 *   · 我爆牌 → 我输，且不参与比点
 *   · 两边同为 21 点 → 平（我的天然对他的天然也是平）
 *   · 他爆牌 → 我赢
 */
function settleHand(rs, hand) {
  const t = totalOf(hand);
  const dealer = rs.dealer;
  hand.total = t.total;

  if (t.total > 21) return { outcome: 'bust', delta: -hand.bet };

  if (dealer.natural) {
    // 庄家黑杰克：只有我的天然 21 点能平，其余全输
    return hand.blackjack
      ? { outcome: 'push', delta: 0 }
      : { outcome: 'lose', delta: -hand.bet };
  }

  if (dealer.total > 21) {
    return { outcome: hand.blackjack ? 'blackjack' : 'win', delta: hand.blackjack ? hand.bet * NATURAL_BET : hand.bet };
  }

  if (t.total > dealer.total) {
    return { outcome: hand.blackjack ? 'blackjack' : 'win', delta: hand.blackjack ? hand.bet * NATURAL_BET : hand.bet };
  }
  if (t.total < dealer.total) return { outcome: 'lose', delta: -hand.bet };
  return { outcome: 'push', delta: 0 };
}

// ---------------------------------------------------------------------------
// 规则包
// ---------------------------------------------------------------------------

/** 本地兜底用的策略表，第一次用到时才建（约 20ms） */
let tableCache = null;
function strategyTable(infinite = true) {
  if (!tableCache) tableCache = buildTable({ infinite, peek: true });
  return tableCache;
}

export const blackjack = registerRuleSet({
  id: 'blackjack',
  name: '21 点',
  minPlayers: 1,
  maxPlayers: 3,
  multiSelect: false,
  allowFold: false,
  /** 动作不指定牌，所以点牌没有意义 —— 界面据此把动作摆成按钮，并隐藏「出牌」 */
  cardGesture: 'none',
  description: '单副牌，1-3 人对庄家。要牌凑到 21 点但不爆，比庄家更接近 21 就赢。',

  createDeck() {
    return makeDeck({ jokers: 0 });
  },

  /** 荷官：不是玩家，但要有座位才走得到投影与渲染 */
  extraSeats() {
    return [{ id: DEALER_ID, name: '庄家', isHuman: false, role: 'dealer' }];
  },

  deal(players, seed) {
    // 内核契约要求有这么个方法；真正的发牌在 start / resolveRound 里做，
    // 因为一手牌要发很多次（每次要牌都是一次发牌），一次性发不出来。
    const deck = shuffle(makeDeck({ jokers: 0 }), makeRng(seed));
    return { deck, hands: {} };
  },

  start(state) {
    const rs = {
      shoeNo: 0,
      shoePos: 0,
      phase: 'play',
      hands: [],
      active: 0,
      dealer: { hand: makeHand(DEALER_ID, [], []), revealed: false, natural: false, total: null },
      pending: [],
      results: [],
      reshuffled: false,
      handNo: 1,
      /** 已经烧掉的位置：{ [副编号]: [位置, ...] }。见 burnedPositions */
      burned: {},
    };
    const events = [ev.gameStart(this.id), ev.roundStart(1)];
    dealRound(state, rs, events, 1);
    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  statusLine(state) {
    const rs = rsOf(state);
    if (!rs.hands || !rs.hands.length) return '';
    const d = rs.dealer || {};
    const dh = dealerHand(rs);
    const up = state.cards[dh.cards[0]] ? labelOf(state, dh.cards[0]) : '?';
    const revealed = d.revealed && dh.ranks.length ? `共 ${totalOf(dh).total} 点` : '另有 1 张暗牌';
    return `第 ${state.round}/${MAX_ROUNDS} 手 · 庄家明牌 ${up}（${revealed}）`;
  },

  maxActionsPerTurn() {
    return MAX_ACTIONS_PER_TURN;
  },

  /**
   * 轮到人类时的提示语。
   * 必须由规则包自己写：通用那句是「左键点牌出牌」，而 21 点的动作
   * 根本不指定牌 —— 照那句话提示，玩家会一直点牌、一直被自己的规则拒绝，
   * 而真正的入口（下方按钮）他看不见。
   */
  turnHint(state) {
    const rs = rsOf(state);
    const h = activeHand(rs);
    if (!h) return '这一手已经打完了，正在结算。';
    const t = totalOf(h);
    const up = upcardRank(rs);
    const soft = t.soft ? '（软）' : '';
    const upText = up === null ? '庄家' : `庄家明牌 ${rankLabel(up)}`;
    const many = rs.hands.length > 1 ? ` · 第 ${Math.min(rs.active + 1, rs.hands.length)}/${rs.hands.length} 手` : '';
    return `轮到你了：现在 ${t.total} 点${soft}，对 ${upText}${many} —— 用下方按钮决定「要牌 / 停牌 / 双倍 / 分牌」`;
  },

  /** 21 点不按牌出手，所以选中什么都不该有提示 */
  selectionHint() {
    return '这个玩法不靠点牌出手：动作在下方按钮上';
  },

  /**
   * 不补「过牌」记录。
   * 21 点没有「过牌」这个动作；玩家不动作就是还在想，补一条过牌只会
   * 在时间线上留下一句不存在的事，还会让模型以为「他这一手跳过了」。
   */
  needsPassFallback() {
    return false;
  },

  mustEndTurn(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return true;
    return !rs.hands.some((h) => h.ownerId === playerId && !h.done);
  },

  nextTurn(state) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return RETURN;
    const h = rs.hands[rs.active];
    if (!h || h.done) {
      const next = rs.hands.findIndex((x) => !x.done);
      if (next < 0) return RETURN;
      return rs.hands[next].ownerId;
    }
    return h.ownerId;
  },

  // -------------------------------------------------------------------------
  // 候选动作
  // -------------------------------------------------------------------------

  legalActions(state, playerId) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return [];
    const h = activeHand(rs);
    if (!h || h.ownerId !== playerId || h.done) return [];

    const t = totalOf(h);
    const n = h.cards.length;
    const out = [];

    if (t.total < 21) {
      if (!h.frozen) {
        out.push(act.hit(`要牌（现在 ${t.total} 点，再来一张）`));
      }
      if (n === 2 && !h.frozen) {
        out.push(act.double(`双倍（只再要一张，注翻倍：${h.bet} → ${h.bet * 2} 注，赢了两倍收）`));
      }
      if (n === 2 && !h.fromSplit && rs.hands.length < 2 && isPair(h.ranks)) {
        const pv = faceValue(h.ranks[0]);
        out.push(act.split(`分牌（把两张 ${pv === 11 ? 'A' : pv} 拆成两手，各补一张，总注 2 注）`));
      }
    }
    out.push(act.stand(`停牌（以 ${t.total} 点结束这一手）`));
    return out;
  },

  /** 破例：偷看庄家的暗牌、销毁任意一张牌。代价自担，一律全桌公示。 */
  breachActions(state, playerId, opts = {}) {
    if (opts.allowBreach === false) return [];
    const rs = rsOf(state);
    const h = activeHand(rs);
    if (rs.phase !== 'play' || !h || h.ownerId !== playerId) return [];

    const out = [];
    // 「暗牌」是偷看的唯一目标。暗牌被销毁之后这一手上就没有第二张牌了，
    // 再给出偷看候选，选中它只会往私有记录里写一句「你偷看到的是一张牌」。
    if (!rs.dealer.revealed && dealerHand(rs).cards.length >= 2) {
      out.push(
        act.breach('peek', {
          penalty: PEEK_PENALTY,
          label: `偷看庄家的暗牌（代价 ${PEEK_PENALTY} 注，全桌都会知道）`,
        })
      );
    }
    // allowShoe：这一玩法的牌堆是「抽一张少一张」，所以「还没发的牌」
    // 在这里是真实存在的目标 —— 盲烧牌堆顶。
    out.push(
      ...destroyCandidates(state, playerId, {
        penalty: DESTROY_PENALTY,
        allowShoe: true,
        allow: (_st, cid) => cid !== dealerUpcardId(rs),
      })
    );
    return out;
  },

  /**
   * 本地兜底策略（没 API Key 时用）。
   *
   * 用「无限牌堆 + 偷看」口径的策略表 —— 它和真实对局的差别只在
   * 「已经出了哪些牌」那一层，而那一层的影响很小；真要看精确值，
   * 胜率引擎会给（它是有限牌堆口径）。
   */
  heuristic(state, playerId, actions) {
    const rs = rsOf(state);
    const h = activeHand(rs);
    if (!h || h.ownerId !== playerId) return actions[0] || null;
    const up = upcardRank(rs);
    const hit = lookupTable(strategyTable(), h.ranks, up);
    const want = hit ? hit.action : 'stand';

    const byType = (t) => actions.find((a) => a.type === t);
    // 表说双倍但双倍不在候选里（比如手里已经三张）就退到要牌 / 停牌
    if (want === 'double') return byType('double') || byType('hit') || byType('stand');
    if (want === 'split') return byType('split') || byType('hit') || byType('stand');
    if (want === 'hit') return byType('hit') || byType('stand');
    return byType('stand') || actions[0];
  },

  // -------------------------------------------------------------------------
  // 校验
  // -------------------------------------------------------------------------

  validate(state, playerId, action, opts = {}) {
    const rs = rsOf(state);
    if (rs.phase !== 'play') return { ok: false, reason: '现在不是玩家行动的阶段' };
    if (!action || typeof action !== 'object') return { ok: false, reason: '动作必须是一个对象' };

    const h = activeHand(rs);
    if (!h) return { ok: false, reason: '现在没有正在行动的手牌' };
    if (h.ownerId !== playerId) return { ok: false, reason: '现在轮到的不是你' };

    const legal = this.legalActions(state, playerId);
    const same = (t) => legal.some((a) => a.type === t);

    switch (action.type) {
      case 'hit':
        if (h.frozen) return { ok: false, reason: '分 A 之后每边只补一张，不能再要牌' };
        if (totalOf(h).total >= 21) return { ok: false, reason: '已经 21 点，不能再要牌' };
        return { ok: true };
      case 'stand':
        return { ok: true };
      case 'double':
        if (h.cards.length !== 2) return { ok: false, reason: '双倍只能在起手两张时使用' };
        if (h.frozen) return { ok: false, reason: '分 A 之后不能双倍' };
        return { ok: true };
      case 'split':
        if (h.cards.length !== 2) return { ok: false, reason: '分牌只能在起手两张时使用' };
        if (!isPair(h.ranks)) return { ok: false, reason: '这两张牌不一样，不能分' };
        if (h.fromSplit) return { ok: false, reason: '本玩法只允许分一次' };
        if (rs.hands.length >= 2) return { ok: false, reason: '已经分成两手了' };
        return { ok: true };
      case 'breach': {
        if (opts.allowBreach === false) return { ok: false, reason: '本局禁止破例动作，你必须守规矩' };
        if (action.kind === 'peek') {
          if (rs.dealer.revealed) return { ok: false, reason: '庄家的暗牌已经翻开了，不用偷看' };
          if (dealerHand(rs).cards.length < 2) return { ok: false, reason: '庄家这一手已经没有暗牌了' };
          return { ok: true, breach: true, kind: 'peek', penalty: PEEK_PENALTY };
        }
        if (action.kind === 'destroy') {
          const r = resolveDestroy(state, playerId, action, {
            allow: (_st, cid) => cid !== dealerUpcardId(rs),
          });
          if (!r.ok) return { ok: false, reason: r.reason };
          return { ok: true, breach: true, kind: 'destroy', penalty: DESTROY_PENALTY };
        }
        return { ok: false, reason: `未定义的破例类型 ${action.kind}` };
      }
      case 'pass':
        return same('stand') ? { ok: true } : { ok: false, reason: '现在不能跳过' };
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

    const flush = () => {
      if (rs.pending.length) {
        events.push(ev.deal(rs.pending, handMapOf(rs, state.players)));
        rs.pending = [];
      }
    };

    switch (action.type) {
      case 'hit': {
        const h = activeHand(rs);
        // totalOf(h) 读的是手牌自己记的 ranks —— 刚摸的这张已经在里面了。
        // 回查 state 会漏掉它，于是 22 点也不爆（这是一个会静默跑完全局的错）。
        const card = take(state, rs, h);
        const t = totalOf(h);
        flush();
        events.push(ev.announce(playerId, `要到 ${labelOf(state, card)}（现在 ${t.total} 点）`, 'play'));
        if (t.total > 21) {
          h.bust = true;
          h.done = true;
          events.push(ev.announce(playerId, `爆牌（${t.total} 点），这一手输 ${h.bet} 注`, 'bad'));
        } else if (t.total === 21) {
          h.done = true;
          events.push(ev.announce(playerId, '21 点，自动停牌', 'play'));
        }
        break;
      }

      case 'stand': {
        const h = activeHand(rs);
        h.done = true;
        events.push(ev.announce(playerId, `停牌，以 ${totalOf(h).total} 点结束`, 'play'));
        break;
      }

      case 'double': {
        const h = activeHand(rs);
        h.doubled = true;
        h.bet = h.bet * 2;
        const card = take(state, rs, h);
        const t = totalOf(h);
        h.done = true;
        flush();
        events.push(
          ev.announce(playerId, `双倍：注加到 ${h.bet} 注，补到 ${labelOf(state, card)}（${t.total} 点）`, 'play')
        );
        if (t.total > 21) {
          h.bust = true;
          events.push(ev.announce(playerId, `爆牌（${t.total} 点），这一手输 ${h.bet} 注`, 'bad'));
        }
        break;
      }

      case 'split': {
        const h = activeHand(rs);
        const [firstId, secondId] = h.cards;
        const firstRank = cardOf(state, firstId).rank;
        const secondRank = cardOf(state, secondId).rank;
        const left = makeHand(playerId, [firstId], [firstRank], { fromSplit: true });
        const right = makeHand(playerId, [secondId], [secondRank], { fromSplit: true });
        const aces = faceValue(firstRank) === 11;
        left.frozen = aces;
        right.frozen = aces;

        // 换掉原来那一手，两手接在同一个位置，顺序就是左边先打
        rs.hands.splice(rs.active, 1, left, right);
        const cl = take(state, rs, left);
        const cr = take(state, rs, right);
        flush();
        events.push(
          ev.announce(playerId, `分牌：拆成两手（${labelOf(state, cl)} 与 ${labelOf(state, cr)}）`, 'play')
        );
        if (aces) {
          left.done = true;
          right.done = true;
          events.push(ev.announce(playerId, '分 A：每边只补一张，不能再要牌', 'play'));
        }
        break;
      }

      case 'breach': {
        if (action.kind === 'peek') {
          // 偷看：把暗牌写进偷看者自己的私有记录。本地【不】把这张牌翻给全桌，
          // 也不在公开时间线里留下牌面 —— 否则偷看就变成了免费的全桌亮牌。
          const holeId = dealerHand(rs).cards[1];
          events.push(ev.breach(playerId, 'peek', '偷看了庄家的暗牌'));
          events.push(ev.privateNote(playerId, `你偷看到庄家的暗牌是 ${labelOf(state, holeId)}`));
          events.push(ev.score(playerId, -PEEK_PENALTY));
          break;
        }

        if (action.kind === 'destroy') {
          const r = resolveDestroy(state, playerId, action, {
            allow: (_st, cid) => cid !== dealerUpcardId(rs),
          });
          if (!r.ok) break;

          let cardId = r.cardId;
          let face;

          if (r.shoe) {
            /**
             * 盲烧牌堆顶。
             *
             * 这里比别处多一步：还没发出去的牌【根本不在 state.cards 里】
             * （牌堆顺序是按种子现推的，见 shoeOf）。所以要先把它「登记」进
             * 牌表，否则 destroy 找不到这张牌，投影层也就报不出 burned ——
             * 而 burned 正是胜率引擎用来知道「牌堆少了一张」的唯一凭据。
             *
             * 用一个空的 hands 发牌事件登记：牌进了牌表但谁也没拿到，
             * 于是它停在 zone 'deck'，紧接着被 destroy 打成 'void'。
             * audience 是 system（ev.deal 定的），不会把牌堆内容写进公开记录。
             */
            const next = peekNextDraw(state, rs);
            cardId = next.card.id;
            face = `${next.card.glyph}${next.card.label}`;
            rs.burned = rs.burned || {};
            const list = Array.isArray(rs.burned[next.shoeNo]) ? rs.burned[next.shoeNo] : [];
            rs.burned[next.shoeNo] = [...list, next.pos];
            events.push(ev.deal([next.card], {}));
          } else {
            const card = state.cards[cardId];
            face = card ? `${card.glyph}${card.label}` : '一张牌';
            // 规则包自己的状态位要自己净化 —— 内核不认识 hands / dealer / pending。
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

    // 推进到下一手
    rs.active = rs.hands.findIndex((x) => !x.done);
    if (rs.active < 0) rs.active = rs.hands.length;
    if (rs.active >= rs.hands.length) rs.phase = 'dealer';

    events.push(ev.ruleState({ replace: rs }));
    return events;
  },

  // -------------------------------------------------------------------------
  // 轮次收尾
  // -------------------------------------------------------------------------

  isRoundComplete(state) {
    const rs = rsOf(state);
    if (rs.phase === 'play') return false;
    return rs.hands.every((h) => h.done);
  },

  /**
   * 庄家补牌 + 结算 + 【发下一手的牌】。
   *
   * 最后那件事挂在这里，是被内核的时序逼出来的：内核只有 start 和
   * resolveRound 两个「规则包可以发事件」的时机，轮与轮之间没有钩子。
   * 不在这里发牌，第二手就会两手空空地开打。
   */
  resolveRound(state) {
    const rs = JSON.parse(JSON.stringify(rsOf(state)));
    rs.pending = [];
    const events = [];

    if (rs.phase === 'play') rs.phase = 'dealer';

    playDealer(state, rs, events);

    // 结算
    const players = state.players.filter((p) => p.id !== DEALER_ID);
    let dealerNet = 0;
    for (const h of rs.hands) {
      const r = settleHand(rs, h);
      h.outcome = r.outcome;
      h.delta = r.delta;
      dealerNet -= r.delta;
      const word = {
        blackjack: '黑杰克，赢 1.5 注',
        win: `赢 ${h.bet} 注`,
        push: '平局，退回本金',
        lose: `输 ${h.bet} 注`,
        bust: `爆牌，输 ${h.bet} 注`,
      }[r.outcome] || r.outcome;
      events.push(ev.score(h.ownerId, r.delta));
      // 文案里【不再】重复一遍人名：这条公告的 actorId 就是他本人，
      // 时间线会自己加上「某某：」前缀，再写一次就成了「玩家：玩家 对庄家…」。
      events.push(
        ev.announce(h.ownerId, `${rs.dealer.total > 21 ? '对爆牌的庄家' : `对庄家 ${rs.dealer.total} 点`} —— ${word}`, r.delta > 0 ? 'good' : r.delta < 0 ? 'bad' : 'info')
      );
    }
    events.push(ev.score(DEALER_ID, dealerNet));
    events.push(ev.ruleState({ replace: rs }));

    // 摊牌：这一手打完了，把每人的手牌和庄家的牌一起翻到桌面上。
    //
    // 必须【同时把牌移出手牌区】（ev.showdown 做的正是这件事）。只翻朝向、
    // 不移位置的话，这些牌会以 zone:'hand' 的样子永久留在 state.cards 里，
    // 于是投影层那句「已亮出的有…」会一手一手地累积 —— 打到第 6 手，
    // 一个只剩 2 张牌的座位会被描述成「已亮出的有 10 张」。
    //
    // 翻牌本身也有意义：黑杰克的算牌靠的就是「这局出过哪些牌」，
    // 所以它是公开信息，必须进记牌器。
    for (const h of rs.hands) {
      if (h.cards.length) events.push(ev.showdown(h.ownerId, h.cards));
    }
    if (dealerHand(rs).cards.length) events.push(ev.showdown(DEALER_ID, dealerHand(rs).cards));

    // 发下一手
    if (state.round < MAX_ROUNDS) {
      const rsNext = JSON.parse(JSON.stringify(rs));
      rsNext.pending = [];
      rsNext.phase = 'play';
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
    return state.round >= MAX_ROUNDS && rs.phase === 'done';
  },

  outcome(state) {
    const players = state.players.filter((p) => p.id !== DEALER_ID);
    const scores = Object.fromEntries(state.players.map((p) => [p.id, p.score]));
    const best = Math.max(...players.map((p) => p.score));
    return {
      winners: players.filter((p) => p.score === best).map((p) => p.id),
      scores,
      rounds: state.round,
    };
  },

  describe(state) {
    const lines = [
      '玩法：21 点（单副 52 张，用完重洗）',
      '你有两张起手牌，目标是点数尽量接近 21 点但不能超过。超过叫爆牌，直接输。',
      'A 可以当 11 也可以当 1（当 11 时叫「软」）；J/Q/K 都算 10 点。',
      '起手两张就是 21 点叫「黑杰克」，赔 1.5 倍；补牌补到 21 点只赔 1 倍。',
      '',
      '可选动作：',
      '  要牌 —— 再拿一张。爆牌就直接输。',
      '  停牌 —— 以当前点数结束这一手，等庄家亮牌。',
      '  双倍 —— 只在起手两张时可用：注翻倍，但只准再要一张，之后必须停。',
      '  分牌 —— 只在起手两张一样时可用：拆成两手各补一张，总注翻倍。本玩法只允许分一次；分 A 之后每边只补一张、不能再要。',
      '',
      '庄家的规矩是死的：17 点以下必须要牌，17 点及以上停。',
      '庄家明牌是 A 或 10 时会先偷看暗牌 —— 是黑杰克就当场收局，这一手你连动作都不会有。',
      `一共 ${MAX_ROUNDS} 手，按净胜注数排名。`,
      '比点数时：你更大赢 1 注，一样大退回本金，更小输 1 注。',
      '每张牌出过就没了，所以已经亮出来的牌会影响后面 —— 本地胜率表算的正是这件事。',
      '',
      `【破例】偷看庄家的暗牌、销毁任意一张牌，都是规则不允许的（扣分并全桌公示）。`,
      '  销毁是【真的把那张牌从牌局里拿掉】：它不在牌堆里、也不在任何人手上，',
      '  之后的每一手补牌与你看到的胜率都会少它一张 —— 这张牌再也不会出现。',
    ];

    // 动态局面：这里只能写【全桌都看得见】的东西。
    // 谁的手上是什么牌，走 describeTable 那条视角通道，不在这里写。
    //
    // 也【不能】写「你已经分成两手」这类话：describe 拿到的是原始 state，
    // 不带观察者，说「你」就等于替所有座位发言 —— 桌面上一共几手牌是公开的，
    // 哪几手属于谁不是。
    const rs = rsOf(state);
    const dh = dealerHand(rs);
    if (dh.cards.length) {
      const up = labelOf(state, dh.cards[0]);
      lines.push('');
      if (rs.dealer.revealed) {
        lines.push(`【当前】庄家的牌全部亮出：${labelList(state, dh.cards)}，共 ${totalOf(dh).total} 点。`);
      } else {
        lines.push(`【当前】庄家明牌 ${up}，另有一张暗牌没翻。`);
      }
      if (rs.hands.length > 1) {
        // 只数「这一手是不是从分牌来的」，不数手牌总数 —— 三个玩家同桌时
        // 手牌总数本来就是 3，把那个当成「有人分过牌」会平白多出一句假话。
        const split = rs.hands.some((h) => h.fromSplit);
        lines.push(
          split
            ? `本手有人分过牌：桌上一共 ${rs.hands.length} 手在打，现在轮到第 ${Math.min(rs.active + 1, rs.hands.length)} 手。`
            : `桌上一共 ${rs.hands.length} 手牌在打，现在轮到第 ${Math.min(rs.active + 1, rs.hands.length)} 手。`
        );
      }
    }
    return lines.join('\n');
  },
});

/**
 * 测试钩子。
 *
 * shoeOf 被导出的理由：自检里要构造【指定的发牌顺序】（「玩家拿到 10+6=16、
 * 下一张是 10」这种局面）才能把爆牌、双倍、分牌钉死在确定的牌上。
 * 与其在自检里抄一份洗牌公式（抄的那一刻就已经不是同一份实现了），
 * 不如让自检拿到规则包自己用的那一份。
 *
 * evaluateHand 是【转手导出】，真正的实现在 exact.js（同 strategy.js 用的那一份）。
 * 对外只留一个入口，自检就不必知道精确引擎住在哪个文件里。
 * MAX_ROUNDS / RESHUFFLE_AT 同理：它们是规则的一部分，自检该拿的是这两个名字，
 * 而不是把它们抄成字面量 —— 抄了之后改局数就得挨个去找，漏掉的那些会以
 * 「数字对不上」的形式变红，而不是跟着规则一起走。
 */
export {
  evaluateHand, shoeOf, MAX_ROUNDS, RESHUFFLE_AT, DEALER_ID as DEALER,
};
