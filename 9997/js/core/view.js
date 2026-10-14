/**
 * view.js — 视角投影层（全项目唯一的「事实出口」）
 *
 * 这一层是整个项目最重要的安全边界。
 * ------------------------------------------------------------------
 * 渲染层和 Prompt 装配层【都】必须经由 project() 读取信息，
 * 任何一处直接读 raw state 都会导致 AI 越权看牌。
 *
 * 信息隔离的标准是两句话：
 *   1. 任何投影里，背面牌都【不携带牌面字段】——
 *      facing === BACK 的对象上根本没有 rank / label / suit / glyph。
 *      这条由「结构」保证，不靠 UI 遮盖，也不靠在提示词里筛字串。
 *   2. 牌面数据不进入发给模型的提示词。
 *
 * 为什么要第 1 条而不是只靠第 2 条：第 2 条需要「所有装配路径都不出错」，
 * 而第 2 条的代码会不断被改（加区块、加胜率表、加新玩法）。第 1 条把
 * 差错空间压成零 —— 背面牌压根没有牌面字段可泄露，装配层怎么写都漏不出去。
 * 代价是零，所以两条都要。
 *
 * 牌 id 一律保留：看得见的给牌面，看不见的只给 id + facing。
 * 渲染层靠 id 把「哪张牌占哪一格」对上（翻牌、动画、被抢牌换位置都不会错位），
 * 本地规则引擎也靠 id 认牌。id 本身不携带任何牌面信息。
 * ------------------------------------------------------------------
 *
 * 已知且【有意接受】的一条信息通路
 * ------------------------------------------------------------------
 * 破例动作「偷看」产出的内容会写进偷看者自己的私有记录（ev.privateNote），
 * 之后每一轮提示词里都会带上，他便长期知道「那张牌是什么」。
 * 这不是漏洞，是玩法：偷看换来的是持久信息优势，代价是扣分和全桌公示。
 * 本地不会去抹掉它 —— 抹掉等于把偷看变成一个当场看、转头忘的无用动作。
 * ------------------------------------------------------------------
 */

import { BACK, FACE, SUIT_INDEX, faceTo, VIS, visibilityOf } from './cards.js';
import { VOID_ZONE } from './state.js';

/**
 * 手牌展示排序 —— 从小到大，同点数按花色。
 *
 * 为什么要排：发牌顺序是洗牌结果，摊在桌上就是乱的。真人牌手拿到牌第一件事
 * 就是理牌，理完才看得出「手里有几张 A、差一张成顺」。不排的话玩家每出一张牌，
 * 剩下的牌还会在视觉上重新洗一次，找牌全凭肉眼扫。
 *
 * 三点必须守住的：
 *
 * 1. 【只排展示，不动事实】。排序结果只进投影，state 里 players[].hand 的顺序
 *    一根毫毛都不动。规则引擎、枚举器、胜率模拟全部按牌 id 认牌，本来就不依赖
 *    顺序 —— 排序若写进 state，等于给这些模块塞了一个它们不关心的副作用。
 *
 * 2. 【自己看不见的牌一律沉到末尾】。这是信息隔离要求，不是审美问题：
 *    如果一张背面牌（「仅外人可见」那一档，牌主自己也读不出牌面）按它真实的
 *    点数插进队里，牌主只要看它夹在哪两张之间，就能推算出它的点数区间 ——
 *    四态可见性辛辛苦苦挡住的信息，会被一个排序泄露出去。
 *    沉底之后，它在哪儿只说明「这张我读不出来」这一件牌主本来就知道的事。
 *
 * 3. 【同点数的先后稳定】。同点数按花色排（黑桃→红桃→方块→梅花），
 *    并保留原有的相对次序作为兜底，谁都不会因为排序而忽左忽右地跳。
 *
 * @param {Array} list 已经投影过的牌（背面牌上没有 rank 字段，这里按 facing 判断）
 * @returns {Array} 新数组，不改原数组
 */
export function sortHand(list) {
  const BLIND = 1e9; // 大于任何真实 rank 派生的键，背面牌统一落在这里
  const key = (c) =>
    c.facing === FACE ? c.rank * 10 + (SUIT_INDEX[c.suit] ?? 9) : BLIND;
  return list
    .map((c, i) => ({ c, i, k: key(c) }))
    .sort((a, b) => a.k - b.k || a.i - b.i)
    .map((x) => x.c);
}

/**
 * 把单张牌投影成某个观察者能看到的样子。
 * 背面牌不携带任何可推断点数的字段。
 *
 * @param godView 上帝视角。必须显式传入 —— 不能只看 viewerId 是不是 null
 *                就推断，那样任何忘记传观察者的调用都会静默变成全知视角。
 *
 * 关于 vis 字段：牌主人拿得到它（这是他自己的操作状态），
 * 上帝视角也拿得到（调试时正需要看每张牌处于四态里的哪一档）。
 * 其他玩家拿到 facing 就够了，多给反而会泄露别人的操作。
 */
export function projectCard(card, viewerId, { godView = false } = {}) {
  if (!card) return null;

  // 已销毁的牌不属于任何视角 —— 上帝视角也不给。
  // 上帝视角的意义是「看穿别人盖着的牌」，不是「看穿已经不存在的牌」；
  // 放行它只会让「销毁是否彻底」这件事没法用投影来验证。
  if (card.zone === VOID_ZONE) return null;

  if (godView) {
    return {
      id: card.id,
      facing: FACE,
      suit: card.suit,
      glyph: card.glyph,
      rank: card.rank,
      label: card.label,
      red: card.red,
      vis: visibilityOf(card),
      ownerId: card.ownerId ?? null,
    };
  }

  const facing = faceTo(card, viewerId);
  const isOwner =
    card.ownerId !== null && card.ownerId !== undefined && card.ownerId === viewerId;

  const out = { id: card.id, facing };

  if (facing === FACE) {
    out.suit = card.suit;
    out.glyph = card.glyph;
    out.rank = card.rank;
    out.label = card.label;
    out.red = card.red;
  }

  if (isOwner) out.vis = visibilityOf(card);

  return out;
}

/** 过滤事件流：只留下该观察者有权看到的事件 */
export function visibleEvents(state, viewerId) {
  return state.log.filter((e) => {
    const a = e.audience ?? 'public';
    if (a === 'public') return true;
    if (Array.isArray(a)) return a.includes(viewerId);
    return false;
  });
}

/**
 * 投影出某个观察者眼中的完整局面。
 * @param {object} state  原始状态
 * @param {string|null} viewerId  观察者 id；传 null 表示上帝视角
 */
export function project(state, viewerId) {
  const isGodView = viewerId === null || viewerId === undefined;
  const cardOpts = { godView: isGodView };

  const seats = state.players.map((p) => {
    const iAmThisSeat = !isGodView && p.id === viewerId;
    return {
      id: p.id,
      // 座位名随观察者变化：本人看到的自己是「你」，别人只看到「玩家」。
      // 否则 AI 的提示词里会出现「从 你 手上抢走一张牌」这种第三人称错位。
      name: isGodView ? p.name : iAmThisSeat ? '你' : p.isHuman ? '玩家' : p.name,
      /** 这是不是观察者自己的座位。渲染层和提示词靠它区分「我的手牌」与「别人的手牌」 */
      isMe: iAmThisSeat,
      isHuman: p.isHuman,
      score: p.score,
      alive: p.alive,
      folded: p.folded,
      handCount: p.hand.length,
      /**
       * 手牌【永远】投影成数组，而不是「看得见才给、看不见就给 null」。
       * 看不见的牌依然是对象：带 id 和 facing，但没有牌面字段。
       * 这样渲染层能画出这一手牌里每一张的背面（张数与位置都对得上），
       * 而信息隔离由「背面牌不带牌面字段」保证，不靠「干脆不发这张牌」。
       *
       * 投影出来的顺序是【理过牌的顺序】（sortHand），不是发牌顺序 ——
       * 渲染层、提示词装配层读到的都是理好的那一份。
       */
      hand: sortHand(p.hand.map((cid) => projectCard(state.cards[cid], viewerId, cardOpts)).filter(Boolean)),
    };
  });

  const mySeat = isGodView ? null : state.players.find((p) => p.id === viewerId) || null;

  const myHand = mySeat
    ? sortHand(mySeat.hand.map((cid) => projectCard(state.cards[cid], viewerId, cardOpts)).filter(Boolean))
    : [];

  /**
   * 桌面上的牌（所有已出的牌）。
   *
   * ownerId 一并带上：**归属是公开信息** —— 谁都看得见那张牌是谁打出来的。
   * 渲染层要靠它把牌摆回各人脚前那块出牌区；少了它，桌面上的牌就只剩
   * 中间一条谁都不认领的长龙。
   * 注意这里给的是 ownerId（谁打的），不是 vis（牌主自己的操作状态）——
   * 后者仍然只有牌主人拿得到。
   */
  const table = Object.values(state.cards)
    .filter((c) => c.zone === 'table')
    .map((c) => ({ ...projectCard(c, viewerId, cardOpts), ownerId: c.ownerId ?? null }))
    .filter(Boolean);

  /**
   * 记牌器：所有【已经对全桌公开】的牌 —— 不管它现在在谁手里。
   * 一开始只算「打到桌面上的牌」，但那样会漏掉两种同样是公开信息的牌：
   *   · 斗地主的底牌（发到地主手上，规则要求全桌可见）
   *   · 玩家主动亮出来的手牌（亮牌是一种公开信号）
   * 判断依据统一成「这张牌对其他人的朝向是不是正面」，
   * 而不是它躺在哪个区域 —— 后者会随玩法而变。
   */
  const exposed = Object.values(state.cards)
    .filter((c) => c.zone !== VOID_ZONE && c.reveal.public === FACE)
    .map((c) => ({
      ...projectCard(c, viewerId, { godView: false }),
      ownerId: c.ownerId ?? null,
      zone: c.zone,
    }))
    .filter((c) => c && c.id);

  /**
   * 已被销毁的牌（公开信息，所有人看到的都一样）。
   *
   * 为什么它必须出现在投影里，而不是「干脆当没发生过」：
   *   两个胜率引擎都是靠「整副牌 − 看得见的牌 = 未见牌堆」推出来的。
   *   销毁掉的牌既然不在任何人的视线里，就会被引擎当成「还没发」，
   *   然后在模拟里【复活】—— 21 点会在 51 张的真实牌堆上按 52 张算，
   *   斗地主更直接：补全时牌数对不上，整张胜率表直接不出数。
   *   所以把「少掉的这几张是什么」如实投影出来，引擎才补得对。
   *
   * 注意它【不是】一个可以玩的牌区：这里的牌没人持有、不在桌面、
   * 不可出、不可抢、不计入手牌数，也不参与任何规则判断。
   */
  const burned = Object.values(state.cards)
    .filter((c) => c.zone === VOID_ZONE)
    .map((c) => ({
      id: c.id,
      rank: c.rank,
      suit: c.suit,
      glyph: c.glyph,
      label: c.label,
      red: c.red,
      zone: VOID_ZONE,
    }));

  return {
    viewerId: viewerId ?? null,
    isGodView,
    phase: state.phase,
    round: state.round,
    turn: state.turn,
    seats,
    mySeatId: mySeat ? mySeat.id : null,
    myHand,
    table,
    discard: exposed,
    exposed,
    burned,
    result: state.result,
    events: visibleEvents(state, viewerId),
  };
}

/**
 * 投影成「牌局信息」文本块，用于塞进 LLM 提示词。
 * 这里的输出直接决定了 AI 能看到什么，务必只喂已经投影过的数据。
 */
export function describeTable(view, { selfId = null } = {}) {
  const lines = [];
  const exposed = view.exposed || [];
  for (const seat of view.seats) {
    const canRead = seat.isMe || view.isGodView;
    const tag = seat.id === selfId && seat.name !== '你' ? '（你）' : '';

    if (canRead) {
      const hand = seat.hand || [];
      const cards = hand
        .map((c) => (c.facing === BACK ? '??' : `${c.glyph}${c.label}`))
        .join(' ');
      // 自己手上那些连自己都看不到的牌要单独点出来 —— 这正是四态里
      // 「仅外人可见」那一档的意义：我拿着一张连自己都读不出牌面的牌。
      const blind = hand.filter((c) => c.facing === BACK);
      const othersSee = blind.filter((c) => c.vis === VIS.OTHERS).length;
      let extra = '';
      if (blind.length) {
        extra = `，其中 ${blind.length} 张你自己也看不见`;
        if (othersSee) extra += `（有 ${othersSee} 张对手反而看得见）`;
      }
      lines.push(`你${tag} 的手牌（${seat.handCount} 张）：${cards}${extra}`);
      continue;
    }

    // 别人的手牌内容看不到，但【已经亮出来的那几张】是公开信息，
    // 必须写进去 —— 否则「亮牌」这个动作对 AI 就等于没发生。
    // 只统计还在手里的牌：打出去的牌是另一件事（记牌器里已经列过），
    // 混进来会让 AI 以为对方手上还留着那几张。
    const shown = exposed
      .filter((c) => c.ownerId === seat.id && c.zone === 'hand')
      .map((c) => `${c.glyph}${c.label}`);
    const extra = shown.length ? `，其中已亮出的有 ${shown.join(' ')}` : '';
    lines.push(`${seat.name}${tag} 的手牌：${seat.handCount} 张${extra}（其余内容不可见）`);
  }

  /**
   * 已被销毁的牌要写进提示词。这一条不是可选的礼貌说明：
   * 销毁是公开事件，真人玩家会亲眼看着那张牌被拿走，此后他的所有判断
   * 都建立在「那些牌已经不在牌局里」之上。提示词不写，等于让 AI 比
   * 同桌的真人少知道一件公开的事 —— 记牌、算概率全都会偏。
   */
  const burned = view.burned || [];
  if (burned.length) {
    lines.push(`已从牌局中销毁（不在任何人手上，不在牌堆里）：${burned.map((c) => `${c.glyph}${c.label}`).join(' ')}`);
  }
  return lines.join('\n');
}
