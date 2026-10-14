/**
 * table.js — Canvas 2D 牌桌渲染（2D 正面视角）
 *
 * 视角
 * ------------------------------------------------------------------
 * 人物是**立在桌面上的 Q 版立牌**：脚底锚在座位上、名牌挂头顶、
 * 出牌区贴在各自脚前。桌面底图本身是俯视的，这里只当「桌面图案」用 ——
 * 俯视地图 + 正面立牌是棋盘游戏的通用解法（棋盘上的单位也都正面朝向玩家）。
 *
 * 于是座位不再需要几何求解：一个座位就是一个归一化落点（脚底），
 * 跟桌子是椭圆还是矩形无关。换底图只改 avatars.js 里那一行路径。
 *
 * 座位怎么排
 * ------------------------------------------------------------------
 * 对手贴 **上 / 左 / 右** 三条边，屏幕底边整条留给玩家：
 * 一位对手在上边缘居中，两位在左右边缘，三位是「上 + 左 + 右」。
 * 底边永远只有玩家 —— 他在屏幕前，桌上不摆他的立绘，只有一块出牌区。
 * （原来对手排成 2×2 两排时，"我最下面那一格"会被对手挤进来。）
 *
 * 四种展示方式各有独立的视觉编码（边框样式 + 角标），
 * 保证玩家一眼就能看出某张牌处于哪个状态：
 *
 *   都可见     实线灰边，无角标，牌面正常
 *   仅自己可见 蓝色虚线边 + 「私」角标
 *   仅外人可见 橙色虚线边 + 「外」角标（自己看到的是背面）
 *   都不可见   灰色边 + 「暗」角标（自己看到的是背面）
 *
 * 注意：渲染层拿到的牌对象已由视角投影层处理过，
 * 背面牌身上根本没有点数信息，这里不存在「靠遮挡隐藏」的情况。
 *
 * 分层（都在这一张 canvas 上，从下往上画）
 * ------------------------------------------------------------------
 *   桌面底图 → 四周压暗 → 接触阴影 → 出牌区 + 这一巡的牌
 *   → 记牌器（左下角的记录板）→ 屏幕边缘亮着的牌
 *   → 立绘 + 名牌 → 我的手牌 + 身份行 → 说话气泡
 * 立绘压在牌上面：人站在桌前，不是贴在桌布下面。
 *
 * 「谁打了什么」只有一处落点：出牌区。屏幕边缘那几张小牌是**他亮着的**
 * （21 点庄家的明牌、斗地主地主的底牌），两个位置分开摆，才不会被读成
 * 「他刚打了一手点数不搭的牌」。记牌器同样不重复列出已经摆出来的牌。
 *
 * 两处「有时间的过程」
 * ------------------------------------------------------------------
 * 渲染层平时是被动的：app 改完 state 调一次 render，画完就停。但有两件事
 * 天然带时间 —— 牌从人手里飞到桌上是**过程**，视角轮盘展开也是。所以这里
 * 自备一个极小的帧循环（`pump`），只在真有动画时才跑，跑完就停，不留一个
 * 常驻 rAF 在那儿空转。
 *
 *   · 出牌演出（`beginPlayStage`）：AI 打出的牌先从手边举起来、在身前放大，
 *     停一下让人看清，再落进出牌区。**演出不动 layout**：`layout.cards` 里
 *     那些牌始终是落定后的位置，演出只是绘制时的位移 —— 否则门禁量几何会
 *     量到动画中间态，而中间态不是任何一个可以被断言的事实。
 *   · 视角轮盘（见 `menuGeometry`）：右键自己手上的牌，圆心那个 × 是关，
 *     前左 / 前 / 前右三块是另外三档可见性。
 */

import { BACK, FACE, VIS, VIS_ORDER } from '../core/cards.js';
import { AVATARS, DEFAULT_AVATAR, DEFAULT_SEAT_URL, TABLE_IMG, avatarUrl, tableUrl } from '../ui/avatars.js';

const CARD_W = 46;
const CARD_H = 64;
const EDGE = 14;

/**
 * 「小牌」的尺寸 —— 记牌器和屏幕边缘那些亮着的牌共用一档。
 * 它们是同一类东西（都已经离开某个人的手、摆在桌面上的公开信息），
 * 大小一致才读得成一套；两处各写一份，改一处忘另一处就会一大一小。
 */
const MINI_W = 26;
const MINI_H = 36;

/**
 * 「亮着的牌」那条竖条离屏幕边缘的进深。
 *
 * 比 EDGE 宽一档，是为了让开**右侧那个「设置」把手**：它是 DOM 层、压在画布
 * 之上，量出来盖住画布最右 25px（视口 1440 时 1395..1420）—— 按 EDGE 贴边
 * 会被它压掉小半张牌。两条边取同一个进深，免得左边紧、右边松看着不对称。
 */
const RAIL_INSET = 32;

/**
 * 点人的判定框比立绘本身放宽多少（立绘是异形的，手指落到它边上一点也该算点中）
 */
const SEAT_PAD = 8;

/**
 * 屏幕底部留给「身份行 + 我的手牌」的高度。
 * 这一段由 canvas 自己画。底边那一席的脚底、以及所有人出牌区的下沿，
 * 都从它反推 —— 写死成别处的数字，改一次牌的尺寸就会压住牌。
 *
 * 注意它**不包含 DOM 那排按钮**：操作坞现在浮在出牌区上方（见 index.html 的
 * `.dock`），是 canvas 之上的另一层，不再往画布下面占地方。
 */
const BAR_H = 120;
/** 人物脚底到出牌区上沿的间隙 */
const PLAY_GAP = 8;

/**
 * 出牌演出的三段时长（毫秒）：举起来 → 举着让人看清 → 落进出牌区。
 *
 * 「举着」那一段最长，因为三段里只有它承担信息：前两段只是把牌挪到眼前，
 * 牌面是在**停住的那一下**被读到的。整段控制在 1 秒以内 —— 一局要演十几次，
 * 每次多两百毫秒，整局就多好几秒。
 */
const STAGE_RISE = 240;
const STAGE_HOLD = 460;
const STAGE_SETTLE = 220;
const STAGE_DUR = STAGE_RISE + STAGE_HOLD + STAGE_SETTLE;

/** 举在身前时放大到最终尺寸的几倍；起手那一下缩到几倍 */
const STAGE_ZOOM = 1.9;
const STAGE_FROM = 0.45;

/**
 * 出牌者「手」的大致位置（立绘身高比例，从脚底往上算）。
 * 起手那一下从这儿出来，读起来才像"从手里拿出来"，而不是凭空出现在身前。
 */
const STAGE_HAND_K = 0.62;
/** 「举在身前」的高度：挡在人物中下部，不遮脸 */
const STAGE_HOLD_K = 0.30;

/** 视角轮盘：外半径 / 圆心那个「关」的圆半径 / 展开时长 */
const MENU_R = 70;
const MENU_R0 = 26;
const MENU_OPEN_MS = 150;

/**
 * 轮盘上那三块的短标签。
 *
 * 不用 `VIS_META[].short`（「全明 / 私明 / 反暗 / 全暗」）—— 那四个词是给
 * 熟悉这套模型的代码读的，头一回上手的人读不出「反暗」是"外人都看得见、
 * 就我自己看不见"。这里配着一张牌的正反面小图（左＝你看到的、右＝外人看到的），
 * 标签只负责把那张图说成三个字。
 */
const MENU_LABEL = {
  [VIS.ALL]: '都亮着',
  [VIS.SELF]: '只我亮',
  [VIS.OTHERS]: '只他亮',
  [VIS.NONE]: '都盖着',
};

/** 立绘高 ÷ 舞台高 */
const CHAR_H_K = 0.245;
/** 立绘宽 ÷ 舞台宽 的上限（画幅最宽的是黑桃王子 0.706） */
const CHAR_H_MAX_W = 0.30;
/** 玩家那块出牌区比智能体的大一档 —— 全桌唯一一处「你的牌」 */
const NEAR_K = 1.10;

/**
 * 对手座位槽（归一化落点 = 脚底）。
 * 按对手人数取一档；底边永不出现在这里 —— 那是玩家的。
 */
const SLOTS = {
  1: [{ x: 0.50, y: 0.300 }],
  2: [{ x: 0.155, y: 0.360 }, { x: 0.845, y: 0.360 }],
  3: [{ x: 0.50, y: 0.275 }, { x: 0.145, y: 0.470 }, { x: 0.855, y: 0.470 }],
  4: [{ x: 0.305, y: 0.265 }, { x: 0.695, y: 0.265 }, { x: 0.135, y: 0.470 }, { x: 0.865, y: 0.470 }],
  5: [{ x: 0.50, y: 0.250 }, { x: 0.215, y: 0.300 }, { x: 0.785, y: 0.300 },
      { x: 0.135, y: 0.500 }, { x: 0.865, y: 0.500 }],
};

function slotsFor(n) {
  if (SLOTS[n]) return SLOTS[n];
  // 再多就沿上边缘弧线均匀摊开，两侧留边 —— 至少不会叠在一起
  const out = [];
  const k = Math.min(n, 7);
  for (let i = 0; i < k; i++) {
    const t = (i + 0.5) / k;
    out.push({ x: 0.10 + t * 0.80, y: 0.265 });
  }
  return out;
}

const C = {
  base: '#07070a',
  face: '#f6f4ef',
  faceInk: '#20262e',
  red: '#c0392b',
  back: '#2b425c',
  backHi: '#3a5876',
  backLine: '#4f7191',
  text: '#e8e6e1',
  muted: '#8b8f9a',
  gold: '#c9a227',
  goldSoft: '#e0b64a',
  line: '#262a33',
  play: 'rgba(8,9,12,0.34)',
  plateBg: 'rgba(8,9,12,0.86)',
  bubble: 'rgba(14,16,20,0.96)',
  bubbleBorder: '#3a3f4a',
  border: {
    [VIS.ALL]: '#8d97a3',
    [VIS.SELF]: '#4a8fd0',
    [VIS.OTHERS]: '#c98a2a',
    [VIS.NONE]: '#9a9a9a',
  },
  /** 别人座位的牌：观察者不知道它的可见性状态，所以给一个中性的细边框 */
  borderOther: '#7d8fa3',
  badge: {
    [VIS.SELF]: '#2c6ea8',
    [VIS.OTHERS]: '#a86b17',
    [VIS.NONE]: '#6b7b8c',
  },
};

const BADGE_TEXT = {
  [VIS.SELF]: '私',
  [VIS.OTHERS]: '外',
  [VIS.NONE]: '暗',
};

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

/**
 * 这张牌当前被抬起多少。
 *
 * 抽出来是因为它有三个读者：画牌（`drawCard`）、点中判定（`hitTest`）、
 * 以及**视角轮盘的圆心**（`menuGeometry`）。三处各写一份的话，哪天改了
 * 抬起高度，就会出现「看到的牌在这儿、点中的位置在那儿、轮盘又钉在第三处」
 * —— 三个都"看起来对"，但互相差 8 像素。
 */
function liftOf(cardId, ui = {}) {
  if (ui.hoverId === cardId) return -8;
  const selected = ui.selectedIds || [];
  if (ui.selectedId === cardId || selected.includes(cardId)) return -12;
  return 0;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOut = (t) => 1 - (1 - t) * (1 - t);
const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - 2 * (1 - t) * (1 - t));
/** 从一个框插值到另一个框（x/y 是左上角） */
function lerpBox(a, b, u) {
  return {
    x: a.x + (b.x - a.x) * u,
    y: a.y + (b.y - a.y) * u,
    w: a.w + (b.w - a.w) * u,
    h: a.h + (b.h - a.h) * u,
  };
}

const FONT = '"Segoe UI","Microsoft YaHei",system-ui,sans-serif';

export function createTableRenderer(canvas, handlers = {}) {
  const ctx = canvas.getContext('2d');
  const st = {
    view: null,
    ui: {},
    layout: { cards: [], seats: [] },
    /** 正在演的出牌（见 beginPlayStage）。layout 不受它影响 */
    stages: [],
    /** 轮盘展开的时间起点与它钉在哪张牌上（见 render 开头） */
    menuCard: null,
    menuT0: 0,
    /** 排好的下一帧句柄；非 0 表示帧循环正在跑 */
    frame: 0,
    w: 0,
    h: 0,
    dpr: 1,
  };

  // -------------------------------------------------------------------------
  // 极小的帧循环
  //
  // 没有它，动画就得靠 app 每帧调一次 render —— 而 app 是事件驱动的，没有
  // 事件就没有帧。这里自己推：只在真有东西要动的时候推，动完停在原地。
  //
  // requestAnimationFrame 不是处处都有（tools/dom-smoke.mjs 的假环境里就没有），
  // 所以退回 setTimeout —— 动画慢一档无所谓，**不跑**才是问题。
  // -------------------------------------------------------------------------
  const nowMs = () => (typeof performance !== 'undefined' && performance.now
    ? performance.now()
    : Date.now());
  const nextFrame = (fn) => (typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(fn)
    : setTimeout(fn, 16));

  /** 轮盘正在展开（展开期间要自己推帧，否则第一帧画完就停住了） */
  function menuOpening() {
    return !!st.menuCard && nowMs() - st.menuT0 < MENU_OPEN_MS;
  }

  function pump() {
    if (st.frame) return;
    st.frame = nextFrame(tick);
  }

  function tick() {
    st.frame = 0;
    const t = nowMs();
    // 到点的演出立刻从画面里撤掉：撤掉之后那张牌回到 layout 里落定的位置，
    // 于是"落进展示区"这一步不需要另写一个终态 —— 它本来就是静止态。
    st.stages = st.stages.filter((s) => t - s.t0 < s.dur);
    if (st.view) render(st.view, st.ui);
    if (st.stages.length || menuOpening()) pump();
  }

  // -------------------------------------------------------------------------
  // 图片：预加载 + 加载完重画一次
  //
  // 不重画的话，首次渲染时图还没到位，那一帧就是空白 —— 而且之后没有任何
  // 东西会再触发渲染，于是画面**永远**停在空白上，看起来像"这块没有图"。
  // -------------------------------------------------------------------------
  const images = new Map();
  function img(url) {
    if (!url) return null;
    let e = images.get(url);
    if (e) return e;
    const node = new Image();
    e = { node, ok: false };
    images.set(url, e);
    node.onload = () => {
      e.ok = true;
      if (st.view) render(st.view, st.ui);
    };
    node.onerror = () => {
      // 静默 404 是最难查的一类：<img> 不抛异常也不报 console 错。
      // 至少在这里留一行，别让"图没加载"表现成"这块本来就空"。
      console.warn(`[table] 图片加载失败：${url}`);
      if (st.view) render(st.view, st.ui);
    };
    node.src = url;
    return e;
  }
  const ready = (e) => e && e.ok && e.node.naturalWidth > 0;

  function resize() {
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    st.dpr = dpr;
    st.w = Math.max(320, Math.round(rect.width));
    st.h = Math.max(280, Math.round(rect.height));
    const bw = Math.floor(st.w * dpr);
    const bh = Math.floor(st.h * dpr);
    // 值没变就不赋值：给 canvas.width 赋同值也会重建后备缓冲（1400×866 ≈ 4.8MB）
    if (canvas.width !== bw || canvas.height !== bh) {
      canvas.width = bw;
      canvas.height = bh;
    }
    if (st.view) render(st.view, st.ui);
  }

  // -------------------------------------------------------------------------
  // 布局
  // -------------------------------------------------------------------------

  /**
   * 每个座位在「这一巡」打出来的牌。
   *
   * 不能拿「这个人历来打过的所有牌」—— 斗地主里桌面的牌是累加的，
   * 打到中盘一个人跟前会堆成一摞几十张的假象。
   * 内核里「牌桌上的一巡 = 一个 round」，所以窗口取**最后一次 round:start
   * 之后**的 play/出牌事件；在那之后过过牌的人，跟前就该是空的。
   */
  function lastPlays(view) {
    const out = new Map();
    let from = 0;
    for (let i = view.events.length - 1; i >= 0; i--) {
      if (view.events[i].type === 'round:start') { from = i + 1; break; }
    }
    for (let i = from; i < view.events.length; i++) {
      const e = view.events[i];
      const pid = e.payload?.playerId ?? e.actorId;
      if (!pid) continue;
      if (e.type === 'play' || e.type === 'showdown') out.set(pid, e.payload.cardIds || []);
      else if (e.type === 'pass') out.set(pid, []);
    }
    return out;
  }

  function computeLayout(view, ui = {}) {
    const W = st.w;
    const H = st.h;
    /**
     * "我坐在哪一席"。
     *
     * 上帝视角下投影里没有观察者（`mySeatId` 是 null），但**屏幕前的人还在桌上** ——
     * 不认这一席的话，他自己那一手牌会在上帝视角里凭空消失，
     * 而调试时最想看的恰恰是"我这几张和他们的对上了没有"。
     * 所以上帝视角退回用 ui.humanId 认领座位，只是那张座位上拿到的牌是明牌。
     */
    const me = view.mySeatId || (view.isGodView ? (ui.humanId || null) : null);
    const mine = view.seats.find((s) => s.id === me) || null;
    const opponents = view.seats.filter((s) => s.id !== me);
    const n = opponents.length;
    const slots = slotsFor(n);

    // 人多就整体缩一档：四个人比三个人多占整整一排，垂直方向就这么多地方，
    // 不缩的话上排出牌区和下排人物的头顶会叠在一起。
    const sizeK = n <= 2 ? 1 : n === 3 ? 0.90 : 0.82;
    let charH = H * CHAR_H_K;
    charH = Math.min(charH, (CHAR_H_MAX_W * W) / 0.706);
    charH = Math.max(96, Math.round(charH * sizeK));

    // 同一排/同一圈的人脚底要齐平：feetMax 用**本桌最高**的那个人算，
    // 各人按自己的出牌区高去算会差几个像素，一眼就看出歪
    const phRef = Math.round(charH * NEAR_K * 0.28);
    const feetMax = H - BAR_H - PLAY_GAP - phRef;

    const plays = lastPlays(view);
    const byId = new Map();
    for (const c of view.table || []) if (c && c.id) byId.set(c.id, c);

    const seats = [];
    const cards = [];

    // 落点先全部算出来，再定"亮牌贴哪条边、占哪条车道" —— 同一条边上的
    // 两位要横向错开，就得先知道都有谁在那一侧
    const placed = opponents.map((s, i) => {
      const slot = slots[i] || slots[slots.length - 1];
      return {
        s,
        x: Math.round(slot.x * W),
        y: Math.round(Math.min(slot.y * H, feetMax)),
      };
    });
    const lanes = railLanes(placed);

    placed.forEach(({ s, x, y }) => {
      const h = charH;
      const av = AVATARS[s.avatar] || null;
      const w = Math.round(h * (av ? av.aspect : 0.56));
      const ph = Math.round(h * 0.28);
      const pw = Math.round(h * 0.78);
      const play = { x, y: y + PLAY_GAP + ph / 2, w: pw, h: ph, ownerId: s.id };
      const entry = { id: s.id, seat: s, isMe: false, x, y, h, w, play,
        avatar: s.avatar, hasAgent: s.hasAgent !== false,
        name: s.name, score: s.score, handCount: s.handCount,
        bubbleY: y - h - 34 };
      seats.push(entry);
      pushPlayCards(cards, play, byId, plays.get(s.id));
      pushRevealedHand(cards, entry, s, lanes.get(s.id));
    });

    if (mine) {
      const h = Math.round(charH * NEAR_K);
      const ph = Math.round(h * 0.28);
      const pw = Math.round(h * 0.78);
      const x = Math.round(W / 2);
      const y = feetMax;
      const play = { x, y: y + PLAY_GAP + ph / 2, w: pw, h: ph, ownerId: mine.id };
      seats.push({ id: mine.id, seat: mine, isMe: true, x, y, h, w: 0, play,
        avatar: null, name: mine.name, score: mine.score, handCount: mine.handCount,
        bubbleY: H - CARD_H - 44 });
      pushPlayCards(cards, play, byId, plays.get(mine.id));
    }

    // 我的手牌：居中摊开。牌多到 20 张（地主拿了底牌）时允许负间距，叠着放，
    // 否则会铺出画布。
    // 上帝视角下投影里没有「我的手牌」（那一份投影没有观察者）——
    // 退回升到座位上取那一手：同样是投影过的牌，只是上帝视角下都是正面。
    const hand = view.mySeatId ? (view.myHand || []) : (mine ? mine.hand || [] : []);
    const y = H - 14 - CARD_H;
    const avail = W - EDGE * 2 - CARD_W;
    const gap = Math.min(10, (avail - hand.length * CARD_W) / Math.max(1, hand.length - 1));
    const tw = hand.length * CARD_W + Math.max(0, hand.length - 1) * gap;
    const sx = W / 2 - tw / 2;
    hand.forEach((c, i) => {
      cards.push({
        id: c.id, card: c, zone: 'hand', ownerId: me,
        x: Math.round(sx + i * (CARD_W + gap)), y, w: CARD_W, h: CARD_H,
      });
    });

    return { seats, cards, W, H, charH, hand: { x: sx, y, w: CARD_W, h: CARD_H, gap, count: hand.length },
      barTop: H - BAR_H };
  }

  /**
   * 这个座位手上"**我看得见**的那几张牌"，贴到**他所在那一侧的屏幕边缘**。
   *
   * 常见情况下这里是空的 —— 对手的手牌全是背面，名牌上写着张数就够了
   * （摊 17 张迷你背面在桌上，反而把桌面读成一摞纸）。它在这几处派上用场：
   *   · 21 点庄家的**明牌**：那张牌本来就是全桌可见的
   *   · 斗地主地主的**底牌**：规则要求全桌可见
   *   · 上帝视角：调试时要能看穿所有人的牌
   * 判据只有一条：`facing === FACE` 就是"观察者读得出牌面"。所以同一段代码
   * 既照顾了公开信息，也照顾了上帝视角，不需要为谁开特例。
   *
   * 为什么【不】摆在出牌区下面（改过一次）：
   * 出牌区是"这一巡他打出的牌"的位置，任何摆进去的牌都会被读成"他刚出了这几张"。
   * 斗地主地主的底牌摆进去之后，实测被读成「地主打了一手 10 和 K」——
   * 一手点数不同的牌，看着就像违规出牌。
   *
   * 为什么【也】不贴在立绘旁边（又改过一次）：
   * 贴在他脚边时，"他亮着的"和"他手里还剩什么"挤在同一块地方，是哪一件事
   * 只能靠位置去猜。现在一律**贴他那一侧的屏幕边缘**，牌还是他亮着的牌，
   * 落点却从"人身上"挪到了"屏幕的边框上" —— 与人、与出牌区、与记牌器都不挨着。
   *
   * 落点分三条边（见 `railSide`），其中**正上方那一席只走顶缘的左角**：
   * 名牌就顶在它头顶上方的画布上沿（`seat.y - seat.h - 8 - 21`），正上方那一段
   * 被名牌占满了；而左缘的下半段又紧挨着它左边那位的头顶，摆过去实测被读成
   * 「那是左下角那位的牌」。所以让它贴顶缘、从左上角起头：既在它那一侧的边上，
   * 又不挨着任何人。
   *
   * @param lane 同一条边上的车道号（见 `railLanes`）。四人局的上排与下排
   *             可能同时亮着牌，不横向错开就会两条叠在一起。
   */
  function pushRevealedHand(out, entry, seatState, lane = { lane: 0, lanes: 1, yFloor: EDGE }) {
    if (entry.isMe) return; // 自己那一手在底部摊着，不必再画一遍
    const list = (seatState.hand || []).filter((c) => c.facing === FACE);
    if (!list.length) return;

    const mw = MINI_W;
    const mh = MINI_H;

    /**
     * 规则座位（21 点的荷官）没有立绘。它的牌贴到屏幕边缘就是"顶端孤零零一张"，
     * 和它自己那张桌子上的牌位断开了 —— 实测就是这个问题。
     * 那种座位本来也没有"手里"这回事：明牌就该亮在自己面前的桌面上，
     * 所以走回出牌区那一块。
     */
    if (entry.hasAgent === false) {
      const step = mw + 2;
      const n = Math.min(list.length, 6);
      const rowW = mw + step * (n - 1);
      const sx = Math.round(entry.play.x - rowW / 2);
      const y = Math.round(entry.play.y - mh / 2);
      list.slice(0, n).forEach((c, i) => {
        out.push({
          id: c.id, card: c, zone: 'revealed', ownerId: entry.id,
          x: sx + i * step, y, w: mw, h: mh,
        });
      });
      return;
    }

    const side = railSide(entry.x);
    const stepX = mw + 2;
    const stepY = mh + 4;

    if (side === 'top') {
      // 顶缘一行横排，从左上角起头（正上方被名牌占着，见函数头）。一行摆不下
      // 就贴着顶缘继续往右铺 —— 上帝视角下再多也还是一行能装下的量
      const cap = Math.max(1, Math.floor((st.w - RAIL_INSET * 2 - mw) / stepX) + 1);
      const n = Math.min(list.length, cap);
      const x0 = RAIL_INSET + lane.lane * stepX;
      list.slice(0, n).forEach((c, i) => {
        out.push({
          id: c.id, card: c, zone: 'revealed', ownerId: entry.id,
          x: x0 + i * stepX, y: EDGE, w: mw, h: mh,
        });
      });
      return;
    }

    // 左右两条边：**竖着贴边排**，一列排满才往桌心方向再起一列。竖排而不是
    // 横排，是因为横排会一路爬过半个桌面 —— 上帝视角下一个对手手上就有十几张，
    // 横着铺会直接铺到他的立绘和出牌区上去。
    const topLimit = lane.yFloor;
    // 整条的高度封顶：不封顶的话上帝视角下这条会从上到下贯穿整个侧边，
    // 末尾压到左下角那块记牌器上（又变成两堆牌叠一起）。
    // 同一条边上有两位时留得更松一点，好让两家各占一列、谁也不挤谁。
    const cap = (lane.lanes > 1 ? 0.82 : 0.62) * (st.h - BAR_H);
    const perCol = Math.max(1, Math.floor((Math.round(cap) + 4) / stepY));
    const cols = Math.min(3, Math.ceil(list.length / perCol));
    const shown = list.slice(0, cols * perCol);
    const stripH = Math.min(perCol, shown.length) * stepY - 4;
    const x0 = side === 'left'
      ? RAIL_INSET + lane.lane * (mw + 5)
      : st.w - RAIL_INSET - mw - lane.lane * (mw + 5);
    // 整列跟座位的"腰"齐平：离得开人，又还认得出这摞牌是谁的
    const y0 = Math.round(Math.min(Math.max(entry.y - entry.h * 0.5 - stripH / 2, topLimit),
                                  Math.max(topLimit, st.h - BAR_H - EDGE - stripH)));
    shown.forEach((c, i) => {
      const col = Math.floor(i / perCol);
      const row = i % perCol;
      // 第二列起往桌心方向让位；车道是横向的，所以还要把车道的位移叠上
      out.push({
        id: c.id, card: c, zone: 'revealed', ownerId: entry.id,
        x: side === 'left' ? x0 + col * (mw + 5) : x0 - col * (mw + 5),
        y: y0 + row * stepY, w: mw, h: mh,
      });
    });
  }

  /**
   * 这一席贴哪条屏幕边缘：左半场贴左缘、右半场贴右缘、正上边缘居中那一位贴顶缘。
   *
   * 正上方居中那一位**不能**贴它的正上方：名牌就顶在它头顶上方的画布上沿，
   * 那一段没有空位（`seat.y - seat.h - 8 - 21` 就是画布最上面那条）。所以它贴
   * 顶缘、从左上角起头 —— 见 `pushRevealedHand` 的函数头。
   */
  function railSide(x) {
    if (Math.abs(x - st.w / 2) <= 1) return 'top';
    return x < st.w / 2 ? 'left' : 'right';
  }

  /**
   * 同一条侧边上可能站着不止一位**亮着牌**的座位（四人局就是一位上排、
   * 一位下排）—— 上帝视角下两家都亮着，"贴边竖排"就会两条画在彼此身上。
   * 所以先按边分组、按高低定车道：每位占一条自己的列位，横向错开一个牌宽。
   * 同时算出左右两条边的**起点下限**：顶缘那条横排放着的时候，
   * 侧边的竖条得从它下面起，不然会在左上角那一小块撞上。
   *
   * @param placed 已经在台上的对手 [{ s, x, y }]（x/y 是脚底落点）
   * @returns Map<座位 id, { lane, lanes, yFloor }>
   */
  function railLanes(placed) {
    const withCards = placed.filter((p) => (p.s.hand || []).some((c) => c.facing === FACE));
    const yFloor = withCards.some((p) => railSide(p.x) === 'top') ? EDGE + MINI_H + 6 : EDGE;
    const out = new Map();
    for (const side of ['top', 'left', 'right']) {
      const on = withCards
        .filter((p) => railSide(p.x) === side)
        .sort((a, b) => a.y - b.y);
      on.forEach((p, k) => out.set(p.s.id, { lane: k, lanes: on.length, yFloor }));
    }
    return out;
  }

  /** 把某个座位这一巡打出的牌摆进出牌区 */
  function pushPlayCards(out, play, byId, ids) {
    if (!ids || !ids.length) return;
    const list = ids.map((id) => byId.get(id)).filter(Boolean);
    if (!list.length) return;
    const maxH = Math.round(play.h * 0.84);
    const maxW = play.w + Math.round(play.w * 0.34); // 允许略微出血，读起来才像"一摞牌"
    let ch = maxH;
    let cw = Math.round(ch / 1.39);
    let step = Math.round(cw * 0.72);
    if (list.length > 1) {
      const need = cw + step * (list.length - 1);
      if (need > maxW) {
        const k = maxW / need;
        ch = Math.max(18, Math.round(ch * k));
        cw = Math.round(ch / 1.39);
        step = Math.max(6, Math.round(Math.min(cw * 0.72, (maxW - cw) / (list.length - 1))));
      }
    }
    const tw = cw + step * (list.length - 1);
    const sx = Math.round(play.x - tw / 2);
    const sy = Math.round(play.y - ch / 2);
    list.forEach((c, i) => {
      out.push({
        id: c.id, card: c, zone: 'play', ownerId: play.ownerId ?? null,
        x: sx + i * step, y: sy, w: cw, h: ch,
      });
    });
  }

  // -------------------------------------------------------------------------
  // 出牌演出
  // -------------------------------------------------------------------------

  /**
   * 让这几张牌「被看见一次」：从出牌者手边举起 → 在身前放大停一下 → 落进出牌区。
   *
   * **不阻塞牌局**，返回是否真的演上了。牌打出去是已经发生的事实（state 早改完了），
   * 演出只是把"这一手是怎么打出来的"补给你看 —— 让牌局停下来等一段动画，
   * 代价是每一次出牌都多等将近一秒，一局十几次就白等十几秒。同一席位上的
   * 新演出会顶掉旧的：他再打一手，前一手已经演示完了。
   *
   * 调用顺序有讲究：**先立演出，再 render**。反过来的话第一帧画的就是
   * 「牌已经躺在出牌区」，然后才被扯回手里重飞一遍 —— 闪那一下比重播还难看。
   * 所以这里只拿「座位」判断能不能演（座位不会因为出牌而消失），具体落点
   * 等绘制时再按**那时**的 layout 查。
   */
  function beginPlayStage(cardIds, ownerId) {
    const ids = (cardIds || []).filter(Boolean);
    if (!ids.length || !st.view) return false;
    const seat = (st.layout.seats || []).find(
      (s) => s.id === ownerId && !s.isMe && s.w && s.hasAgent !== false
    );
    if (!seat) return false;

    st.stages = st.stages.filter((s) => s.seatId !== ownerId);
    st.stages.push({ ids: new Set(ids), seatId: ownerId, t0: nowMs(), dur: STAGE_DUR, done: false });
    pump();
    return true;
  }

  /**
   * 这几张牌落定时该在哪儿。**第一次查得到就记下来，此后按记下的一直演到底。**
   *
   * 为什么必须快照：牌局**不等演出演完**（见 beginPlayStage）。演到一半的时候
   * 这一轮可能已经结束了，出牌区被清空，这几张牌在 layout 里就查不到了 ——
   * 要是每帧都现查，演出会当场消失，而它才刚举起来。记下来之后，牌局跑多快
   * 都只是"屏幕上有几组牌在各自往桌面上落"，不会互相吞。
   */
  function stageTargets(stage) {
    if (stage.target) return stage.target;
    const items = (st.layout.cards || []).filter(
      (c) => c.zone === 'play' && stage.ids.has(c.card && c.card.id)
    );
    if (!items.length) return null;
    stage.target = new Map(items.map((c) => [c.card.id, { x: c.x, y: c.y, w: c.w, h: c.h, item: c }]));
    return stage.target;
  }

  /**
   * 这一张牌此刻该画在哪儿。`land` 是它的落点（见 stageTargets）。
   *
   * 位置以落点那个框反推：起手 / 举起 / 落下三个框都只描述中心与尺寸，
   * 插值出来才是"被举起来"，而不是原地放大。
   */
  function poseFrom(stage, land, id, t) {
    const seat = (st.layout.seats || []).find((s) => s.id === stage.seatId);
    if (!seat) return null;

    const idx = [...stage.ids].indexOf(id);
    const n = stage.ids.size;
    const k = clamp01((t - stage.t0) / stage.dur);

    // 一手几张要在身前摊开 —— 不然一手三张叠成一张，读不出"这一手是几张"。
    // 摊开的次序按它们在出牌区里的先后，飞过去的时候队伍是顺的。
    const zw = land.w * STAGE_ZOOM;
    const zh = land.h * STAGE_ZOOM;
    const spread = (idx - (n - 1) / 2) * (zw * 0.58);
    const hold = {
      x: seat.x + spread - zw / 2,
      y: seat.y - seat.h * STAGE_HOLD_K - zh / 2,
      w: zw,
      h: zh,
    };

    const hw = land.w * STAGE_FROM;
    const hh = land.h * STAGE_FROM;
    const from = {
      x: seat.x - hw / 2,
      y: seat.y - seat.h * STAGE_HAND_K - hh / 2,
      w: hw,
      h: hh,
    };

    const kRise = STAGE_RISE / stage.dur;
    const kSettle = 1 - STAGE_SETTLE / stage.dur;
    if (k < kRise) return lerpBox(from, hold, easeOut(k / kRise));
    if (k < kSettle) return hold;
    return lerpBox(hold, land, easeInOut((k - kSettle) / (1 - kSettle)));
  }

  // -------------------------------------------------------------------------
  // 画
  // -------------------------------------------------------------------------

  function drawFelt(players) {
    ctx.fillStyle = C.base;
    ctx.fillRect(0, 0, st.w, st.h);
    const e = img(tableUrl(players));
    if (!ready(e)) return;
    const cover = Math.max(st.w / TABLE_IMG.w, st.h / TABLE_IMG.h);
    const w = TABLE_IMG.w * cover;
    const h = TABLE_IMG.h * cover;
    ctx.drawImage(e.node, (st.w - w) / 2, (st.h - h) / 2, w, h);
  }

  /**
   * 四周压暗。
   * 桌面铺满整个舞台，没有这层暗角，画面边缘的桌面纹理会和人物抢注意力，
   * 人物反而读不出来。中间留亮，正好罩住桌面中段。
   */
  function drawVignette() {
    const cx = st.w / 2;
    const cy = st.h * 0.48;
    const inner = Math.min(st.w, st.h) * 0.30;
    const outer = Math.max(st.w, st.h) * 0.72;
    const g = ctx.createRadialGradient(cx, cy, inner, cx, cy, outer);
    g.addColorStop(0, 'rgba(0,0,0,0)');
    g.addColorStop(0.62, 'rgba(4,4,6,0.28)');
    g.addColorStop(1, 'rgba(4,4,6,0.78)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, st.w, st.h);
  }

  /** 脚下的接触阴影：没有它，人会像贴纸浮在桌面上 */
  function drawShadow(seat) {
    const w = seat.h * 0.62;
    const h = seat.h * 0.16;
    const cx = seat.x;
    const cy = seat.y + h * 0.10;
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, w / 2);
    g.addColorStop(0, 'rgba(0,0,0,0.62)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.save();
    ctx.translate(cx, cy);
    ctx.scale(1, h / w);
    ctx.translate(-cx, -cy);
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, w / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  function drawPlayArea(seat, ui) {
    const p = seat.play;
    const isTurn = ui.turnId === seat.id;
    ctx.save();
    ctx.fillStyle = C.play;
    roundRect(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 10);
    ctx.fill();
    ctx.setLineDash(isTurn ? [] : [5, 4]);
    ctx.lineWidth = isTurn ? 1.6 : 1;
    ctx.strokeStyle = isTurn ? 'rgba(201,162,39,0.72)' : 'rgba(201,162,39,0.26)';
    roundRect(ctx, p.x - p.w / 2, p.y - p.h / 2, p.w, p.h, 10);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  function drawCard(item, ui) {
    const { x, y, w, h, card } = item;
    const isHover = ui.hoverId === card.id;
    const selected = ui.selectedIds || [];
    const isSel = ui.selectedId === card.id || selected.includes(card.id);
    const cy = y + liftOf(card.id, ui);
    const isFace = card.facing === FACE;
    const vis = card.vis;

    ctx.save();
    if (isSel || isHover) {
      ctx.shadowColor = isSel ? 'rgba(201,162,39,0.55)' : 'rgba(120,170,220,0.35)';
      ctx.shadowBlur = isSel ? 14 : 10;
      ctx.shadowOffsetY = 2;
    }

    ctx.fillStyle = isFace ? C.face : C.back;
    roundRect(ctx, x, cy, w, h, 6);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    if (!isFace) {
      ctx.save();
      roundRect(ctx, x, cy, w, h, 6);
      ctx.clip();
      const g = ctx.createLinearGradient(x, cy, x + w, cy + h);
      g.addColorStop(0, C.backHi);
      g.addColorStop(1, C.back);
      ctx.fillStyle = g;
      ctx.fillRect(x, cy, w, h);
      ctx.strokeStyle = C.backLine;
      ctx.lineWidth = 1;
      const rows = 4;
      for (let i = 1; i < rows; i++) {
        const py = cy + (h / rows) * i;
        ctx.beginPath();
        ctx.moveTo(x + 5, py);
        ctx.lineTo(x + w - 5, py);
        ctx.stroke();
      }
      ctx.restore();
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = card.red ? C.red : C.faceInk;
      ctx.font = `600 ${Math.max(9, Math.round(h * 0.32))}px ${FONT}`;
      ctx.fillText(card.label, x + 5, cy + h * 0.40);
      if (card.glyph) {
        ctx.font = `${Math.max(8, Math.round(h * 0.26))}px ${FONT}`;
        ctx.fillText(card.glyph, x + 5, cy + h * 0.68);
      }
    }

    const borderKey = vis || VIS.ALL;
    // vis 是牌主人的私有状态，只有他自己的手牌拿得到。
    // 别人座位上的牌（包括背面）不该借用「全明」那一档的颜色 ——
    // 那会暗示「这张牌对所有人都明」，而观察者其实什么都不知道。
    const isOwnCard = !!vis;
    const dashed = vis === VIS.SELF || vis === VIS.OTHERS;
    ctx.strokeStyle = isOwnCard ? C.border[borderKey] : C.borderOther;
    ctx.lineWidth = isOwnCard && vis !== VIS.ALL ? 1.8 : 1;
    ctx.setLineDash(dashed ? [4, 3] : []);
    roundRect(ctx, x, cy, w, h, 6);
    ctx.stroke();
    ctx.setLineDash([]);

    if (vis && vis !== VIS.ALL) {
      const label = BADGE_TEXT[vis];
      const bw = Math.max(14, Math.round(w * 0.42));
      const bh = Math.max(12, Math.round(h * 0.22));
      const bx = x + w - bw - 2;
      const by = cy + 2;
      ctx.fillStyle = C.badge[vis];
      roundRect(ctx, bx, by, bw, bh, 4);
      ctx.fill();
      ctx.fillStyle = '#ffffff';
      ctx.font = `11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, bx + bw / 2, by + bh / 2 + 0.5);
      ctx.textBaseline = 'alphabetic';
    }

    ctx.restore();
  }

  /**
   * 记牌器：所有【已经对全桌公开】的牌里，**眼下没在别处摆着的**那些。
   *
   * 已经在出牌区（这一巡谁打了什么）或座位边（手上亮着的牌）摆出来的，
   * 这里不再列第二遍 —— 同一张牌在桌面出现两次，读起来就是"怎么又一堆牌"。
   * 去掉重复之后，剩下这些回答的是另一个问题：**哪些牌已经离手了**。
   *
   * 摆在**左下角**而不是桌面正中（改过一次）：正中是视线焦点，一排谁都不认领的
   * 牌孤零零摆在那里，只会被读成"中间怎么又冒出来一堆牌"。左下角紧挨着玩家
   * 自己的手牌 —— 而记牌本来就是给自己出牌做决策用的。
   * 做成一块有底有边的记录板，而不是一排光牌：牌的样子本身就在说"这是桌上的牌"，
   * 加个面板才说得清"这是一份记录"。
   */
  function drawPublicStrip(view, layout) {
    const shownIds = new Set();
    for (const it of layout.cards) {
      if (it.zone === 'play' || it.zone === 'revealed') shownIds.add(it.id);
    }
    const list = (view.exposed || []).filter((c) => !shownIds.has(c.id));
    if (!list.length) return;

    const mw = MINI_W;
    const mh = MINI_H;
    const step = mw + 4;
    const padX = 12;
    const padTop = 24;
    const padBot = 10;
    // 一行最多 8 张，面板整体压在左下角这一块，别横着爬过半个桌面
    const maxRowW = Math.min(Math.round(st.w * 0.34), 8 * step);
    const perRow = Math.max(1, Math.floor((maxRowW - mw) / step) + 1);
    const rows = Math.min(3, Math.ceil(list.length / perRow));
    const shownList = list.slice(0, rows * perRow);

    const cols = Math.min(shownList.length, perRow);
    const innerW = mw + step * (cols - 1);
    const title = `已出 ${list.length} 张`;
    // 标题宽度按字数估：canvas 的 measureText 在假 DOM 里拿不到
    const panelW = Math.max(innerW, title.length * 8 + 14) + padX * 2;
    const panelH = padTop + mh + (rows - 1) * (mh + 4) + padBot;
    const px = EDGE;
    const py = Math.max(EDGE, Math.round(st.h - BAR_H - panelH - 10));

    ctx.save();
    ctx.fillStyle = 'rgba(10,11,15,0.62)';
    roundRect(ctx, px, py, panelW, panelH, 12);
    ctx.fill();
    ctx.strokeStyle = 'rgba(201,162,39,0.22)';
    ctx.lineWidth = 1;
    roundRect(ctx, px, py, panelW, panelH, 12);
    ctx.stroke();

    ctx.textAlign = 'left';
    ctx.font = `11px ${FONT}`;
    ctx.fillStyle = 'rgba(224,182,74,0.72)';
    ctx.fillText(title, px + padX, py + 16);
    ctx.restore();

    shownList.forEach((card, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      drawCard({
        x: Math.round(px + padX + c * step),
        y: Math.round(py + padTop + r * (mh + 4)),
        w: mw, h: mh, card, zone: 'public',
      }, {});
    });
  }

  // -------------------------------------------------------------------------
  // 视角轮盘
  // -------------------------------------------------------------------------

  /**
   * 右键自己手上的牌 → 盘子的几何。
   *
   * 半圆、朝上：圆心是「关」，前左 / 前 / 前右三块是**另外三档**可见性。
   * 「另外三档」而不是「四档全摆上」：当前那一档摆上去就是一块点了没变化的
   * 格子，而轮盘上每一格都该是一次真的改变。
   *
   * 三块的次序 = 沿 `VIS_ORDER` 从当前档往后数三格。四档本来就是一个环
   * （两个朝向位的四种组合），转轮盘就是在环上走一格 —— 所以不能按"明暗"
   * 排：按大小排的话，从「都亮着」到「只我亮」是一格，从「只我亮」到
   * 「都盖着」却要横跨两格，同一块格子在别处又管另一件事。
   *
   * 靠边的牌要把圆心拉回来一点：半径七十的盘子扣在边上那一张上，最外侧那块
   * 会被画布切掉小半边 —— 切掉的那块照样点得中，但用户看不到自己点的是什么。
   */
  function menuGeometry() {
    const ui = st.ui || {};
    const m = ui.visMenu;
    if (!m || !m.cardId) return null;
    const item = (st.layout.cards || []).find(
      (c) => c.card && c.card.id === m.cardId && c.zone === 'hand'
    );
    if (!item) return null;

    const cur = item.card.vis || VIS.ALL;
    const at = VIS_ORDER.indexOf(cur);
    const next = [1, 2, 3].map((k) => VIS_ORDER[(at + k) % VIS_ORDER.length]);

    const pad = MENU_R * 0.86;
    const cx = Math.max(EDGE + pad, Math.min(item.x + item.w / 2, st.w - EDGE - pad));
    const cy = item.y + liftOf(item.card.id, ui) + item.h / 2;

    // 上半圆切成三块、每块六十度。canvas 的角度以 x 轴正向为 0 且向下为正，
    // 所以「上半」是 π → 2π，三块的中心依次是 210° / 270° / 330°
    // —— 落到屏幕上恰好是 前左 / 前 / 前右。
    const seg = Math.PI / 3;
    const options = next.map((vis, i) => {
      const a0 = Math.PI + i * seg;
      return { vis, a0, a1: a0 + seg, mid: a0 + seg / 2 };
    });

    return { cardId: m.cardId, cx, cy, r: MENU_R, r0: MENU_R0, cur, options };
  }

  /**
   * 点中轮盘的哪一处：圆心是「关」，扇区是「切到那一档」，半圆之外没点中。
   * 判据和画法共用 `menuGeometry` —— 两处各算一份，迟早会有一段"画在这儿、
   * 点在那儿"的错位。
   */
  function menuHitTest(x, y) {
    const g = menuGeometry();
    if (!g) return null;
    const d = Math.hypot(x - g.cx, y - g.cy);
    if (d <= g.r0) return { kind: 'close' };
    if (d > g.r) return null;
    let a = Math.atan2(y - g.cy, x - g.cx);
    if (a < 0) a += Math.PI * 2;
    if (a < Math.PI) return null; // 下半圆没有扇区
    const i = Math.min(2, Math.floor((a - Math.PI) / (Math.PI / 3)));
    return { kind: 'option', vis: g.options[i].vis };
  }

  /** 指甲盖大的一张小牌：用来说明这一档下"谁看得见正面"。左＝你，右＝外人 */
  function drawMiniCard(x, y, w, h, face) {
    ctx.fillStyle = face ? C.face : C.back;
    roundRect(ctx, x, y, w, h, 2);
    ctx.fill();
    ctx.strokeStyle = face ? 'rgba(32,38,46,0.45)' : C.backLine;
    ctx.lineWidth = 1;
    roundRect(ctx, x, y, w, h, 2);
    ctx.stroke();
  }

  function drawVisMenu(ui) {
    const g = menuGeometry();
    if (!g) return;
    const hover = (ui.visMenu && ui.visMenu.hover) || null;
    // 展开：盘子从中心那个圆长出来，150ms。没有这一步，它是一块"啪"地糊上来
    // 的色块，而轮盘的意思正是"从这张牌上长出三个选择"
    const k = easeOut(clamp01((nowMs() - st.menuT0) / MENU_OPEN_MS));
    const r = g.r0 + (g.r - g.r0) * k;
    const rm = (g.r0 + r) / 2;

    ctx.save();
    ctx.globalAlpha = 0.4 + 0.6 * k;

    for (const o of g.options) {
      const on = hover === o.vis;
      ctx.beginPath();
      ctx.arc(g.cx, g.cy, r, o.a0, o.a1);
      ctx.arc(g.cx, g.cy, g.r0, o.a1, o.a0, true);
      ctx.closePath();
      ctx.fillStyle = on ? 'rgba(201,162,39,0.26)' : 'rgba(10,11,15,0.90)';
      ctx.fill();
      ctx.strokeStyle = on ? C.goldSoft : 'rgba(201,162,39,0.34)';
      ctx.lineWidth = on ? 1.8 : 1;
      ctx.stroke();

      // 还没长开的时候不画内容：三块内容全挤在中心那一小块里，比空着更乱
      if (k < 0.55) continue;

      const mx = g.cx + Math.cos(o.mid) * rm;
      const my = g.cy + Math.sin(o.mid) * rm;
      const face = {
        [VIS.ALL]: [true, true],
        [VIS.SELF]: [true, false],
        [VIS.OTHERS]: [false, true],
        [VIS.NONE]: [false, false],
      }[o.vis];
      drawMiniCard(mx - 14.5, my - 20, 12, 16, face[0]);
      drawMiniCard(mx + 2.5, my - 20, 12, 16, face[1]);

      ctx.fillStyle = on ? '#f2e3b0' : 'rgba(232,230,225,0.88)';
      ctx.font = `${on ? 'bold ' : ''}11px ${FONT}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      ctx.fillText(MENU_LABEL[o.vis], mx, my + 11);
    }

    // 圆心那个「关」。它不是装饰：轮盘一开就盖住了牌和自己的手牌区，
    // 不给一个明确的"我改主意了"，用户只能瞎点一处来关掉它。
    ctx.globalAlpha = 1;
    ctx.beginPath();
    ctx.arc(g.cx, g.cy, g.r0 - 2, 0, Math.PI * 2);
    ctx.fillStyle = hover === 'close' ? 'rgba(52,57,66,0.98)' : 'rgba(20,22,27,0.97)';
    ctx.fill();
    ctx.strokeStyle = hover === 'close' ? C.goldSoft : 'rgba(201,162,39,0.50)';
    ctx.lineWidth = 1.4;
    ctx.stroke();

    const s = (g.r0 - 2) * 0.42;
    ctx.strokeStyle = hover === 'close' ? C.goldSoft : 'rgba(232,230,225,0.82)';
    ctx.lineWidth = 1.8;
    ctx.beginPath();
    ctx.moveTo(g.cx - s, g.cy - s);
    ctx.lineTo(g.cx + s, g.cy + s);
    ctx.moveTo(g.cx + s, g.cy - s);
    ctx.lineTo(g.cx - s, g.cy + s);
    ctx.stroke();
    ctx.restore();
  }

  /**
   * 鼠标停到某个座位上时的一圈提示。
   *
   * 牌桌整张画在 canvas 上，DOM 那套 hover 在这里全都不存在 —— 不画点什么，
   * 「点这个人能看 / 改他的设定」就没有任何入口可循，用户只会当那是一张画。
   * 画法克制：一层淡金光晕 + 一圈细描边，盖不住立绘本身。
   */
  function drawSeatFocus(seat) {
    if (seat.isMe || !seat.w || seat.hasAgent === false) return;
    const cx = seat.x;
    const cy = seat.y - seat.h * 0.5;
    ctx.save();
    const rg = ctx.createRadialGradient(cx, cy, 4, cx, cy, seat.h * 0.78);
    rg.addColorStop(0, 'rgba(224,182,74,0.20)');
    rg.addColorStop(1, 'rgba(224,182,74,0)');
    ctx.fillStyle = rg;
    ctx.fillRect(cx - seat.h, cy - seat.h * 0.85, seat.h * 2, seat.h * 1.8);

    ctx.strokeStyle = 'rgba(224,182,74,0.75)';
    ctx.lineWidth = 1.5;
    roundRect(ctx, seat.x - seat.w / 2 - 4, seat.y - seat.h - 4, seat.w + 8, seat.h + 8, 12);
    ctx.stroke();
    ctx.restore();
  }

  function drawPortrait(seat) {
    const e = seat.avatar ? img(avatarUrl(seat.avatar)) : img(DEFAULT_SEAT_URL);
    const x = Math.round(seat.x - seat.w / 2);
    const y = Math.round(seat.y - seat.h);

    ctx.save();
    /**
     * 三种座位要画得不一样，否则读不出「这里为什么没有人」：
     *   · 有智能体        —— 正常立绘
     *   · 有座位但没有形象 —— 这张位子该有人却没人（名册里的人不够），
     *                        垫一圈金色光晕，剪影才读得成「空位」而不是「没东西」
     *   · 不是智能体的座位 —— 21 点的荷官这种规则座位，本来就不配形象。
     *                        它**不是空位**，不该发光，画一个中性的虚线轮廓。
     */
    const isRuleSeat = seat.hasAgent === false;
    if (isRuleSeat) {
      ctx.strokeStyle = 'rgba(139,143,154,0.30)';
      ctx.setLineDash([5, 5]);
      ctx.lineWidth = 1;
      roundRect(ctx, x, y, seat.w, seat.h, 8);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    if (!seat.avatar) {
      const cx = seat.x;
      const cy = seat.y - seat.h * 0.45;
      const rg = ctx.createRadialGradient(cx, cy, 4, cx, cy, seat.w * 0.95);
      rg.addColorStop(0, 'rgba(201,162,39,0.30)');
      rg.addColorStop(1, 'rgba(201,162,39,0)');
      ctx.fillStyle = rg;
      ctx.fillRect(cx - seat.w, cy - seat.h * 0.6, seat.w * 2, seat.h * 1.3);
    }
    if (ready(e)) {
      ctx.shadowColor = 'rgba(0,0,0,0.55)';
      ctx.shadowBlur = 14;
      ctx.shadowOffsetY = 7;
      ctx.drawImage(e.node, x, y, seat.w, seat.h);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
      ctx.shadowOffsetY = 0;
    } else {
      // 图还没到位/加载失败：画一个占位轮廓，别让那一块彻底空着 ——
      // 空白没法区分「还没加载」和「本来就没人」
      ctx.strokeStyle = 'rgba(139,143,154,0.35)';
      ctx.setLineDash([4, 4]);
      roundRect(ctx, x, y, seat.w, seat.h, 8);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    // 未配置形象时给一圈克制的高光，跟真立绘区分开
    if (!seat.avatar && ready(e)) {
      ctx.strokeStyle = 'rgba(201,162,39,0.45)';
      ctx.lineWidth = 1;
      roundRect(ctx, x - 1, y - 1, seat.w + 2, seat.h + 2, 8);
      ctx.stroke();
    }
    ctx.restore();
  }

  /** 名牌挂头顶 —— 2D 正面视角下人物上方就是桌面，有地方放 */
  function drawPlate(seat, ui) {
    const isTurn = ui.turnId === seat.id;
    const thinking = ui.thinkingId === seat.id;
    const text = `${seat.name} · ${seat.handCount} 张 · ${seat.score} 分`;
    ctx.save();
    ctx.font = `12.5px ${FONT}`;
    const w = Math.round(ctx.measureText(text).width + 22 + (thinking ? 62 : 0));
    const h = 21;
    const x = Math.round(seat.x - w / 2);
    const y = Math.round(seat.y - seat.h - 8 - h);

    ctx.fillStyle = C.plateBg;
    roundRect(ctx, x, y, w, h, 999);
    ctx.fill();
    ctx.strokeStyle = isTurn ? C.gold : C.line;
    ctx.lineWidth = 1;
    if (isTurn) {
      ctx.shadowColor = 'rgba(201,162,39,0.45)';
      ctx.shadowBlur = 12;
    }
    roundRect(ctx, x, y, w, h, 999);
    ctx.stroke();
    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;

    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font = `12.5px ${FONT}`;
    ctx.fillStyle = C.goldSoft;
    ctx.fillText(seat.name, x + 11, y + h / 2 + 0.5);
    const nw = ctx.measureText(seat.name).width;
    ctx.fillStyle = C.muted;
    ctx.fillText(` · ${seat.handCount} 张 · ${seat.score} 分`, x + 11 + nw, y + h / 2 + 0.5);
    if (thinking) {
      const mw = ctx.measureText(` · ${seat.handCount} 张 · ${seat.score} 分`).width;
      ctx.fillStyle = C.goldSoft;
      ctx.fillText(' · 思考中…', x + 11 + nw + mw, y + h / 2 + 0.5);
    }
    ctx.textBaseline = 'alphabetic';
    ctx.restore();
  }

  /** 屏幕底部那一行身份说明 */
  function drawMyPlate(view) {
    const mine = view.seats.find((s) => s.isMe);
    const y = st.h - CARD_H - 14 - 12;
    ctx.save();
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.font = `12.5px ${FONT}`;
    const head = '你';
    const rest = mine
      ? ` · 手牌 ${mine.handCount} 张 · ${mine.score} 分`
      : '';
    const hw = ctx.measureText(head).width;
    const rw = ctx.measureText(rest).width;
    const x = Math.round(st.w / 2 - (hw + rw) / 2);
    ctx.textAlign = 'left';
    ctx.fillStyle = C.goldSoft;
    ctx.fillText(head, x, y);
    ctx.fillStyle = C.muted;
    ctx.fillText(rest, x + hw, y);
    ctx.restore();
  }

  function wrapText(text, maxW, maxLines = 5) {
    const lines = [];
    let cur = '';
    for (const ch of String(text)) {
      if (ch === '\n') { lines.push(cur); cur = ''; continue; }
      if (ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; } else { cur += ch; }
    }
    if (cur) lines.push(cur);
    return lines.slice(0, maxLines);
  }

  function drawBubble(bubble, seat) {
    if (!seat || !bubble.text) return;
    const maxW = 210;
    ctx.font = `12px ${FONT}`;
    const lines = wrapText(bubble.text, maxW - 18);
    const lh = 17;
    const bw = Math.min(maxW, Math.max(60, ...lines.map((l) => ctx.measureText(l).width)) + 18);
    const bh = lines.length * lh + 12;

    let bx = seat.x - bw / 2;
    const by = seat.bubbleY - bh;
    bx = Math.max(EDGE, Math.min(bx, st.w - bw - EDGE));
    const y = Math.max(EDGE, by);

    ctx.save();
    ctx.fillStyle = C.bubble;
    ctx.strokeStyle = C.bubbleBorder;
    ctx.lineWidth = 1;
    roundRect(ctx, bx, y, bw, bh, 10);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = C.text;
    ctx.textAlign = 'left';
    ctx.font = `12px ${FONT}`;
    lines.forEach((l, i) => ctx.fillText(l, bx + 9, y + 19 + i * lh));
    ctx.restore();
  }

  function render(view, ui = {}) {
    st.view = view;
    st.ui = ui;
    if (!view) return;

    // 轮盘的展开动画以「这是不是一次新的打开」为起点。app 只管摆出 ui.visMenu
    // 和它的内容，时间基准由渲染层认领 —— 两边各自记时间的话，量出来的差值
    // 会是个毫无意义的巨大数字（performance.now 和 Date.now 不是同一个零点）。
    if (ui.visMenu && ui.visMenu.cardId !== st.menuCard) {
      st.menuCard = ui.visMenu.cardId;
      st.menuT0 = nowMs();
    } else if (!ui.visMenu) {
      st.menuCard = null;
    }

    ctx.setTransform(st.dpr, 0, 0, st.dpr, 0, 0);
    ctx.clearRect(0, 0, st.w, st.h);

    const layout = computeLayout(view, ui);
    st.layout = layout;
    const seatMap = Object.fromEntries(layout.seats.map((s) => [s.id, s]));

    // 把「玩家出牌区的上沿」交给 CSS：操作坞就贴在它上面。
    // 量出来而不是写死 —— 人数一换、窗口一改，出牌区就挪了，
    // 写死的坞会从桌面上滑下来压住自己的牌。
    const me = layout.seats.find((s) => s.isMe);
    const host = canvas.parentElement;
    if (me && host && host.style && typeof host.style.setProperty === 'function') {
      host.style.setProperty('--play-top', `${Math.round(me.play.y - me.play.h / 2)}px`);
    }

    const now = nowMs();

    drawFelt(view.seats.length);
    drawVignette();

    // 规则座位（荷官）没有立绘，也就没有脚下的接触阴影
    for (const s of layout.seats) if (!s.isMe && s.hasAgent !== false) drawShadow(s);
    for (const s of layout.seats) drawPlayArea(s, ui);

    // 出牌区里的牌：自己那块也要画，跟手牌一样是"我的牌"。
    // 正在演的那几张先扣下 —— 它们此刻的位置在座位上，等立绘画完再补，
    // 否则"举在身前"的牌会被它自己那张立绘盖掉下半截。
    const onStage = new Set();
    for (const s of st.stages) {
      const t = stageTargets(s);
      if (t) for (const id of t.keys()) onStage.add(id);
    }
    for (const it of layout.cards) {
      if (it.zone !== 'play' || onStage.has(it.id)) continue;
      drawCard(it, ui);
    }

    drawPublicStrip(view, layout);

    // 各座位手上"我看得见的牌"（21 点的庄家明牌 / 上帝视角的全部手牌）
    for (const it of layout.cards) if (it.zone === 'revealed') drawCard(it, ui);

    for (const s of layout.seats) {
      if (s.isMe) continue;
      const seatState = s.seat || {};
      const dim = seatState.folded || seatState.alive === false;
      ctx.save();
      if (dim) ctx.globalAlpha = 0.45;
      drawPortrait(s);
      ctx.restore();
    }
    for (const s of layout.seats) {
      if (s.isMe) continue;
      const seatState = s.seat || {};
      ctx.save();
      if (seatState.folded || seatState.alive === false) ctx.globalAlpha = 0.55;
      drawPlate(s, ui);
      ctx.restore();
    }

    // 鼠标停在谁身上：给一圈提示。
    // canvas 不是 DOM，没有光标变化也没有 hover 底色 —— 不画点什么，
    // "点这个人能看他的设定"就没有任何入口可循。
    if (ui.hoverSeat && seatMap[ui.hoverSeat]) drawSeatFocus(seatMap[ui.hoverSeat]);

    // 我的手牌排在最后的牌上面 —— 自己手上的牌永远看得见
    for (const it of layout.cards) if (it.zone === 'hand') drawCard(it, ui);
    drawMyPlate(view);

    // 说话气泡：它是「人说的话」，被牌盖住就说不过去了
    for (const b of ui.bubbles || []) drawBubble(b, seatMap[b.seatId]);

    // 演出中的牌压在立绘之上 —— 它讲的是"这个人此刻打出了这几张"
    for (const s of st.stages) {
      const t = stageTargets(s);
      if (!t) continue;
      for (const [id, land] of t) {
        const pose = poseFrom(s, land, id, now);
        if (pose) drawCard({ ...land.item, ...pose }, ui);
      }
    }

    // 轮盘最上层：它是玩家此刻正在操作的东西，被任何一张牌压住都点不着
    drawVisMenu(ui);
    if (menuOpening()) pump();

    if (typeof handlers.onLayout === 'function') handlers.onLayout(layout, view, ui);
  }

  function hitTest(x, y) {
    const items = st.layout.cards;
    for (let i = items.length - 1; i >= 0; i--) {
      const it = items[i];
      // 摆在座位边上的明牌只是"给人看"的，点它不构成任何操作
      if (it.zone === 'revealed') continue;
      const lift = liftOf(it.card.id, st.ui);
      if (x >= it.x && x <= it.x + it.w && y >= it.y + lift && y <= it.y + lift + it.h) {
        return it;
      }
    }
    return null;
  }

  /**
   * 点着哪个人了。返回座位 entry；没点着返回 null。
   *
   * 调用方要**先问 hitTest（牌）再问这个**：牌摆在人前面，
   * 重叠时点下去该是出牌，而不是弹出一份资料。
   * 判定框比立绘本身松一圈（SEAT_PAD）—— 立绘是异形的，手指落在它边上一点也该算点中。
   */
  function seatHitTest(x, y) {
    const seats = (st.layout && st.layout.seats) || [];
    for (let i = seats.length - 1; i >= 0; i--) {
      const s = seats[i];
      // 玩家自己那一席没有立绘（屏幕底边整条留给他），也就没有什么可点开的
      if (s.isMe || !s.w) continue;
      if (x >= s.x - s.w / 2 - SEAT_PAD && x <= s.x + s.w / 2 + SEAT_PAD
        && y >= s.y - s.h - SEAT_PAD && y <= s.y + SEAT_PAD) {
        return s;
      }
    }
    return null;
  }

  return {
    resize, render, hitTest, seatHitTest,
    /** 出牌演出（见 beginPlayStage）：返回是否真的演上了，不等它演完 */
    beginPlayStage,
    /**
     * 这一张牌此刻画在哪儿 —— 演出中给插值后的框，否则给 null。
     * 「当前这一帧那张牌到底在哪」本来就是个正当的查询（调试、以及以后若要做
     * "点住飞出来的那张牌"），顺手也是门禁唯一量得到演出过程的出口：
     * layout 里那些牌**始终是落定位置**，演出不写它。
     */
    stagePoseFor: (cardId) => {
      const stage = st.stages.find((s) => s.ids.has(cardId));
      if (!stage) return null;
      const t = stageTargets(stage);
      const land = t && t.get(cardId);
      return land ? poseFrom(stage, land, cardId, nowMs()) : null;
    },
    /** 视角轮盘的几何与判定。两者共用同一份几何，测试也读它 */
    menuGeometry, menuHitTest,
    state: st,
  };
}
