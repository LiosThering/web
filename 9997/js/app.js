/**
 * app.js — 主循环与交互
 *
 * 回合流程（人与 AI 走同一条通道）
 * ------------------------------------------------------------------
 *   轮次推进 → 取当前行动者 → 开一个「回合」
 *   回合内部可以行动多次（上限由规则包决定）：
 *       人类：左键出牌 / 右键翻牌 / 点「结束回合」
 *       AI  ：LLM 决策（或本地兜底）→ 本地校验 → 写回事件流
 *   出牌即完成本轮义务 → 规则包 signal 回合结束
 *   → 投影渲染
 *
 * AI 的 LLM 回路带重试：结构解析失败或规则校验不通过时，
 * 把具体错误回传给模型让它改，最多三次；仍拿不到合法动作就
 * 交给本地兜底策略，而不是白白过牌。
 *
 * 破例（违规）动作只在 LLM 回路里出现：本地兜底永远守规矩。
 */

import {
  createAgent, addNote, applyProfilePatch, bumpStats, markNotesDelivered,
} from './agent/agent.js';
import { buildTimeline } from './agent/context.js';
import { chooseLocalDecision, hasLLMConfig } from './agent/local-policy.js';
import { VIS_META } from './core/cards.js';
import {
  act, DEFAULT_MAX_ACTIONS_PER_TURN, describeAction, getRuleSet, isEndTurnAction,
  listRuleSets, RETURN,
} from './core/rules.js';
import { applyEvent, applyEvents, createState, ev } from './core/state.js';
import { resolveSeed, SEED_SOURCES } from './core/rng.js';
import { project } from './core/view.js';
import { createRolloutEngine, describeSpecialRules, ENGINE_MODES, getEngineMode } from './engine/winrate.js';
import { callLLM, getPreset, isSelectable, listModels, PROVIDER_PRESETS, SELECTABLE_PRESETS, DEFAULT_PROVIDER_ID, wasTruncated } from './llm/adapter.js';
import { buildPrompt } from './llm/prompt.js';
import { buildCorrectionPrompt, MAX_ATTEMPTS, parseResponse } from './llm/protocol.js';
import { createTableRenderer } from './render/table.js';
import { avatarUrl } from './ui/avatars.js';
import { initLobby, fallbackAgent } from './ui/lobby.js';
import { getRoster, onRosterChange } from './ui/roster.js';
import { doudizhu } from './rules/doudizhu/index.js';
// 引入即注册（registerRuleSet 在模块里执行）。规则包列表由注册表生成，
// 所以新增玩法只需要在这里加一行 import。
import './rules/blackjack/index.js';
import './rules/highcard/index.js';
import './rules/holdem/index.js';
import { sandboxDuel } from './rules/sandbox.js';
import { parseCombo } from './rules/doudizhu/combo.js';

const CONFIG_KEY = 'ai-card-table.config.v1';
/**
 * 配置结构版本。**改动「默认服务商」这类语义时必须 +1。**
 *
 * 原因：页面一打开就会把当时的默认服务商连同地址、模型一起写进 localStorage。
 * 于是「用户从没选过」和「用户亲手选了默认那家」在存储里长得一模一样。
 * 只有版本号能区分这两者，也只有版本号能让迁移只发生一次。
 */
const CONFIG_VERSION = 2;
const PALETTE = ['#185FA5', '#0F6E56', '#993C1D', '#534AB7'];
/** 人数下拉框的默认值（会被规则包的区间夹住） */
const DEFAULT_PLAYER_COUNT = 3;

/**
 * 名册里挑不出人时，兜底补上的临时对手（名字是 AI-N）。
 * 他们也在牌桌上，所以同样要有**对破坏规矩的态度** —— 否则一桌人里
 * 混进几个"没有性格"的，那几席的判断会退回成默认的守规矩。
 */
const DEFAULT_PERSONAS = [
  '你是个浸淫赌桌多年的老手，说话简短带刺，喜欢用虚张声势压迫对手。'
    + '规矩你早就不放在眼里了，手上有便宜的破例就顺手用掉。',
  '你是个谨慎的新人，容易紧张，出牌保守，常把想法小声说出来。'
    + '你怕被抓，坏规矩的念头一冒出来就被自己按回去——除非已经被逼到墙角。',
  '你是个喜欢开玩笑的人，输赢都笑嘻嘻的，但心里一直在算牌。'
    + '你破不破例看心情，觉得好玩就干一次，被抓住还当笑话讲。',
  '你是个沉默寡言的观察者，话很少，但每次开口都直指要害。'
    + '你只在能一击定局的时候动手，做完也不要理由。',
];

/**
 * 智能体面板里人设显示多少字。
 * 这个数要跟着默认人设一起长：现在一条 80~110 字，里面那句「对破坏规矩的态度」
 * 恰恰是玩家点开人物最想确认的一句，还按 90 截就等于没写给他看。
 */
const PERSONA_SHOWN = 200;

const app = {
  ruleSet: doudizhu,
  state: null,
  agents: [],
  humanId: 'p0',
  config: {},
  /** 启动层（选模式 → 选谁和你玩）。开局前它是唯一的名单出处 */
  lobby: null,
  /** 当前下拉框里的模型清单（预设自带 or 从接口拉回来的） */
  modelOptions: [],
  ui: {
    hoverId: null, selectedId: null, selectedIds: [], thinkingId: null,
    hint: '', godView: false,
    /**
     * 视角轮盘。非空时形如 `{ cardId, hover }` —— `hover` 是鼠标停在哪一块
     * （`null` / `'close'` / 某一档的 vis 值），由渲染层画出来、也由渲染层判定，
     * 这里只记住"盘子钉在哪张牌上"。
     */
    visMenu: null,
  },
  winrateEngine: createRolloutEngine(),
  /** 最近一次算出的胜率表（给侧栏「胜率引擎」面板显示） */
  lastRates: null,
  specialRules: [],
  contextPolicy: {},
  running: false,
  humanResolver: null,
  seed: null,
  /** 本局种子的完整来历（来源、时间、原文），用于界面回显 */
  seedInfo: null,
  /** 最近几局的种子：时间种子模式下用来错开同一毫秒内连开的两局 */
  recentSeeds: [],
};

let renderer = null;
/**
 * 对局令牌。每开一局 +1，正在跑的那个循环发现自己的令牌过期就立刻收手。
 * 有了它，「新开一局」在对局中途也点得动 —— 旧循环可能在等人类点击，
 * 也可能正在等 LLM 回复，任一种情况下它都不许再往新状态上写东西。
 */
let gameToken = 0;
const $ = (id) => document.getElementById(id);

/** 当前规则包允不允许多选出牌 */
function multiSelect() {
  return !!app.ruleSet.multiSelect;
}

/**
 * 点一张自己的牌算什么意思。由规则包声明：
 *   'play'（默认）左键点牌即出牌   —— 斗地主那一类「牌就是我打出的东西」
 *   'select'       点牌只是选中
 *   'none'         点牌没有意义，动作靠下方按钮 —— 21 点就是这一档：
 *                  它的动作是「要牌/停牌/双倍/分牌」，根本不指定牌，
 *                  左键点牌若还按「出牌」处理，会立刻被自己的规则拒绝。
 */
function cardGesture() {
  return app.ruleSet.cardGesture || (multiSelect() ? 'select' : 'play');
}

/** 规则包允许的动作参数 */
function actionOpts() {
  return { allowBreach: allowBreach() };
}

// ---------------------------------------------------------------------------
// 配置持久化
// ---------------------------------------------------------------------------

/**
 * 认领配置里的服务商。
 *
 * 为什么需要这一步：服务商决定的不只是名字，还有【协议风格】。原来代码里
 * 写的是 `app.config.providerId || 'anthropic'` —— 老用户从没碰过那个下拉，
 * 配置里就存着第一次自动写入的 anthropic；后来他把地址改成了自己的中转，
 * 于是变成「Anthropic 的协议 + OpenAI 兼容的地址」，请求怎么打都不通，
 * 而界面上还老老实实显示着 Claude。默认值不该是「当初随手选的那家」，
 * 而应当由【地址】反推 —— 地址是用户亲手填的，它才是事实。
 */
export function reconcileProvider(cfg) {
  const out = { ...(cfg || {}) };
  const matched = PROVIDER_PRESETS.find((p) => p.baseUrl && p.baseUrl === out.baseUrl);
  if (matched) {
    out.providerId = matched.id;
  } else if (out.baseUrl) {
    // 地址不在任何预设里 = 用户自己的中转。标签跟着地址走，协议退回最通用的
    // OpenAI 兼容 —— 中转站绝大多数是这一种。
    if (out.providerId !== 'custom') out.providerId = 'custom';
    // 顺手标成「动过」：否则 applyPreset('custom') 会拿预设里的空地址把它清掉。
    out.touchedUrl = true;
  } else if (!out.providerId) {
    out.providerId = DEFAULT_PROVIDER_ID;
  }
  // 协议风格一律由服务商推导，不允许两者各说各话 —— 之前就是它们分头存在存储里，
  // 才出现了「协议是 Claude 的、地址是别人的中转」这种怎么打都不通的组合。
  out.style = getPreset(out.providerId).style;
  return out;
}

/**
 * 配置迁移（纯函数，方便断言）。
 *
 * v1 存下来的配置里，providerId / baseUrl / model 可能是「当年的默认值」，
 * 用户一次都没碰过，却和「亲手选的」完全同形。唯一能分辨的信号是——填过 Key 没有：
 * 没填过 Key 的配置本来就用不了，丢掉零代价；填过 Key 的说明真在用，原样尊重。
 */
export function migrateConfig(cfg) {
  const out = { ...(cfg || {}) };
  if (out.cfgVersion !== CONFIG_VERSION && !out.apiKey) {
    for (const k of ['providerId', 'style', 'baseUrl', 'model', 'extraBody', 'touchedUrl']) {
      delete out[k];
    }
  }
  out.cfgVersion = CONFIG_VERSION;
  return reconcileProvider(out);
}

function loadConfig() {
  let cfg = {};
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    cfg = (raw ? JSON.parse(raw) : null) || {};
  } catch {
    return migrateConfig({});
  }
  return migrateConfig(cfg);
}

function persistConfig() {
  try {
    localStorage.setItem(CONFIG_KEY, JSON.stringify(app.config));
  } catch {
    /* 隐私模式下写入会失败，忽略即可 */
  }
}

/** 破例是否被允许（默认允许，由用户开关控制） */
function allowBreach() {
  return app.config.allowBreach !== false;
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function toast(msg) {
  const box = $('toast');
  box.textContent = msg;
  box.classList.add('show');
  clearTimeout(toast._t);
  // 名册导入的警告可能有一整句「有 N 位的形象这台机器上没有（…）」，读得慢，
  // 2.6 秒不够
  toast._t = setTimeout(() => box.classList.remove('show'), 4200);
}

function updateAgent(agent) {
  if (!agent) return;
  const i = app.agents.findIndex((a) => a.id === agent.id);
  if (i >= 0) app.agents[i] = agent;
}

function agentOf(id) {
  return app.agents.find((a) => a.id === id);
}

function maxActionsPerTurn(playerId) {
  const fn = app.ruleSet.maxActionsPerTurn;
  const n = typeof fn === 'function' ? Number(fn.call(app.ruleSet, app.state, playerId)) : NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_MAX_ACTIONS_PER_TURN;
}

function mustEndTurn(playerId) {
  const fn = app.ruleSet.mustEndTurn;
  return typeof fn === 'function' ? !!fn.call(app.ruleSet, app.state, playerId) : false;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function collectBubbles(view) {
  const latest = new Map();
  for (const e of view.events) {
    if (e.type === 'speak' && e.payload?.text) latest.set(e.actorId, e.payload.text);
  }
  return [...latest.entries()].map(([seatId, text]) => ({ seatId, text }));
}

function renderAll(uiPatch = {}) {
  Object.assign(app.ui, uiPatch);
  // 轮盘钉在一张牌上，先让它自己失效再画 —— 否则会出现"盘子还在，
  // 但底下那张牌已经打出去了"这种点了没反应的界面
  pruneVisMenu();

  // 底部按钮的可用性跟着「是不是轮到人类」走，而不是开局关一次、局终开一次。
  // 之前只在 runGame 开头 setControlsEnabled(false)，人类回合里没人把它打开 ——
  // 于是整局按钮都是灰的，玩家点「出牌」毫无反应。测试没抓到，是因为
  // e2e 与 dom-smoke 都直接调 humanResolver 代打，从不碰真实按钮。
  setControlsEnabled(humanCanAct());

  if (!app.state) return;

  const view = project(app.state, app.ui.godView ? null : app.humanId);
  // 立绘挂在座位上。投影层不管形象（那是名册的事），这里把它贴到 view 上；
  // 渲染层只认 view.seats[].avatar —— 让它自己回头去查 app.agents 的话，
  // 「谁能看到什么」这条唯一的信息边界就多开了一个口子。
  for (const s of view.seats) {
    const a = agentOf(s.id);
    s.avatar = a ? a.avatar : null;
    // 「这张位子上有没有智能体」和「他有没有形象」是两件事：
    //   荷官这种规则座位本来就不配智能体，它不是"空位"；
    //   而名册里的人不够时补出来的兜底身份**是**智能体、只是没有形象。
    // 渲染层靠这个布尔值决定画不画"空位"的金色光晕。
    s.hasAgent = !!a;
  }
  renderer.render(view, {
    hoverId: app.ui.hoverId,
    hoverSeat: app.ui.hoverSeat,
    selectedId: app.ui.selectedId,
    selectedIds: app.ui.selectedIds || [],
    thinkingId: app.ui.thinkingId,
    turnId: app.state.turn,
    hint: app.ui.hint,
    visMenu: app.ui.visMenu,
    bubbles: collectBubbles(view),
    // 上帝视角下投影里没有观察者，渲染层要靠它认领"屏幕前那个人"坐在哪一席
    humanId: app.humanId,
  });

  const status = typeof app.ruleSet.statusLine === 'function'
    ? app.ruleSet.statusLine(app.state)
    : '';
  const statusEl = $('rule-status');
  if (statusEl) statusEl.textContent = status;

  renderTimeline(view);
  renderAgentPanel();
  renderEnginePanel();
  renderActionBar();
}

/**
 * 胜率引擎面板。
 *
 * 这一块不是装饰：胜率是本地算出来的，如果不在界面上摊开，用户既看不到
 * 引擎到底在算什么，也无从判断它有没有在胡编。所以把最近一次决策的
 * 采样数、耗时、前几名的胜率、以及智能体最后选了什么，全部写出来。
 */
function renderEnginePanel() {
  const host = $('engine-panel');
  if (!host) return;
  host.textContent = '';

  const mode = getEngineMode(app.config.engineMode || 'normal');
  const info = app.lastRates;
  const head = el('div', 'engine-head', `${app.winrateEngine.name} · ${mode.label}`);
  head.appendChild(el('span', 'engine-sub', mode.hint));
  host.appendChild(head);

  if (!mode.budgetMs) {
    host.appendChild(el('div', 'engine-empty', '引擎已关闭。智能体只能凭模型自己的判断出牌。'));
    return;
  }
  if (!info) {
    host.appendChild(
      el('div', 'engine-empty', '还没有算过。每次有智能体行动之前，本地会从它自己的视角把看不见的牌补全成上百个完整牌局，逐个候选打完再统计。')
    );
    return;
  }
  if (!info.ok) {
    host.appendChild(el('div', 'engine-empty', info.reason || '本次没有算出胜率。'));
    return;
  }

  // 「对手是谁」必须写在明面上。同一副牌、同一手候选，换一档对手强度，
  // 胜率的读数会整体平移 —— 不标出来的话，用户看到数字变了会以为局面变了。
  const opponentLabel = {
    smart: '对手按稳健路线应对',
    greedy: '对手按简单规则应对',
    // 比大小：对手按「自己看得见的牌」决定要不要换牌，不看别人的牌。
    steady: '对手按稳健路线应对（该换就换）',
    // 21 点的对手是庄家，而庄家没有选择：17 点以下必须要牌是规则写死的。
    // 所以这一档不是「强度」，是「按规则行动」。
    'dealer-fixed': '庄家按固定规则行动（17 点以下必须要牌）',
    // 德州扑克：对手按底池赔率决定跟/弃/加，不看别人的底牌。
    'odds-based': '对手按底池赔率应对（跟弃加各有门槛）',
  }[info.opponent] || '';

  // 排序用哪个度量也要写出来：21 点按期望分排（双倍/分牌会把注翻倍），
  // 斗地主按赢面排。不写清楚，用户会拿「胜率 43% 排第一」当成 bug。
  const metricLabel = info.metric === 'ev'
    ? '按期望分排序（注的大小已计入）'
    : '按赢面排序';

  const stat = [
    info.agent || '',
    // 「精确」看的是 exact，不是 metric。德州扑克按期望分排序，但它的值
    // 同样是采样来的（对手怎么打不由规则写死），拿 metric 当判据会把它
    // 标成「精确解·零采样」，那句话是错的。
    info.exact ? '精确解' : `模拟 ${info.samples || 0} 局`,
    `用时 ${Math.round(info.elapsedMs || 0)}ms`,
    info.exact
      ? '零采样·结果唯一'
      : `每个候选 ${info.minSamples === info.maxSamples ? info.minSamples : `${info.minSamples}~${info.maxSamples}`} 局`,
    metricLabel,
    // 无效局数是引擎的健康指标：它一旦变大，说明有候选在补全出的世界里
    // 根本走不通，那一行的胜率是空白 —— 不写出来的话，用户只会觉得
    // 「这行怎么没数字」，而无从判断是引擎在偷懒还是局面真的算不出来。
    info.invalid ? `丢弃 ${info.invalid} 局` : '',
    opponentLabel,
  ].filter(Boolean).join(' · ');
  host.appendChild(el('div', 'engine-stat', stat));

  const rows = (info.rows || [])
    .filter((r) => typeof r.winRate === 'number')
    .sort((a, b) => b.winRate - a.winRate)
    .slice(0, 8);

  if (!rows.length) {
    host.appendChild(el('div', 'engine-empty', '本次没有采到有效样本。'));
    return;
  }

  const bar = el('div', 'engine-rows');
  for (const r of rows) {
    const row = el('div', 'engine-row');
    const pct = `${(r.winRate * 100).toFixed(1)}%`;
    const fill = el('span', 'engine-bar');
    fill.style.width = `${Math.max(2, Math.round(r.winRate * 100))}%`;
    row.appendChild(el('span', 'engine-pct', pct));
    row.appendChild(fill);
    row.appendChild(el('span', 'engine-label', describeAction(r.action)));
    row.appendChild(el('span', 'engine-n', `${r.samples} 局`));
    if (r.recommended) row.appendChild(el('span', 'engine-tag', '最优'));
    const chosenText = info.chosen || '';
    if (chosenText && chosenText.includes(describeAction(r.action))) {
      row.appendChild(el('span', 'engine-tag chosen', '它选了'));
    }
    bar.appendChild(row);
  }
  host.appendChild(bar);

  // 没算出胜率的候选也摆出来。不摆的话，用户只看到「表里少了几行」，
  // 既不知道少了哪几个走法，也不知道是引擎算不动还是这些走法本身有问题。
  const blanks = (info.rows || []).filter((r) => typeof r.winRate !== 'number');
  if (blanks.length) {
    const shown = blanks.slice(0, 3)
      .map((r) => `「${describeAction(r.action)}」${r.reason ? `（${r.reason}）` : ''}`)
      .join('、');
    host.appendChild(el('div', 'engine-blank',
      `${blanks.length} 个候选没算出胜率：${shown}${blanks.length > 3 ? ' 等' : ''}`));
  }

  if (info.chosen) {
    host.appendChild(el('div', 'engine-chosen', `智能体最终选择：${info.chosen}`));
  }
  const breachRows = (info.breaches || []).filter((r) => typeof r.winRate === 'number');
  if (breachRows.length) {
    const best = breachRows.slice().sort((a, b) => b.winRate - a.winRate)[0];
    host.appendChild(
      el('div', 'engine-note',
        `破例动作也算了：最划算的是「${describeAction(best.action)}」，胜率 ${(best.winRate * 100).toFixed(1)}%、期望分 ${best.ev >= 0 ? '+' : ''}${(best.ev || 0).toFixed(2)}（已扣罚分）。`)
    );
  }
}

/**
 * 动作栏：把「不能用鼠标直接完成」的合规动作摆成按钮。
 *
 * 出牌靠点牌（或者多选后点「出牌」），翻牌靠右键，认输有专用按钮 ——
 * 但叫地主、过牌这类动作没有天然的手势，只能给按钮。
 * 按钮文案直接取自规则包给出的 label，所以换成别的玩法也能用。
 */
const ACTION_BAR_SKIP = new Set(['play', 'reveal', 'fold']);

function renderActionBar() {
  const host = $('action-bar');
  if (!host) return;
  host.textContent = '';
  if (!app.humanResolver || !app.state) return;

  let legal = [];
  try {
    legal = app.ruleSet.legalActions(app.state, app.humanId);
  } catch {
    return;
  }
  for (const a of legal) {
    if (!a || ACTION_BAR_SKIP.has(a.type)) continue;
    const btn = el('button', 'btn small', a.label || describeAction(a));
    btn.addEventListener('click', () => submitHuman(a));
    host.appendChild(btn);
  }
}

function renderTimeline(view) {
  const host = $('timeline');
  host.textContent = '';
  const tl = buildTimeline(view, { policy: app.contextPolicy });

  if (tl.droppedSpeeches > 0) {
    host.appendChild(el('div', 'tl-note', `（更早的 ${tl.droppedSpeeches} 条发言已省略）`));
  }

  for (const e of tl.entries) {
    let cls = 'tl-row';
    let text = '';
    if (e.kind === 'round') {
      cls += ' tl-round';
      text = `— 第 ${e.round} 轮 —`;
    } else if (e.kind === 'speech') {
      cls += e.who === '你' ? ' tl-me' : '';
      text = `${e.who}：${e.text}`;
    } else if (e.kind === 'play') {
      text = `${e.who} 出牌 ${e.cards.join(' ')}`;
    } else if (e.kind === 'reveal') {
      text = `${e.who} ${e.text}`;
    } else if (e.kind === 'breach') {
      cls += ' tl-breach';
      text = `【破例】${e.who} ${e.text}`;
    } else if (e.kind === 'transfer') {
      cls += ' tl-breach';
      text = e.text;
    } else if (e.kind === 'reject') {
      cls += ' tl-reject';
      text = `${e.who} 的动作被拒绝（${e.text}）`;
    } else if (e.kind === 'score') {
      cls += ' tl-score';
      text = `${e.who} 得 ${e.delta} 分`;
    } else if (e.kind === 'fold') {
      text = `${e.who} 认输退出`;
    } else if (e.kind === 'pass') {
      text = `${e.who} 过牌`;
    } else if (e.kind === 'discard') {
      cls += ' tl-breach';
      text = `${e.who} 甩掉了 ${e.cards.join(' ')}`;
    } else if (e.kind === 'showdown') {
      text = `${e.who} 亮牌 ${e.cards.join(' ')}`;
    } else if (e.kind === 'announce') {
      cls += e.tone === 'big' ? ' tl-big' : ' tl-announce';
      text = e.who && e.who !== '系统' ? `${e.who}：${e.text}` : `〔公告〕${e.text}`;
    } else if (e.kind === 'private') {
      cls += ' tl-private';
      text = `〔只有你知道〕${e.text}`;
    }
    host.appendChild(el('div', cls, text));
  }
  host.scrollTop = host.scrollHeight;
}

function renderAgentPanel() {
  const host = $('agents');
  host.textContent = '';
  for (const a of app.agents) {
    const box = el('div', 'agent-card');
    const head = el('div', 'agent-head');
    // 立绘缩略图：不占额外高度，却一眼能对上桌面上那个人是谁
    if (a.avatar) {
      const im = document.createElement('img');
      im.className = 'agent-face';
      im.src = avatarUrl(a.avatar);
      im.alt = a.name;
      head.appendChild(im);
    } else {
      const dot = el('span', 'agent-dot');
      dot.style.background = a.color;
      head.appendChild(dot);
    }
    head.appendChild(el('span', 'agent-name', a.name));
    head.appendChild(
      el('span', 'agent-stat', `调用 ${a.stats.calls} · 纠错 ${a.stats.retries} · 本地 ${a.stats.local || 0}`)
    );
    box.appendChild(head);

    const persona = a.isHuman
      ? '（你自己）'
      : a.persona.slice(0, PERSONA_SHOWN) + (a.persona.length > PERSONA_SHOWN ? '…' : '');
    box.appendChild(el('div', 'agent-persona', persona));

    const pending = a.notes.filter((n) => !n.delivered);
    const delivered = a.notes.length - pending.length;
    if (a.notes.length) {
      box.appendChild(el('div', 'agent-note', `便签 ${a.notes.length} 张（已注入 ${delivered}，待注入 ${pending.length}）`));
    }
    if (a.stats.lastError) {
      box.appendChild(el('div', 'agent-err', a.stats.lastError.slice(0, 120)));
    }
    host.appendChild(box);
  }
}

// ---------------------------------------------------------------------------
// 开局
// ---------------------------------------------------------------------------

/**
 * 「谁和你玩」的名单：名册里按**选中顺序**取 need 位。
 *
 * 名册比这一局需要的人少时用兜底身份补齐（那一席会画成金色剪影）——
 * 与其因为人不够就开不了局，不如把空位如实摆出来。
 * 「导入一份只有两位的名册、再点四人局」正是这条路。
 */
function rosterAgents(need) {
  const picked = app.lobby ? app.lobby.selection().agents : [];
  const out = [];
  for (let i = 0; i < need; i++) out.push(picked[i] || fallbackAgent(i + 1));
  return out;
}

/** 把这一局实际用的人数与玩法写回抽屉里的两个下拉框，免得两处显示不一致 */
function syncSetupControls(n) {
  const ps = $('setup-players');
  if (ps && [...ps.options].some((o) => o.value === String(n))) ps.value = String(n);
  const rs = $('rule-select');
  if (rs && rs.value !== app.ruleSet.id) rs.value = app.ruleSet.id;
}

/**
 * 开局。
 *
 * @param {{players?:number, agents?:Array}} sel
 *   players 含你自己；agents 是这一局上场的智能体（长度应为 players-1）。
 *   不传就按抽屉里的「玩家人数」＋名册当前选中的人来定 ——
 *   于是「新开一局」和「大厅里开始游戏」走的是同一条路。
 */
function startGame(sel = {}) {
  const rs = app.ruleSet;

  // 先让上一局的循环失活。它可能正卡在等人点击或等 LLM 回复上，
  // 所以既要换令牌，也要把那个悬着的等待解开 —— 否则旧循环会一直挂着，
  // 一旦被解开还会往新状态上写东西。
  const pending = app.humanResolver;
  app.humanResolver = null;
  if (pending) pending(null);
  gameToken++;

  // 牌桌在启动层里是隐藏的，量出来的尺寸是 0；进牌桌之后必须重量一次，
  // 否则整局都按 320×280 在画（画布被拉伸，人物和牌全部错位）
  renderer?.resize();

  // 人数：优先用调用方给的，其次读下拉框。两个来源都要被规则包夹一次
  const wanted = Number(sel.players ?? $('setup-players').value) || rs.minPlayers || 2;
  const n = clampPlayers(wanted);

  // 种子：输入框里只要有内容就以它为准 —— 所以界面上显示的那个种子数字，
  // 粘回输入框就能原样复现一局。输入框为空时才由「种子来源」决定。
  const seedInfo = resolveSeed({
    raw: $('setup-seed').value,
    source: seedSourceValue(),
    recent: app.recentSeeds,
  });
  app.seedInfo = seedInfo;
  app.seed = seedInfo.seed;
  app.recentSeeds = [...app.recentSeeds, seedInfo.seed].slice(-8);
  if (seedInfo.origin === 'manual-empty') {
    toast('种子来源选了「手动填入」但没写内容，本局改用加密随机种子');
  }

  // 上场名单。缺人就用兜底身份补位 —— 后面 players 与 agents 的下标必须一一对上，
  // 所以这里先把长度补齐，不给「一半对得上一半对不上」留缝
  const mates = (Array.isArray(sel.agents) && sel.agents.length
    ? sel.agents.slice(0, n - 1)
    : rosterAgents(n - 1));
  while (mates.length < n - 1) mates.push(fallbackAgent(mates.length + 1));

  const players = [];
  for (let i = 0; i < n; i++) {
    // 座位名存「玩家」，投影时再按观察者渲染成「你」——
    // 这样 AI 的提示词里不会出现第三人称错位。
    // 智能体的名字直接就是名册里的名字（老千 / 女仆 / 黑桃王子）：
    // 提示词、牌桌记录、名牌三处读的都是同一个字段，改名不会有漏网之鱼。
    players.push({
      id: `p${i}`,
      name: i === 0 ? '玩家' : String(mates[i - 1].name || `AI-${i}`),
      isHuman: i === 0,
    });
  }

  /**
   * 规则包的额外座位（21 点的荷官）。
   *
   * 它不是玩家：不出现在人数下拉框里、不建智能体、永远轮不到它行动。
   * 但它必须有座位 —— 座位是牌进入投影的唯一入口，没有座位，庄家的牌
   * 就画不出来、也描述不出来。于是「庄家」这条信息通路不需要在
   * 投影层/渲染层/提示词层各开一个口子：它走的就是玩家的那条路。
   */
  const extraSeats = typeof rs.extraSeats === 'function' ? rs.extraSeats() : [];

  app.humanId = 'p0';
  // 智能体只给玩家建：给荷官建一个，它会永远等不到回合，
  // 而一旦有人手滑让 nextTurn 返回了它，主循环就会卡在那里。
  app.agents = players.map((p, i) => {
    const m = i === 0 ? null : mates[i - 1];
    return createAgent({
      id: p.id,
      name: p.name,
      isHuman: p.isHuman,
      persona: p.isHuman
        ? ''
        : (m.persona || DEFAULT_PERSONAS[(i - 1) % DEFAULT_PERSONAS.length]),
      color: PALETTE[i % PALETTE.length],
      // 兜底身份没有形象（null）→ 座位画成金色剪影，跟真人区分开
      avatar: p.isHuman ? null : (m.avatar || null),
      /**
       * 记住这个座位对应名册里的哪一条。
       *
       * 牌桌上「点人物看 / 改设定」就是顺着这根线走的：点的是座位（p2），
       * 要改的是名册里的那一条（ag-nvpv）。只靠名字反查是不行的 ——
       * 用户可以把名字改成任何东西，一开始就可能重名。
       * 兜底补位的身份不在名册里，这里是 undefined，点开时会说明白。
       */
      rosterId: p.isHuman ? null : (m.id || null),
    });
  });

  app.state = createState({
    ruleSetId: app.ruleSet.id,
    players: [...players, ...extraSeats],
    seed: seedInfo.seed,
  });
  app.ui.hint = '';
  app.ui.selectedIds = [];
  app.ui.hoverSeat = null; // 上一局的悬停是上一局的人，别带进新局
  app.ui.visMenu = null;   // 上一局开着的轮盘指着一张上一局的牌

  /**
   * 没配接口 = 这一桌 AI 全是本地策略的「木桩」，他们**不会开口**。
   *
   * 这件事必须在牌桌上一眼可见。实测「AI 都不说话」查下来就是这个原因 ——
   * 本地兜底按设计把 speech 留空（它没有人设可演），但界面上没有任何地方
   * 说过这件事，用户只能靠猜，而猜的方向通常是提示词。
   *
   * 项目里早有这条原则：兜底可以兜，但不许静默。所以这里发一条公开公告，
   * 它跟着对局进历史记录，翻回去也还在，不像 toast 一闪就没。
   */
  if (!hasLLMConfig(app.config)) {
    const bots = app.agents.filter((a) => !a.isHuman).length;
    app.state = applyEvent(app.state, ev.announce(
      null,
      `未配置接口 —— 这 ${bots} 位由本地策略代打，不会说话。`
      + '想听他们开口：右侧「设置 → 接口设置」里填好地址、模型和 Key，再开一局。',
      'big'
    ));
  }

  applyRuleSetUi();
  syncSetupControls(n);
  renderSeedNote();
  runGame();
}

/** 「新开一局」：沿用当前玩法，人数与名单回抽屉/名册里取 */
function newGame() {
  const n = clampPlayers(Number($('setup-players').value) || app.ruleSet.minPlayers || 2);
  startGame({ players: n, agents: rosterAgents(n - 1) });
}

/** 人数收口：任何来源的人数都要落在规则包允许的区间里 */
function clampPlayers(n) {
  const rs = app.ruleSet;
  const min = rs.minPlayers || 2;
  const max = rs.maxPlayers || 4;
  const v = Number(n);
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, Math.round(v)));
}

/**
 * 人数下拉框的选项完全由规则包生成 ——
 * 填不出非法人数，也就不需要事后再纠正它。
 *
 * 重建时优先保留当前选择（只要它在新玩法的合法区间里），
 * 否则回落到 3 人（你 + 两个 AI）。
 */
function buildPlayerSelect() {
  const sel = $('setup-players');
  if (!sel) return;
  const rs = app.ruleSet;
  const min = rs.minPlayers || 2;
  const max = rs.maxPlayers || 4;
  const cur = Number(sel.value);
  const keep =
    Number.isFinite(cur) && cur >= min && cur <= max
      ? Math.round(cur)
      : Math.min(max, Math.max(min, DEFAULT_PLAYER_COUNT));

  sel.textContent = '';
  for (let k = min; k <= max; k++) {
    const opt = el('option', null, `${k} 人（你 + ${k - 1} 个 AI）`);
    opt.value = String(k);
    sel.appendChild(opt);
  }
  sel.value = String(keep);
  app.playerCount = keep;

  const note = $('setup-note');
  if (note) {
    note.textContent =
      min === max
        ? `${rs.name}固定 ${min} 人。改动后需点「新开一局」生效。`
        : `${rs.name}支持 ${min}-${max} 人。人数超出这个范围时牌根本发不出来，所以这里只给合法选项。改动后需点「新开一局」生效。`;
  }
}

/** 时间种子的可读写法 */
function fmtStamp(ms) {
  const d = new Date(ms);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/** 当前选中的种子来源，缺失时回落到加密随机 */
function seedSourceValue() {
  const sel = $('seed-source');
  const v = sel && sel.value ? String(sel.value) : '';
  return SEED_SOURCES.some((s) => s.id === v) ? v : 'crypto';
}

/**
 * 种子来源下拉框。选项是固定的三种，不依赖规则包。
 */
function buildSeedSourceSelect() {
  const sel = $('seed-source');
  if (!sel) return;
  sel.textContent = '';
  for (const src of SEED_SOURCES) {
    const opt = el('option', null, src.label);
    opt.value = src.id;
    sel.appendChild(opt);
  }
  sel.value = seedSourceValue();
  applySeedSourceUi();
}

/** 来源一变，输入框的可用状态与提示语都要跟着变 */
function applySeedSourceUi() {
  const src = seedSourceValue();
  const input = $('setup-seed');
  if (input) {
    // 「手动填入」之外的两种来源都由程序产生种子，输入框没必要可编辑 ——
    // 但仍要能粘贴：想复现时先切到「手动填入」再粘，避免手滑改坏自动种子。
    input.disabled = src !== 'manual';
    input.placeholder =
      src === 'manual'
        ? '填数字按原值使用；填文字会散列成种子'
        : src === 'time'
          ? '将由本机时间生成（切到「手动填入」可改为自己指定）'
          : '将由加密随机生成（切到「手动填入」可改为自己指定）';
  }
  const sel = $('seed-source');
  const hint = SEED_SOURCES.find((s) => s.id === src)?.hint || '';
  if (sel) sel.title = hint;
  renderSeedNote();
}

/** 把本局真正用到的种子写出来，方便复现 */
function renderSeedNote() {
  const box = $('seed-note');
  if (!box) return;
  const info = app.seedInfo;
  if (!info || info.seed == null) {
    box.textContent = '';
    return;
  }

  const copyTip = `把 ${info.seed} 记下来，来源切到「手动填入」再粘回去，就能原样复现这一局。`;

  if (info.origin === 'time') {
    box.textContent =
      `本局于 ${fmtStamp(info.at)} 开局，时间种子 ${info.seed}。` +
      `同一毫秒内连开两局会自动错开，不会撞牌。` +
      `注意代价：时间种子是可枚举的，知道大致开局时刻的人能在一小段窗口里试出整副牌 —— ` +
      `本局种子只显示给你自己，别在牌桌上念给智能体听。`;
    return;
  }
  if (info.origin === 'crypto') {
    box.textContent = `本局种子 ${info.seed}（加密随机，43 亿分之一的空间，无法被猜出）。${copyTip}`;
    return;
  }
  if (info.origin === 'manual-text') {
    box.textContent = `本局种子 ${info.seed}，由「${info.echo}」散列而来：同一句文字永远对应同一局牌。`;
    return;
  }
  if (info.origin === 'manual-empty') {
    box.textContent = `种子来源选了「手动填入」却没写内容，本局退回加密随机：${info.seed}。`;
    return;
  }
  box.textContent = `本局种子 ${info.seed}（手动填入）。`;
}

/** 把规则包的能力反映到界面上（认输按钮、出牌按钮等） */
function applyRuleSetUi() {
  const rs = app.ruleSet;
  $('rule-name').textContent = rs.name;
  $('rule-desc').textContent = rs.description || '';
  const foldBtn = $('btn-fold');
  if (foldBtn) {
    foldBtn.style.display = rs.allowFold === false ? 'none' : '';
    // 同一个动作在两个玩法里的分量不同：斗地主是「整局认输」，
    // 德州扑克是「弃掉这一手，牌局继续」。按钮文案必须跟着玩法走，
    // 否则玩家会以为点一下就整局结束了。
    foldBtn.textContent = rs.foldLabel || '认输';
  }
  const playBtn = $('btn-play');
  // 「出牌」按钮只在「选中 → 出牌」两段式的玩法里有意义。
  // 判据用 cardGesture 而不是 multiSelect：21 点既不多选、也没有出牌这个动作，
  // 按钮留着只会让人点了报错。
  if (playBtn) playBtn.style.display = cardGesture() === 'select' ? '' : 'none';
  const select = $('rule-select');
  if (select && select.value !== rs.id) select.value = rs.id;
}

// ---------------------------------------------------------------------------
// 主循环
// ---------------------------------------------------------------------------

async function runGame() {
  // 不再用 app.running 拦并发：新开一局时旧循环还挂在 await 上，
  // 拦截会让新局根本起不来。改用令牌 —— 旧的自己会退场。
  const token = gameToken;
  app.running = true;
  setControlsEnabled(false);

  try {
    app.state = applyEvents(app.state, app.ruleSet.start(app.state));
    renderAll({ hint: '对局开始' });

    let finished = false;

    for (let guard = 0; guard < 500; guard++) {
      if (token !== gameToken) return; // 用户已经开了新局，本循环退场
      const pid = app.ruleSet.nextTurn(app.state);

      // 本轮所有人行动完毕：先结算，再决定是开新轮还是收局。
      // 顺序不能颠倒 —— 若先开新轮，轮次标记会被清空，
      // nextTurn 就再也不会返回 RETURN，本轮的分数永远结算不了。
      if (pid === RETURN) {
        app.state = applyEvents(app.state, app.ruleSet.resolveRound(app.state));
        renderAll();
        if (app.ruleSet.isTerminal(app.state)) {
          finished = true;
          break;
        }
        app.state = applyEvent(app.state, ev.roundStart(app.state.round + 1));
        renderAll();
        continue;
      }

      app.state = applyEvent(app.state, ev.turn(pid));
      const agent = agentOf(pid);
      renderAll();
      await runTurn(agent, token);
      if (token !== gameToken) return;
    }

    if (!finished) {
      throw new Error('对局未能在合理步数内结束，可能存在规则死锁');
    }

    const outcome = app.ruleSet.outcome(app.state);
    app.state = applyEvent(app.state, ev.gameEnd(outcome));
    const winners = outcome.winners.map((w) => agentOf(w)?.name || w).join('、');
    app.ui.hint = `对局结束，${winners} 获胜`;
    renderAll();
    toast(`对局结束：${winners} 获胜`);
  } catch (err) {
    console.error(err);
    toast(`出错了：${err.message || err}`);
    app.ui.hint = `出错了：${err.message || err}`;
    renderAll();
  } finally {
    // 只有仍然是「当前这一局」的循环才有权恢复控件。
    // 恢复成什么由「轮到谁」决定：局终时 humanResolver 为空，按钮就该是灰的。
    if (token === gameToken) {
      app.running = false;
      setControlsEnabled(humanCanAct());
    }
  }
}

function setControlsEnabled(on) {
  // 「新开一局」永远可点：对局中途想换人数/换玩法，靠的就是它
  if ($('btn-say')) $('btn-say').disabled = !on;
  if ($('btn-fold')) $('btn-fold').disabled = !on;
  if ($('btn-play')) $('btn-play').disabled = !on;
  if ($('btn-endturn')) $('btn-endturn').disabled = !on;
}

// ---------------------------------------------------------------------------
// 一个回合（人与 AI 共用）
// ---------------------------------------------------------------------------

/**
 * 跑完一个完整回合。回合内可以行动多次，直到：
 *   - 规则包要求结束回合（例如本轮已出过牌）
 *   - 行动次数用尽
 *   - 该智能体主动声明 endTurn
 */
async function runTurn(agent, token = gameToken) {
  const pid = agent.id;
  const budgetTotal = maxActionsPerTurn(pid);
  const done = [];
  let used = 0;
  let boardActed = false;
  // 等待期间用户可能开了新局，那时的 app.state 已经是另一局了。
  // 每次 await 回来都要确认自己还属于当前这一局，不然会写脏新状态。
  const stale = () => token !== gameToken;

  for (let step = 0; step < budgetTotal; step++) {
    if (stale() || mustEndTurn(pid)) break;

    const turnCtx = { step, maxActions: budgetTotal, remaining: Math.max(0, budgetTotal - used), done: [...done] };
    let decision;

    if (agent.isHuman) {
      decision = await humanStep(turnCtx);
      if (stale()) return;
      if (!decision) break; // 人类点了「结束回合」
    } else {
      renderAll({ thinkingId: pid, hint: `${agent.name} 正在思考…` });
      decision = await aiDecide(agent, turnCtx);
      if (stale()) return;
      renderAll({ thinkingId: null });
      if (decision?.agent) updateAgent(decision.agent);
    }

    if (!decision) break;

    // 说话：不占行动次数，但记进本回合摘要
    if (decision.speech) {
      app.state = applyEvent(app.state, ev.speak(pid, decision.speech));
      done.push(`开口说「${decision.speech}」`);
    }

    // 依序执行动作
    for (const raw of decision.actions || []) {
      if (isEndTurnAction(raw)) continue;
      const res = applyActionChecked(pid, raw);
      if (!res.ok) {
        app.state = applyEvent(app.state, ev.reject(pid, raw, res.reason));
        done.push(`想做「${describeAction(raw)}」但被拒绝（${res.reason}）`);
        continue;
      }
      used++;
      boardActed = true;
      done.push(
        res.breach
          ? `${describeAction(raw)}（破例，扣 ${res.penalty} 分）`
          : describeAction(raw)
      );

      /**
       * AI 打出的牌，先「被看见一次」再落进出牌区。
       *
       * 没有这一段，牌是从手里凭空跳到桌面上的 —— 而一局里最该看清的就是
       * 别人打了什么，偏偏只有它没有过程。玩家自己出牌不做演出：他自己的牌
       * 他清楚，而且屏幕上没有他那一席立绘，「身前」那个位置对他就没有意义。
       *
       * 这里**不等它演完**：牌出手是已经发生的事实，演出只是补一段过程给你看。
       * 让牌局停下来等动画，一局十几次出牌就白等十几秒；而下一个人的回合照常
       * 推进，画面里同时只有最新的一手在演。顺序仍然是「先立演出，再 render」——
       * 反过来的话第一帧画的就是牌已经躺在出牌区，然后才被扯回去重飞一遍。
       */
      if (!agent.isHuman && raw.type === 'play' && raw.cards?.length && renderer) {
        renderer.beginPlayStage(raw.cards, pid);
      }
    }

    // 便签与自我设定（便签必须在成功拿到回复后才标记已注入）
    let next = agentOf(pid);
    if (decision.noteIds?.length && !decision.degraded) {
      next = markNotesDelivered(next, decision.noteIds);
    }
    if (decision.note) next = addNote(next, decision.note);
    if (decision.profilePatch) next = applyProfilePatch(next, decision.profilePatch, '自我修改');
    updateAgent(next);

    renderAll();

    if (decision.endTurn) break;
    if (used >= budgetTotal) break;

    // 一个回合内多次决策之间也要确认 —— 上一段可能刚 await 过
    if (stale()) return;
  }

  if (stale()) return;

  // 整个回合没有落到牌桌上的任何动作：补一次「过牌」，
  // 否则本轮的完成判定永远推不动，回合会卡死。
  // 规则包可以接管这个判断（斗地主里「只亮牌没出牌」也属于没落地）。
  if (needsPassFallback(pid, boardActed)) {
    app.state = applyEvent(app.state, ev.pass(pid));
  }

  renderAll({ thinkingId: null, hint: '' });
}

/** 本回合是否需要补一条过牌记录 */
function needsPassFallback(playerId, boardActed) {
  const fn = app.ruleSet.needsPassFallback;
  if (typeof fn === 'function') return !!fn.call(app.ruleSet, app.state, playerId);
  return !boardActed;
}

/** 校验并执行一个动作 */
function applyActionChecked(playerId, action) {
  const check = app.ruleSet.validate(app.state, playerId, action, actionOpts());
  if (!check.ok) return { ok: false, reason: check.reason };
  app.state = applyEvents(app.state, app.ruleSet.apply(app.state, playerId, action, check));
  return { ok: true, breach: !!check.breach, penalty: check.penalty || 0 };
}

/**
 * 预演校验：在克隆出来的状态上按顺序跑一遍，
 * 确认整批动作都能落地。这样一批里只要有一个不合规，
 * 就能在写入真实状态【之前】把整批打回，不会留下半截结果。
 */
function previewActions(playerId, actions) {
  let sim = app.state;
  const opts = actionOpts();
  for (const a of actions) {
    const check = app.ruleSet.validate(sim, playerId, a, opts);
    if (!check.ok) return { ok: false, action: a, reason: check.reason };
    sim = applyEvents(sim, app.ruleSet.apply(sim, playerId, a, check));
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 人类回合
// ---------------------------------------------------------------------------

/**
 * 轮到人类时的提示语。规则包可以自己写（turnHint）——
 * 21 点没有「点牌出牌」这回事，照斗地主那句话提示，玩家会一直点牌
 * 然后被自己的规则拒绝，却不知道该点哪里。
 */
function turnHint() {
  const fn = app.ruleSet.turnHint;
  if (typeof fn === 'function') {
    try {
      const t = fn.call(app.ruleSet, app.state, app.humanId);
      if (t) return t;
    } catch {
      /* 提示语写坏了不该把整局拖垮，退到通用文案 */
    }
  }
  return multiSelect()
    ? '左键点牌选中/取消（可多选），点「出牌」打出选中的牌；右键翻牌；也可以点「结束回合」'
    : '轮到你了：左键点牌出牌（出牌即结束本回合），右键翻牌，也可以点「结束回合」';
}

function humanStep() {
  return new Promise((resolve) => {
    app.humanResolver = (payload) => {
      app.humanResolver = null;
      resolve(payload);
    };
    app.ui.selectedIds = [];
    app.ui.hint = turnHint();
    renderAll();
  });
}

/** 把选中的牌解析成牌型，写进提示条，让玩家出手前就知道成不成立 */
function selectionHint() {
  const ids = app.ui.selectedIds || [];
  const fn = app.ruleSet.selectionHint;
  if (typeof fn === 'function') {
    const t = fn.call(app.ruleSet, app.state, ids);
    if (t) return t;
  }
  if (!ids.length) return multiSelect() ? '还没有选牌' : '';
  const picked = ids.map((cid) => app.state.cards[cid]).filter(Boolean);
  const parsed = parseCombo(picked);
  const label = ids.map((cid) => `${app.state.cards[cid].glyph}${app.state.cards[cid].label}`).join(' ');
  return parsed.ok
    ? `已选：${parsed.combo.label} —— ${label}`
    : `已选：${label}（${parsed.reason}）`;
}

function toggleSelection(cardId) {
  const ids = app.ui.selectedIds || [];
  app.ui.selectedIds = ids.includes(cardId)
    ? ids.filter((x) => x !== cardId)
    : [...ids, cardId];
  // 选中的牌按点数排一遍，读起来才像手牌
  app.ui.selectedIds.sort(
    (a, b) => (app.state.cards[a]?.rank ?? 0) - (app.state.cards[b]?.rank ?? 0)
  );
  renderAll({ hint: selectionHint() });
}

function submitHumanPlay() {
  const ids = app.ui.selectedIds || [];
  if (!ids.length) {
    toast('先点选要出的牌');
    return;
  }
  const picked = ids.map((cid) => app.state.cards[cid]).filter(Boolean);
  const parsed = parseCombo(picked);
  const label = parsed.ok ? parsed.combo.label : '出牌';
  submitHuman(act.play(ids, label));
}

// ---------------------------------------------------------------------------
// AI 回合（LLM 回路 + 本地兜底）
// ---------------------------------------------------------------------------

function gatherCandidates(agent) {
  const candidates = app.ruleSet.legalActions(app.state, agent.id);
  const breaches =
    typeof app.ruleSet.breachActions === 'function'
      ? app.ruleSet.breachActions(app.state, agent.id, actionOpts())
      : [];
  return { candidates, breaches };
}

/**
 * 算胜率。候选动作与破例动作一起送进去 —— 破例也带胜率和期望分，
 * 「要不要耍赖」才是一个能算账的决定，而不是拍脑袋。
 *
 * @returns {{candidates:Array, breaches:Array, meta:object|null}}
 *   两个数组与传入的候选/破例【下标一一对应】，提示词与本地兜底都按它取。
 */
async function evaluateRates(agent, candidates, breaches) {
  const blank = (list) => list.map((action) => ({ action, winRate: null, samples: 0 }));
  try {
    const view = project(app.state, agent.id);
    const result = await app.winrateEngine.evaluate({
      view,
      selfId: agent.id,
      candidates,
      breaches,
      ruleSet: app.ruleSet,
      ruleState: app.state.ruleState,
      onProgress: (p) => renderAll({ hint: `正在算胜率…（已模拟 ${p.samples} 局）` }),
    });
    // 兼容返回「只有候选」的旧式引擎（ONNX 通路）
    if (Array.isArray(result)) {
      return { candidates: result, breaches: blank(breaches), meta: null };
    }
    return result;
  } catch (err) {
    console.warn('胜率引擎调用失败：', err);
    return { candidates: blank(candidates), breaches: blank(breaches), meta: null };
  }
}

/** 记录「最后选了什么」，让胜率面板能把它标出来 */
function markChosen(text) {
  if (app.lastRates) app.lastRates.chosen = text || '（什么都不做）';
}

/** 本地兜底：胜率最大的合规动作 */
function localDecision(agent, candidates, winrates, reason, extraStats = {}) {
  const pick = chooseLocalDecision({
    state: app.state,
    playerId: agent.id,
    ruleSet: app.ruleSet,
    candidates,
    winrates,
    opts: actionOpts(),
  });
  markChosen(describeAction(pick.action));
  const next = bumpStats(agent, {
    local: (agent.stats.local || 0) + 1,
    lastError: reason || agent.stats.lastError,
    ...extraStats,
  });
  return {
    speech: '',
    actions: [pick.action],
    endTurn: true, // 本地策略每回合只走一步，走完就交回合
    noteIds: [],
    degraded: true,
    source: pick.source,
    reason: pick.reason,
    agent: next,
  };
}

async function aiDecide(agent, turnCtx) {
  const { candidates, breaches } = gatherCandidates(agent);
  const rates = await evaluateRates(agent, candidates, breaches);
  app.lastRates = { agent: agent.name, ...rates.meta, rows: rates.candidates, breaches: rates.breaches };

  // 没有可用的接口配置：直接由本地接管，不去发那个注定失败的请求
  if (!hasLLMConfig(app.config)) {
    return localDecision(agent, candidates, rates.candidates, '未配置接口，本回合由本地策略代打');
  }

  const view = project(app.state, agent.id);
  const prompt = buildPrompt({
    agent,
    view,
    ruleSet: app.ruleSet,
    state: app.state,
    candidates,
    breaches,
    allowBreach: allowBreach(),
    turn: turnCtx,
    winrates: rates.candidates,
    breachRates: rates.breaches,
    winrateMeta: rates.meta,
    contextPolicy: app.contextPolicy,
    extraRules: describeSpecialRules(app.specialRules),
  });

  let lastText = '';
  let lastErrors = [];
  let rejectedAction = null;
  let rejectReason = '';
  let lastTruncated = false;
  let current = agent;

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const userText =
      attempt === 0
        ? prompt.text
        : `${prompt.text}\n\n=====\n${buildCorrectionPrompt({
            previousText: lastText,
            errors: lastErrors,
            rejectedAction,
            rejectReason,
            truncated: lastTruncated,
          })}`;

    let res;
    try {
      res = await callLLM({ config: app.config, system: prompt.system, user: userText });
    } catch (err) {
      const message = String(err.message || err);
      current = bumpStats(current, { errors: current.stats.errors + 1, lastError: message });
      updateAgent(current);
      // 调用失败不再沉默过牌：本地兜底顶上，牌局继续
      return localDecision(
        current,
        candidates,
        rates.candidates,
        `调用失败，本回合由本地策略代打：${message.slice(0, 60)}`
      );
    }

    const parsed = parseResponse(res.text);

    if (!parsed.ok) {
      lastText = res.text;
      lastErrors = parsed.errors;
      lastTruncated = wasTruncated(res);
      if (lastTruncated) lastErrors = [...lastErrors, '（这次的输出是被长度上限截断的）'];
      rejectedAction = null;
      rejectReason = '';
      current = bumpStats(current, { retries: current.stats.retries + 1 });
      updateAgent(current);
      continue;
    }

    const preview = previewActions(agent.id, parsed.value.actions);
    if (!preview.ok) {
      lastText = res.text;
      lastErrors = [];
      lastTruncated = wasTruncated(res);
      rejectedAction = preview.action;
      rejectReason = preview.reason;
      current = bumpStats(current, { retries: current.stats.retries + 1 });
      updateAgent(current);
      continue;
    }

    current = bumpStats(current, {
      calls: current.stats.calls + 1,
      lastError: null,
    });
    updateAgent(current);
    markChosen((parsed.value.actions || []).map(describeAction).join('；'));
    return { ...parsed.value, noteIds: prompt.noteIds, source: 'llm', agent: current };
  }

  current = bumpStats(current, {
    calls: current.stats.calls + 1,
    lastError: `连续 ${MAX_ATTEMPTS} 次未能给出合法动作${lastTruncated ? '（其中含被长度上限截断的回复）' : ''}`,
  });
  updateAgent(current);
  return localDecision(
    current,
    candidates,
    rates.candidates,
    lastTruncated
      ? `连续 ${MAX_ATTEMPTS} 次未给出合法动作（回复被长度上限截断，可调大 maxTokens），改由本地策略代打`
      : `连续 ${MAX_ATTEMPTS} 次未给出合法动作，改由本地策略代打`
  );
}

// ---------------------------------------------------------------------------
// 画布交互
// ---------------------------------------------------------------------------

function canvasPos(e) {
  const el0 = document.getElementById('table-canvas');
  const rect = renderer && el0 ? el0.getBoundingClientRect() : null;
  if (!rect) return { x: 0, y: 0 };
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function humanCanAct() {
  return !!app.humanResolver;
}

/**
 * 点牌桌上的人 → 打开他的设定。
 *
 * 桌上每个人都是名册里的一条，所以这里不另造一套「查看界面」：
 * 直接把名册那个编辑框拉出来（scope: 'table'），改完立刻反映到牌桌和提示词里。
 * 三种点不出东西的情况都要**说出来** —— 点了没反应才是最难查的那种坏：
 *   · 荷官这种规则座位：它本来就不是"人"，没有可改的设定
 *   · 自己那一席：玩家的设置在右边抽屉里
 *   · 兜底补位的临时对手：名册里没有他
 */
function openSeatCard(seat) {
  if (seat.hasAgent === false) {
    toast('这一席是规则座位（比如荷官），没有可改的设定。');
    return;
  }
  const ag = (app.agents || []).find((a) => a.id === seat.id);
  if (!ag) return;
  if (ag.isHuman) {
    toast('这是你自己那一席 —— 你的设置在右边那个「设置」抽屉里。');
    return;
  }
  if (!ag.rosterId) {
    toast(`${ag.name} 是临时补位的对手（名册里没有他），改不了设定。`);
    return;
  }
  app.lobby?.openEditor(ag.rosterId, { scope: 'table' });
}

/**
 * 名册在别处被改了（在牌桌上点开某个人、改完保存），把这一局里的他同步过来。
 *
 * 开局时 agent 是把名册"快照"下来的 —— 所以光改名册，正在打的这一局是没反应的，
 * 而用户明明是在牌桌上点着这个人改的，回来却看见名字还是旧的，那就说不通了。
 * 名字和形象是"这个人是谁"，属于展示层，直接改 state 里的 player 名即可；
 * 人设进提示词，改 agent 身上那一份。
 */
function syncAgentsFromRoster() {
  if (!app.state || !app.agents) return;
  const roster = getRoster();
  let dirty = false;
  for (const ag of app.agents) {
    if (!ag.rosterId) continue;
    const r = roster.find((x) => x.id === ag.rosterId);
    if (!r) continue;
    if (ag.name !== r.name) {
      ag.name = r.name;
      const p = (app.state.players || []).find((x) => x.id === ag.id);
      if (p) p.name = r.name;
      dirty = true;
    }
    if (ag.persona !== r.persona) { ag.persona = r.persona; dirty = true; }
    if (ag.avatar !== r.avatar) { ag.avatar = r.avatar; dirty = true; }
  }
  if (dirty) renderAll();
}

function onCanvasClick(e) {
  const { x, y } = canvasPos(e);

  /**
   * 轮盘开着的时候，这一下点击只可能是「点某一档」「点圆心关掉」或「点旁边」——
   * 绝不能顺手把底下的牌当成出一张。牌一旦出手就收不回来了，而轮盘正好盖在
   * 那几张牌上面：手滑一次，代价是少一张牌，且没有任何撤销的路。
   * 所以这里一律不往下走。
   */
  if (app.ui.visMenu) {
    const m = renderer.menuHitTest(x, y);
    if (m && m.kind === 'close') closeVisMenu();
    else if (m && m.kind === 'option') applyVisMenu(m.vis);
    else closeVisMenu();
    return;
  }

  const hit = renderer.hitTest(x, y);
  if (!hit) {
    // 没点到牌，再看看是不是点在某个人的立绘上。牌在前、人在后 ——
    // 重叠时点下去该是出牌，不是弹出一份资料
    const seat = renderer.seatHitTest(x, y);
    if (seat) openSeatCard(seat);
    return;
  }

  if (!humanCanAct()) {
    if (hit.zone === 'hand') toast('还没轮到你');
    return;
  }
  if (hit.ownerId !== app.humanId || hit.zone !== 'hand') {
    toast('只能出自己手上的牌');
    return;
  }

  // 点牌的意思由规则包决定（见 cardGesture）。
  // 需要多张牌才能组成牌型的玩法（斗地主）走「选中 → 出牌」两段式；
  // 动作本身不指定牌的玩法（21 点）干脆不用点牌，动作在下方按钮上。
  const gesture = cardGesture();
  if (gesture === 'none') {
    toast('这个玩法不用点牌：请用下方的动作按钮');
    return;
  }
  if (gesture === 'select') {
    toggleSelection(hit.card.id);
    return;
  }
  submitHuman(act.play([hit.card.id], hit.card.label || ''));
}

/** 结束回合时清掉选择，免得上一次选中的牌留在下一回合 */
function submitHumanEndTurn() {
  app.ui.selectedIds = [];
  if (!app.humanResolver) return;
  app.humanResolver(null);
}

/** 出牌被规则拒绝时，把选择保留着让玩家改，而不是清空重来 */
function submitHuman(action) {
  if (!app.humanResolver) return;
  const check = app.ruleSet.validate(app.state, app.humanId, action, actionOpts());
  if (!check.ok) {
    toast(check.reason);
    return;
  }
  app.humanResolver({ speech: '', actions: [action], endTurn: false });
}

/**
 * 右键自己手上的牌 → 打开「视角轮盘」。
 *
 * 以前这里是**循环切换**：右键一下往下翻一档。四档转一圈才回到原处，
 * 想把「都亮着」改成「都盖着」得点三次，而这三次里没有一次是"我要那一档"。
 * 现在改成轮盘：三个方向摆着另外三档，点哪个是哪个；圆心那个 × 是关。
 *
 * 轮盘上只摆**除当前这档以外的三档** —— 当前档要也在上面，就多了一块
 * 点了没反应的格子，而轮盘上每一格都该是一次真的改变。
 */
function onCanvasContext(e) {
  e.preventDefault();
  const { x, y } = canvasPos(e);
  const hit = renderer.hitTest(x, y);
  if (!hit || hit.ownerId !== app.humanId || hit.zone !== 'hand') {
    // 空白处右键 = 关掉轮盘。顺带把浏览器自带菜单也挡在这一层
    // （preventDefault 只管住画布，菜单是唯一入口这件事才说得通）。
    closeVisMenu();
    return;
  }
  if (!humanCanAct()) {
    toast('还没轮到你');
    return;
  }
  openVisMenu(hit.card.id);
}

/**
 * 上一次打开轮盘时提示过用法没有。
 *
 * 轮盘上那两张小牌（左＝你看到的、右＝外人看到的）是自解释的，但那要用户
 * 先知道**左边那张代表自己**。这句话不写出来，第一眼看到的就是"三个方向
 * 各两张小牌"，只能靠试。提示一次就够 —— 每次都弹就成了噪音。
 */
let visMenuTaught = false;

function openVisMenu(cardId) {
  app.ui.visMenu = { cardId, hover: null };
  app.ui.hoverId = cardId; // 轮盘钉在这张牌上，牌保持抬起，盘子才不会跟着鼠标跳
  renderAll();
  if (!visMenuTaught) {
    visMenuTaught = true;
    toast('三块里左边那张小牌是你看到的，右边那张是外人看到的；点圆心关掉');
  }
}

function closeVisMenu() {
  if (!app.ui.visMenu) return;
  app.ui.visMenu = null;
  renderAll();
}

/** 轮盘上点了一档：改成它，然后收起来 */
function applyVisMenu(mode) {
  const m = app.ui.visMenu;
  if (!m) return;
  const card = app.state.cards[m.cardId];
  app.ui.visMenu = null;
  if (!card) { renderAll(); return; }

  app.state = applyEvent(app.state, ev.reveal(app.humanId, m.cardId, mode));
  toast(`${card.label} → ${VIS_META[mode].label}（翻牌不结束回合）`);
  renderAll();
}

/**
 * 轮盘钉在一张具体的牌上。这张牌一旦不在我手上了（出掉了、被抢了、开新局了），
 * 盘子就该自己消失 —— 留着一个指向"已经不在的牌"的轮盘，点它什么都不会发生，
 * 而用户只会以为自己点偏了。
 */
function pruneVisMenu() {
  const m = app.ui.visMenu;
  if (!m) return;
  if (!app.state) { app.ui.visMenu = null; return; }
  const me = app.state.players.find((p) => p.id === app.humanId);
  const card = app.state.cards[m.cardId];
  const mine = !!card && card.ownerId === app.humanId && !!me && me.hand.includes(m.cardId);
  if (!mine) app.ui.visMenu = null;
}

function onCanvasMove(e) {
  const { x, y } = canvasPos(e);

  // 轮盘开着的时候不认「鼠标停在哪张牌上」：鼠标一挪到扇区上，底下那张牌
  // 就落回去了，而轮盘是钉在这张牌上的 —— 整个盘子会跟着往下跳一下。
  if (app.ui.visMenu) {
    const m = renderer.menuHitTest(x, y);
    const hover = m ? (m.kind === 'close' ? 'close' : m.vis) : null;
    if (hover !== app.ui.visMenu.hover) {
      app.ui.visMenu.hover = hover;
      renderAll();
    }
    return;
  }

  const hit = renderer.hitTest(x, y);
  const id = hit ? hit.card.id : null;
  // 牌优先：手指落在牌上时，不要把牌后面那个人也一起点亮
  const seat = hit ? null : renderer.seatHitTest(x, y);
  const hoverSeat = seat && seat.hasAgent !== false ? seat.id : null;
  if (id !== app.ui.hoverId || hoverSeat !== app.ui.hoverSeat) {
    app.ui.hoverId = id;
    app.ui.hoverSeat = hoverSeat;
    renderAll();
  }
}

// ---------------------------------------------------------------------------
// 设置面板
// ---------------------------------------------------------------------------

/**
 * 服务商下拉里摆什么。
 *
 * 只摆【实测能浏览器直连】的那几家。这是本项目的立身之本：纯前端站点，别人打开
 * 就能用。把预检过不去的那几家（商汤 / Anthropic / OpenAI）摆出来，等于给用户一个
 * 一定踩的坑 —— 他填完 Key 只会看到一句 Failed to fetch，既看不出是地址写错还是
 * 这家根本不支持，也不知道该换成谁。所以那几家**直接不出现**。
 *
 * 唯一的例外是「当前配置正停在一家已下架的服务商上」（老用户存下来的，或从旧版本
 * 升上来的）。这时把它补在末尾并选中 —— 这不是重新提供那个选项，而是**不许静默**：
 * 用户的配置被人偷偷改掉，比看到一个标着「已下架」的条目糟糕得多。他一换走，
 * 这一项就不再出现（applyPreset / syncProviderToUrl 每次都会重建这张列表）。
 */
function buildProviderSelect() {
  const sel = $('cfg-provider');
  sel.textContent = '';
  for (const p of SELECTABLE_PRESETS) {
    const opt = el('option', null, p.name);
    opt.value = p.id;
    sel.appendChild(opt);
  }

  const cur = app.config.providerId || DEFAULT_PROVIDER_ID;
  // 认不出来的 id 不当成「已下架」处理 —— 那会凭空造出一个连名字都对不上的条目。
  // 只有预设表里确实存在、只是不再提供的那几家才补上来。
  const retired = isSelectable(cur) ? null : (PROVIDER_PRESETS.find((p) => p.id === cur) || null);
  if (retired) {
    const opt = el('option', null, `${retired.name}（已下架 · 浏览器直连走不通）`);
    opt.value = retired.id;
    sel.appendChild(opt);
  }

  // 一律落到一个真实存在的选项上，否则下拉在浏览器里会是一片空白
  // ——「框里什么都没有、配置里却写着某个 id」正是这个项目最想避免的两处对不上。
  sel.value = (isSelectable(cur) || !!retired) ? cur : DEFAULT_PROVIDER_ID;
}

/**
 * 把模型放进下拉框。
 *
 * 一个反复踩到的坑：选了具体模型之后，如果这个模型名不在清单里（比如从预设
 * 切到了自定义中转），下拉框会退回占位项 —— 界面上看起来「模型是空的」，
 * 但输入框里其实有值，两处对不上。所以清单里没有当前模型时，把它作为
 * 「（当前）」补在第一项，让两处永远一致。
 */
function renderModelOptions(list, selected) {
  const sel = $('cfg-model-select');
  if (!sel) return;
  sel.textContent = '';

  const ph = el('option', null, list.length ? '— 选择模型 —' : '— 填好地址与 Key 后点「拉取」—');
  ph.value = '';
  sel.appendChild(ph);

  for (const m of list) {
    const opt = el('option', null, m.id);
    opt.value = m.id;
    if (m.description) opt.title = m.description;
    sel.appendChild(opt);
  }

  if (selected && !list.some((m) => m.id === selected)) {
    const cur = el('option', null, `${selected}（当前）`);
    cur.value = selected;
    sel.appendChild(cur);
  }

  sel.value = selected || '';
}

let lastModelQuery = '';
/** 上一次读失败时用的地址+Key。同一个地址不再反复报同一句错。 */
let lastModelError = '';

/**
 * 从接口读模型清单。
 *
 * auto=true 是用在「地址/Key 一改就自动读」的场合：不同的是它会跳过重复请求
 * （同一个地址刚读过就不再打一次），但【失败照样要说话】。
 * 一开始这里写成「已经有清单就不吭声」，结果是真失败被静默吞掉 —— 端到端
 * 跑出来只看到预设那一个模型，界面上没有任何异常提示，正是这个项目最该避免的
 * 那类毛病：不报错，但也没生效。
 */
async function fetchModels({ auto = false } = {}) {
  const note = $('cfg-model-note');
  const btn = $('cfg-model-fetch');
  const baseUrl = app.config.baseUrl;
  const apiKey = app.config.apiKey;

  if (!baseUrl) {
    if (!auto) note.textContent = '先填接口地址。';
    return;
  }
  if (!apiKey) {
    if (!auto) note.textContent = '先填 API Key —— 读清单要带认证。';
    return;
  }

  const query = `${baseUrl}\u0000${apiKey}`;
  if (auto && query === lastModelQuery && app.modelOptions.length) return;
  if (auto && query === lastModelError) return;

  if (btn) { btn.disabled = true; btn.textContent = '读取中…'; }
  note.textContent = '正在读取模型清单…';

  try {
    const all = await listModels({ config: app.config });
    // 商汤那类聚合站会把「出图模型」也列出来，选中它只会在开局时报错。
    const usable = all.filter((m) => !m.outputs || m.outputs.includes('text'));
    const hidden = all.length - usable.length;

    lastModelQuery = query;
    lastModelError = '';
    app.modelOptions = usable;
    renderModelOptions(usable, app.config.model);

    note.textContent = usable.length
      ? `读到 ${usable.length} 个可用模型${hidden ? `（已滤掉 ${hidden} 个不输出文字的）` : ''}，选中即生效。`
      : '接口返回的清单是空的，手动填写模型名即可。';
  } catch (err) {
    lastModelError = query;
    note.textContent = `读取失败：${err.message}。可以手动填写模型名。`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '拉取'; }
  }
}

/**
 * 把「这家能不能浏览器直连」写在面板上。
 *
 * 用户要的是**纯前端**网站 ——「别人打开就能用，不必在本地开个服务」。那这件事
 * 就必须在**选服务商那一刻**看得见，而不是等他部署完才发现被 CORS 拦了。
 * 能力位是实测来的（tools/cors-probe.html 在真浏览器里逐家打过），不是抄的宣传词。
 */
function renderDirectBadge(preset) {
  const el = $('cfg-direct');
  if (!el) return;
  const d = preset && preset.direct;
  if (d === true) {
    el.textContent = '✅ 浏览器可直连 —— 部署成静态网站后别人打开就能用，不需要任何后端。';
    el.style.color = '#7fc48a';
  } else if (d === false) {
    // 这一段现在只会出现在「老配置正停在一家已下架的服务商上」。所以要把两件事都说出来：
    // ① 它为什么不在上面那张列表里；② 你原来的选择我没有替你改。
    el.textContent = '⚠️ 这家浏览器直连走不通，面板里已不再提供它 —— 你的配置仍停在这一家上。'
      + '要接着用，得自建代理（见 README），并把地址填成代理地址。';
    el.style.color = '#d8c07a';
  } else {
    el.textContent = '能不能直连，取决于你这台中转有没有补 CORS 头。';
    el.style.color = '';
  }
}

function applyPreset(id) {
  const preset = getPreset(id);
  app.config.providerId = preset.id;
  app.config.style = preset.style;
  // 一家的私有旋钮不能带去另一家：必须无条件覆盖（没有就清成 null）。
  // 漏了这一步，从商汤切到 OpenAI 会带着 reasoning_effort 过去，轻则被拒，重则行为诡异。
  app.config.extraBody = preset.extraBody || null;
  if (!app.config.baseUrl || !app.config.touchedUrl) {
    app.config.baseUrl = preset.baseUrl;
    $('cfg-baseurl').value = preset.baseUrl;
  }
  if (!app.config.model) {
    app.config.model = preset.defaultModel;
    $('cfg-model').value = preset.defaultModel;
  }

  // 预设自带的清单先垫上，用户立刻就能选；点「拉取」再读接口上的完整清单。
  // 换了服务商，之前那份清单就不能留 —— 那是别家的模型名。
  const presetModels = (preset.models || []).map((mid) => ({ id: mid }));
  lastModelQuery = '';
  lastModelError = '';
  app.modelOptions = presetModels;
  renderModelOptions(presetModels, app.config.model);
  $('cfg-model-note').textContent = presetModels.length
    ? '这是该服务商的常用模型。点「拉取」可读取接口上的完整清单。'
    : '这家没有内置清单，点「拉取」从接口读取。';

  $('cfg-note').textContent = preset.note || '';
  renderDirectBadge(preset);
  // 重建一次列表：从「已下架」那一项切走之后，它就该从下拉里消失。
  // （那一项只代表「你的配置现在停在这儿」，不该变成一个常驻的选项。）
  buildProviderSelect();
  persistConfig();
}

/**
 * 地址被手改之后，服务商标签必须**立刻**跟上，不能等下次刷新。
 *
 * 之前这里是「标签归标签、地址归地址」：用户从 Anthropic 改到自己的中转地址时，
 * 界面还写着 Claude，协议也还是 Claude 那一套（打 /messages、认证走 x-api-key），
 * 请求怎么打都不通，而界面上一点异常都看不出来 —— 刷新一次才会自愈，
 * 可用户没理由无缘无故刷新。
 *
 * 注意**不清 extraBody**：走中转时，上游那家的私有参数仍然要带过去
 * （中转是原样转发请求体的）。要清的只是「协议风格」这类由服务商推导的东西。
 */
function syncProviderToUrl() {
  const before = app.config.providerId;
  app.config = reconcileProvider(app.config);
  if (app.config.providerId === before) return;
  // 重建而不是直接写 value：改判之后「已下架」那一项不该再留在列表里。
  buildProviderSelect();
  $('cfg-note').textContent = getPreset(app.config.providerId).note || '';
  renderDirectBadge(getPreset(app.config.providerId));
  persistConfig();
}

function bindSettings() {
  const cfgKey = $('cfg-key');
  const cfgUrl = $('cfg-baseurl');
  const cfgModel = $('cfg-model');
  const cfgModelSel = $('cfg-model-select');

  cfgKey.value = app.config.apiKey || '';
  cfgUrl.value = app.config.baseUrl || '';
  cfgModel.value = app.config.model || '';

  $('cfg-provider').addEventListener('change', (e) => {
    app.config.touchedUrl = false;
    applyPreset(e.target.value);
  });

  cfgKey.addEventListener('input', () => {
    app.config.apiKey = cfgKey.value.trim();
    persistConfig();
  });
  cfgUrl.addEventListener('input', () => {
    app.config.baseUrl = cfgUrl.value.trim();
    app.config.touchedUrl = true;
    syncProviderToUrl();
    persistConfig();
  });
  cfgModel.addEventListener('input', () => {
    app.config.model = cfgModel.value.trim();
    // 手写的名字也要让下拉框跟上，否则两处显示不一致。
    if (cfgModelSel && cfgModelSel.value !== app.config.model) {
      renderModelOptions(app.modelOptions, app.config.model);
    }
    persistConfig();
  });

  // 从下拉里选 = 定下模型。这里不再需要手打。
  if (cfgModelSel) {
    cfgModelSel.addEventListener('change', (e) => {
      const v = e.target.value;
      if (!v) return;
      app.config.model = v;
      cfgModel.value = v;
      persistConfig();
    });
  }

  const fetchBtn = $('cfg-model-fetch');
  if (fetchBtn) fetchBtn.addEventListener('click', () => fetchModels());

  // 地址或 Key 改完（失焦）就自动去读一次清单 —— 用户的诉求正是
  // 「URL 输完以后去选择模型」，而不是输完 URL 还得自己手打模型名。
  cfgUrl.addEventListener('change', () => fetchModels({ auto: true }));
  cfgKey.addEventListener('change', () => fetchModels({ auto: true }));

  $('cfg-godview').addEventListener('change', (e) => {
    app.ui.godView = e.target.checked;
    renderAll();
  });

  const breachBox = $('cfg-breach');
  breachBox.checked = allowBreach();
  breachBox.addEventListener('change', (e) => {
    app.config.allowBreach = e.target.checked;
    persistConfig();
  });

  $('btn-new').addEventListener('click', newGame);
  $('btn-say').addEventListener('click', sendHumanSpeech);
  $('btn-fold').addEventListener('click', () => submitHuman(act.fold(app.ruleSet.foldLabel || '认输')));
  $('btn-endturn').addEventListener('click', submitHumanEndTurn);
  const playBtn = $('btn-play');
  if (playBtn) playBtn.addEventListener('click', submitHumanPlay);

  const ruleSel = $('rule-select');
  if (ruleSel) {
    ruleSel.addEventListener('change', (e) => {
      const rs = getRuleSet(e.target.value);
      if (!rs) return;
      app.ruleSet = rs;
      app.ui.selectedIds = [];
      // 启动层是「玩什么、几个人」的唯一出处，改这里也要同步过去 ——
      // 否则回一趟大厅会看到玩法又跳回去了
      app.lobby?.setRuleset(rs.id);
      buildPlayerSelect();
      newGame();
    });
  }

  // 人数下拉框：不立刻重开（和玩法那个不同），改动在下次「新开一局」生效。
  // 但必须同步进启动层，不然大厅里的档位跟这里会对不上
  const playerSel = $('setup-players');
  if (playerSel) {
    playerSel.addEventListener('change', (e) => app.lobby?.setPlayers(e.target.value));
  }

  // 抽屉把手 + 返回大厅
  $('handle')?.addEventListener('click', () => {
    document.body.classList.toggle('drawer-open');
    // 抽屉开合会改变牌桌宽度（canvas 是 100% 宽的），等 CSS 过渡结束再重量一次
    setTimeout(() => renderer?.resize(), 300);
  });
  $('btn-lobby')?.addEventListener('click', () => app.lobby?.setScene('lobby'));

  const seedSel = $('seed-source');
  if (seedSel) {
    seedSel.addEventListener('change', () => {
      applySeedSourceUi();
      const box = $('seed-note');
      if (box && app.state && app.state.phase !== 'over') {
        box.textContent += ' 来源的改动会在下次「新开一局」时生效。';
      }
    });
  }

  $('say-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') sendHumanSpeech();
  });
}

function buildRuleSelect() {
  const sel = $('rule-select');
  if (!sel) return;
  sel.textContent = '';
  for (const rs of listRuleSets()) {
    const opt = el('option', null, `${rs.name}（${rs.minPlayers}-${rs.maxPlayers} 人）`);
    opt.value = rs.id;
    sel.appendChild(opt);
  }
  sel.value = app.ruleSet.id;
  // 可选的玩家人数由玩法决定，玩法一变必须重建
  buildPlayerSelect();
}

/** 胜率引擎档位：关掉 / 快速 / 标准 / 深入 */
function applyEngineMode(id) {
  const mode = getEngineMode(id);
  if (typeof app.winrateEngine.setMode === 'function') app.winrateEngine.setMode(id);
  const note = $('cfg-engine-note');
  if (note) {
    note.textContent = mode.budgetMs
      ? `${mode.hint}。采样全部在本机浏览器里跑，不发出任何网络请求。`
      : '已关闭：提示词里不再出现胜率表，智能体只能凭模型自己的判断出牌（没填 Key 时会退回到启发式打法）。';
  }
}

function buildEngineSelect() {
  const sel = $('cfg-engine');
  if (!sel) return;
  sel.textContent = '';
  for (const m of ENGINE_MODES) {
    const opt = el('option', null, m.label);
    opt.value = m.id;
    sel.appendChild(opt);
  }
  const cur = app.config.engineMode || 'normal';
  sel.value = cur;
  applyEngineMode(cur);
  sel.addEventListener('change', (e) => {
    app.config.engineMode = e.target.value;
    persistConfig();
    applyEngineMode(e.target.value);
    renderEnginePanel();
  });
}

function sendHumanSpeech() {
  const input = $('say-input');
  const text = input.value.trim();
  if (!text) return;
  app.state = applyEvent(app.state, ev.speak(app.humanId, text));
  input.value = '';
  renderAll();
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

function init() {
  app.config = loadConfig();
  if (app.config.allowBreach === undefined) app.config.allowBreach = true;
  if (app.config.engineMode === undefined) app.config.engineMode = 'normal';

  const canvas = $('table-canvas');
  renderer = createTableRenderer(canvas);
  renderer.resize();

  buildProviderSelect();
  applyPreset(app.config.providerId || DEFAULT_PROVIDER_ID);

  buildRuleSelect();
  buildSeedSourceSelect();
  buildEngineSelect();
  bindSettings();

  /**
   * 启动层。**它排在 init 的最后一行**：开局前的每一件事都要先定下来 ——
   * 玩什么、几个人、谁和你玩 —— 定完才进牌桌。
   * 页面一打开是纯黑的大厅，不是一局已经发好牌的牌桌。
   */
  app.lobby = initLobby({
    onToast: toast,
    onStart: ({ rsId, players, agents }) => {
      const rs = getRuleSet(rsId);
      if (rs) app.ruleSet = rs;
      // 人数下拉框的选项由玩法决定，换了玩法必须重建
      buildPlayerSelect();
      startGame({ players, agents });
    },
  });

  // 名册被改了（多半是在牌桌上点开某个人改完保存）→ 这一局里的他跟着变。
  // 开局后就不用再管选人页了，那是 lobby 自己的事
  onRosterChange(syncAgentsFromRoster);

  // 已经存过配置的老用户：开页面就把模型清单读回来，省得每次都点一下「拉取」。
  // 失败不吭声（auto），手写模型名那条路一直通着。
  if (app.config.baseUrl && app.config.apiKey) fetchModels({ auto: true });

  canvas.addEventListener('click', onCanvasClick);
  canvas.addEventListener('contextmenu', onCanvasContext);
  canvas.addEventListener('mousemove', onCanvasMove);
  canvas.addEventListener('mouseleave', () => {
    // 轮盘开着的时候鼠标移出去不算"离开"：盘子钉在那张牌上，牌一落下
    // 整个盘子就跟着往下跳一截。它自己有关掉的路（点圆心、点别处、Esc）。
    if (app.ui.visMenu) return;
    if (app.ui.hoverId || app.ui.hoverSeat) {
      app.ui.hoverId = null;
      app.ui.hoverSeat = null;
      renderAll();
    }
  });

  // 轮盘盖着牌面，鼠标又很难点到圆心那一小块 —— 给一条键盘的路。
  // （启动层的名册编辑框也是这么处理 Esc 的。）
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.ui.visMenu) closeVisMenu();
  });

  /**
   * 画布尺寸跟着舞台走，而不是只听 window.resize。
   *
   * 两个理由：
   *   · 牌桌在启动层里是 display:none，量出来 0×0 —— 必须等它真正出现时重量一次；
   *   · 抽屉开合改的是 .layout 的 padding（CSS 过渡 280ms），窗口尺寸没变，
   *     window.resize 根本不会触发，而牌桌确实窄了一截。
   * 一帧内合并多次回调：过渡期间会连发几十次，画一次就够了。
   */
  const stage = canvas.parentElement;
  if (stage && typeof ResizeObserver === 'function') {
    let pending = false;
    const ro = new ResizeObserver(() => {
      if (pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        renderer.resize();
      });
    });
    ro.observe(stage);
  }

  window.addEventListener('resize', () => renderer.resize());

  applyRuleSetUi();
  // 注意：这里**不**开局。等用户在启动层里选定并点「开始游戏」。
}

document.addEventListener('DOMContentLoaded', init);

/**
 * 测试钩子：供 tools/dom-smoke.mjs 在无浏览器环境下驱动一整局。
 * 生产运行时不读取这里，也不影响任何行为。
 */
export const __test = {
  app,
  getRenderer: () => renderer,
  hasLLMConfig,
  chooseLocalDecision,
  actionOpts,
  buildPlayerSelect,
  reconcileProvider,
  /** 服务商下拉的重建入口。自检要验「哪些家摆/不摆在面板上」时得能重新生成一次 */
  buildProviderSelect,
  /** 启动层（选模式 → 选谁和你玩）。测试脚本靠它走完开赛前的两步 */
  getLobby: () => app.lobby,
  startGame,
};
