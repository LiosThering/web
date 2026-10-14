/**
 * roster.js — 智能体名册（选手层）
 *
 * 「谁上场、叫什么、什么脾气、长什么样」都在这里。
 * 形象本身不在这里 —— 那是 avatars.js 的素材库，名册里的人只是**指向**它。
 *
 * 存哪、怎么坏
 * ------------------------------------------------------------------
 * 落 localStorage 的 `ai-card-table.agents.v1`（口径对齐真实前端的 config.v1）。
 * 存进去、读出来的东西都是**外部输入**：可能被手改过、可能是别的版本写的、
 * 可能里面写着一个本机没有的形象 id。所以：
 *   · 读坏了不让页面打不开 —— 吞掉异常，退回默认名册；
 *   · 导入的每一份都先 normalizeAgent 收口，再交给界面；
 *   · 形象 id 认不出来时**回退要有回声**（记 avatarFallback，导入完统一报给用户）。
 *     静默回退是最坏的做法：用户拿到一份名册，看到的是「三个老千」，却不知道为什么。
 *
 * 导出只带形象 id、不带图 —— 文件小，换机可用。
 * 也**不含任何 API Key**：那是「导出设置」的事，跟名册是两件东西。
 */

import { AVATARS, AVATAR_IDS, DEFAULT_AVATAR } from './avatars.js';

export { AVATARS, AVATAR_IDS, DEFAULT_AVATAR };

export const ROSTER_KEY = 'ai-card-table.agents.v1';
export const ROSTER_FORMAT = 'ai-card-table.agents';
export const ROSTER_VERSION = 1;

/**
 * 默认名册的**出厂批号**。每次往默认名册里加人，都要 +1 并登记到 SEED_BATCHES。
 *
 * 为什么需要它：默认名册只在浏览器「从没存过名册」时才会被用上（见 loadRoster）。
 * 但用户一旦打过一局，localStorage 里就躺着一份旧名册 —— 后加的默认人物
 * 对他就**永远不会出现**，而他没有任何理由知道这件事：他会看到一个只有三个人的
 * 「选谁和你玩」，以为游戏就这么点人。
 *
 * 所以存档里记一个批号：读到的批号比当前旧，就把**那之后新增的**默认人物补进去。
 * 三条边界，都是刻意的：
 *   · 只补「id 不在名册里」的 —— 用户改过名字/人设的人不会被覆盖；
 *   · 只补「这一批新增的」 —— 用户删掉的老人物不会被复活；
 *   · 补了什么要说出来（takeSeedNotice）—— 名册里凭空多出五个人而不给个说法，
 *     用户只会以为是自己点错了。
 *
 * 批号管的是「名册里有**哪些人**」，管不着「这个人被**写成什么样**」。
 * 我重写一遍默认人设，老存档里存的仍是那个人设的旧副本 —— 同一个坑换了
 * 一个维度。那是 DEFAULT_PERSONA_REV / LEGACY_PERSONAS 的事（见下），
 * 机制同源、判据不同。
 */
export const DEFAULT_SEED = 2;

/**
 * 批号 → 那一批新加的默认人物 id。
 * **首批也登记进来**（而不是当成「隐含的 0 号批」）—— 这样门禁可以断言
 * 「DEFAULT_AGENTS 里的人一个不落、全都在某批里」，也就堵住了最容易犯的那个错：
 * 往默认名册里加了人、却忘了登记批次 —— 新访客看得见，老存档永远看不见。
 */
export const SEED_BATCHES = {
  1: ['ag-qianke', 'ag-nvpv', 'ag-wangzi'],
  2: ['ag-gongzhu', 'ag-qishi', 'ag-wangzi-2', 'ag-kulou', 'ag-xianzi'],
};

/**
 * 默认人设的**文案版本**。每次改动默认人物的 persona，都要 +1，
 * 并把**改之前的原文**整段挪进 LEGACY_PERSONAS 对应那一版。
 *
 * 为什么需要它：批号（seed）管的是「有哪些人」，管不了「这个人写成什么样」。
 * 用户打过一局之后，他的名册里存着的是**那一刻的文案副本** —— 我后来把
 * 老千的人设重写一遍，他看到的还是旧的，而且没有任何理由知道这件事。
 * 这跟「后加的默认人物对老用户永远不出现」是同一个坑，只是换了个维度。
 *
 * 升级的判据是**逐字比对出厂原文**：存档里那份 persona 一字不差地等于
 * 某个历史版本，才认定「他没动过，可以升级」；只要差一个字，就当是他自己
 * 写的，绝不去碰。宁可漏升级，不可覆盖用户写的东西。
 *
 * 门禁会断言「DEFAULT_AGENTS 里每个人都在 LEGACY_PERSONAS 的某一版里有记录」——
 * 改了文案却忘了留旧版，老存档就永远升不上来，而这种错**只有老用户会遇上**。
 */
export const DEFAULT_PERSONA_REV = 2;

/**
 * 文案版本 → 那一版的出厂原文（id → persona）。
 * 只用来识别「存档里这份是不是出厂写的」，不参与任何显示。
 */
export const LEGACY_PERSONAS = {
  1: {
    'ag-qianke': '牌桌上混了二十年的老手，说话简短带刺，喜欢用虚张声势压人。',
    'ag-nvpv': '安静的女仆，出牌前会盯着桌面看很久。她记牌，记得比谁都清楚。',
    'ag-wangzi': '自称黑桃国的王子，说话夸张、动作大。牌打得其实很糙，但特别喜欢抢牌。',
    'ag-gongzhu': '裙摆比牌桌还讲究的公主。她不许自己输，也不许别人赢得难看——真输了就说这是让着你的。',
    'ag-qishi': '认死理的骑士。说出口的承诺一定做到，包括「这局我让你三张」这种话，然后真的让。',
    'ag-wangzi-2': '穿宝蓝礼服、随身带一朵玫瑰的王子。他打牌像在赴宴：不着急，但每一手都要好看。',
    'ag-kulou': '一副会打牌的骨架，披着件旧斗篷。它记不清自己生前是谁，只记得赌债还没还清。',
    'ag-xianzi': '轻飘飘的小仙子，说话像撒糖。出牌全凭心情，赢了拍手，输了也说好玩。',
  },
};

/**
 * 默认名册：八个人，形象与名字一一对应。
 *
 * 前三位是 2026-10-07 的首批；后五位 2026-10-14 加（公主 / 骑士 / 王子 / 骷髅 / 仙子）。
 * **顺序就是它在「选谁和你玩」里的呈现顺序**，也对齐 SEED_BATCHES 的批号顺序。
 */
export const DEFAULT_AGENTS = [
  {
    id: 'ag-qianke', name: '老千', avatar: 'char-1-qianke',
    persona: '牌桌上混了二十年的老手，说话简短带刺，喜欢用虚张声势压人。'
      + '在他眼里出千是手艺：牌桌上比的是谁的手段高。他动手干脆，偏爱偷看、换牌这类'
      + '不留把柄的技术活；至于伸手去抢——那是没本事的人才干的。',
  },
  {
    id: 'ag-nvpv', name: '女仆', avatar: 'char-2-nvpv',
    persona: '安静的女仆，出牌前会盯着桌面看很久。每张牌在谁手上她都清楚，所以多数时候'
      + '守规矩对她更划算；只有算准了不越线就赢不了，她才会安静地看一眼别人的牌，一次就够。',
  },
  {
    id: 'ag-wangzi', name: '黑桃王子', avatar: 'char-3-pixel-heitao-wangzi',
    persona: '自称黑桃国的王子，说话夸张、动作大。牌打得其实很糙，但特别喜欢抢牌——'
      + '全凭一时兴起，从来不算划不划算，抢到手还理直气壮：「本王看上的牌，本来就该在本王手里」。',
  },
  {
    id: 'ag-gongzhu', name: '公主', avatar: 'char-5-gongzhu',
    persona: '裙摆比牌桌还讲究的公主。她不许自己输，也不许别人赢得难看——真输了就说这是'
      + '让着你的。规矩她只在赢的时候守：眼看要输，她会动手脚，但绝不肯去抢，那太难看了；'
      + '做完了也绝不承认。',
  },
  {
    id: 'ag-qishi', name: '骑士', avatar: 'char-6-qishi',
    persona: '认死理的骑士。说出口的承诺一定做到，包括「这局我让你三张」这种话，然后真的让。'
      + '他给自己立的规矩比牌桌的还硬，宁可输也不做见不得光的事；唯一的例外是谁先对他动了手脚'
      + '（而且全桌都看见了），那这规矩就等于对方先撕了，他会原样还回去。',
  },
  // 名字就叫「王子」，但 id 不能是 ag-wangzi —— 那个已经被黑桃王子占了。
  // 改老 id 会打断已有名册里存的选中项（picked 存的是 id），所以新的另起一个。
  {
    id: 'ag-wangzi-2', name: '王子', avatar: 'char-7-wangzi',
    persona: '穿宝蓝礼服、随身带一朵玫瑰的王子。他打牌像在赴宴：不着急，但每一手都要好看。'
      + '他嫌作弊难看——这么赢来的局不好意思跟人提；只有整桌打得实在没脸看的时候才破一次例，'
      + '而且做了就认。',
  },
  {
    id: 'ag-kulou', name: '骷髅', avatar: 'char-8-kulou',
    persona: '一副会打牌的骨架，披着件旧斗篷。它记不清自己生前是谁，只记得赌债还没还清。'
      + '债主认钱不认规矩，所以它也不认：输得越多越急，越急就越容易伸手，顺手抢一张、'
      + '把挡路的牌抹掉，它都觉得理所应当。',
  },
  {
    id: 'ag-xianzi', name: '仙子', avatar: 'char-9-xianzi',
    persona: '轻飘飘的小仙子，说话像撒糖。出牌全凭心情，赢了拍手，输了也说好玩。'
      + '她越线不是为了赢，是忽然觉得好玩——上一手还老老实实，这一手就可能伸手去翻别人的牌，'
      + '被抓住也笑得出来。',
  },
];

/** 默认名册的副本（调用方改不到常量上去） */
export function defaultRoster() {
  return DEFAULT_AGENTS.map((a) => ({ ...a }));
}

/**
 * 把「这一批之前就有了」的名册补齐到当前批号。
 * 导出是为了能在门禁里单独测它 —— 它管的是**外部输入的兼容**，不是界面细节。
 */
export function seedRoster(list, fromSeed) {
  const have = new Set(list.map((a) => a.id));
  const added = [];
  const out = [...list];
  for (const [batch, ids] of Object.entries(SEED_BATCHES)) {
    if (Number(batch) <= fromSeed) continue;
    for (const id of ids) {
      if (have.has(id)) continue;
      const def = DEFAULT_AGENTS.find((a) => a.id === id);
      if (!def) continue;
      have.add(id);
      out.push({ ...def });
      added.push(def);
    }
  }
  return { agents: out, added };
}

/** 某位默认人物历史上出过厂的所有原文（用来认「存档里这份是不是没动过」）。 */
function factoryTexts(id) {
  return Object.values(LEGACY_PERSONAS).map((table) => table[id]).filter(Boolean);
}

/**
 * 把存档里「还是出厂原文」的人设升到当前文案。见 DEFAULT_PERSONA_REV。
 *
 * 判据只有一条：**逐字**等于历史上出过厂的某一版原文。差一个字就当是用户自己写的，
 * 原样放过。这个方向的错是安全的 —— 漏升级只是他少看到一句新写的性格，
 * 而误覆盖会把他亲手写的东西抹掉，那是不可逆的。
 *
 * 不按 fromRev 限定「只能升级到某一版」：存档可能停在很久以前（甚至早于这个字段
 * 存在），只要那份文本是出厂写的，就该升到最新。
 */
export function upgradePersonas(list) {
  const updated = [];
  const out = list.map((a) => {
    const def = DEFAULT_AGENTS.find((d) => d.id === a.id);
    if (!def || a.persona === def.persona) return a;
    if (!factoryTexts(a.id).includes(a.persona)) return a;   // 用户自己写的，不碰
    updated.push({ id: def.id, name: def.name });
    return { ...a, persona: def.persona };
  });
  return { agents: out, updated };
}

/**
 * 最近一次读存档时对名册做的修正。界面取走一次就清空（别每次都弹一遍提示）。
 * 两个通道分开记：补进来的人要报名字，更新了文案的人报个数就够了。
 */
let seedNotice = { added: [], updated: [] };
export function takeSeedNotice() {
  const out = seedNotice;
  seedNotice = { added: [], updated: [] };
  return out;
}

/**
 * 把任意来源的一位智能体收拾成规范形态。
 * 缺字段、类型不对、形象 id 本机没有，都在这里收口 —— 而不是漏到渲染层去炸。
 */
export function normalizeAgent(raw, seq = 0) {
  const a = raw && typeof raw === 'object' ? raw : {};
  const name = String(a.name ?? '').trim();
  return {
    id: String(a.id ?? '').trim() || `ag-${Date.now().toString(36)}-${seq}`,
    name: name || '无名',
    avatar: AVATAR_IDS.includes(a.avatar) ? a.avatar : DEFAULT_AVATAR,
    persona: String(a.persona ?? '').trim(),
    /** 形象是本机没有的那一个 —— 记下来，导入完统一报给用户 */
    avatarFallback: !!a.avatar && !AVATAR_IDS.includes(a.avatar),
  };
}

let roster = loadRoster();
const listeners = new Set();

export function onRosterChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit() {
  for (const fn of [...listeners]) {
    try { fn(roster); } catch (err) { console.warn('名册监听器出错：', err); }
  }
}

export function getRoster() {
  return roster;
}

export function loadRoster() {
  try {
    const raw = localStorage.getItem(ROSTER_KEY);
    if (!raw) return defaultRoster();
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : parsed?.agents;
    if (!Array.isArray(list) || !list.length) return defaultRoster();
    // 老存档里可能没写批号（早期版本只存了 {format, version, agents}）—— 当作第 1 批。
    const fromSeed = Array.isArray(parsed) ? 1 : (Number(parsed?.seed) || 1);
    // 人设文案版本同理：这个字段是后加的，老存档一律按第 1 版算。
    const fromRev = Array.isArray(parsed) ? 1 : (Number(parsed?.personaRev) || 1);
    const seeded = seedRoster(list.map(normalizeAgent), fromSeed);
    const { agents, updated } = upgradePersonas(seeded.agents);
    if (seeded.added.length || updated.length || fromRev < DEFAULT_PERSONA_REV) {
      seedNotice = { added: seeded.added, updated };
      // 改完立刻落盘 —— 否则下次打开会再补一遍，提示也就说第二遍。
      // 这里只能走 persist()（不读模块级 roster）：loadRoster 是在
      // `let roster = loadRoster()` 里跑的，那时 roster 还在暂时性死区里。
      persist(agents);
    }
    return agents;
  } catch {
    // 存储坏了不该让页面打不开 —— 退回默认名册
    return defaultRoster();
  }
}

/** 落盘。只认传进来的这份列表，不读模块状态（见 loadRoster 里的说明）。 */
function persist(list) {
  try {
    localStorage.setItem(ROSTER_KEY, JSON.stringify({
      format: ROSTER_FORMAT, version: ROSTER_VERSION,
      seed: DEFAULT_SEED, personaRev: DEFAULT_PERSONA_REV, agents: list,
    }));
  } catch { /* 隐私模式下写不进去，不影响本局 */ }
}

export function saveRoster() {
  persist(roster);
}

export function setRoster(list) {
  roster = (list || []).map(normalizeAgent);
  saveRoster();
  emit();
  return roster;
}

export function addAgent({ name, avatar, persona }) {
  const a = normalizeAgent({ id: `ag-${Date.now().toString(36)}`, name, avatar, persona });
  roster = [...roster, a];
  saveRoster();
  emit();
  return a;
}

export function updateAgent(id, patch) {
  roster = roster.map((x) => (x.id === id
    ? { ...x, ...patch, avatarFallback: false }
    : x));
  saveRoster();
  emit();
  return roster;
}

export function removeAgent(id) {
  roster = roster.filter((x) => x.id !== id);
  saveRoster();
  emit();
  return roster;
}

/**
 * 名册指纹。界面靠它判断「要不要重建卡片列表」。
 * 每次点击都重建整份列表的话，浏览器得把每张立绘重新解码一遍 ——
 * 三五个人看不出来，导入一份几十人的名册就会卡，而且会闪。
 */
export function rosterKey(list = roster) {
  return list.map((a) => `${a.id}:${a.avatar}:${a.name}:${a.persona}`).join('|');
}

// ---------------------------------------------------------------------------
// 导出 / 导入
// ---------------------------------------------------------------------------

export function rosterPayload() {
  return {
    format: ROSTER_FORMAT,
    version: ROSTER_VERSION,
    exportedAt: new Date().toISOString(),
    note: '只含智能体的名字 / 形象 / 人设，不含任何 API Key。',
    // 把可用形象清单一并写出去：接收方拿到一个 id 才知道它指哪张图
    avatars: AVATAR_IDS.map((id) => ({ id, label: AVATARS[id].label })),
    agents: roster.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, persona: a.persona })),
  };
}

/**
 * 解析一份导入的名册。
 * 返回 { ok, agents, warnings, error } —— **不直接替换**，先让调用方看清楚再说。
 * 格式 / 版本 / 类型 / 形象 id 四项都要校验，任何一项不对都要能说出「哪里不对」，
 * 而不是抛一个 SyntaxError 了事。
 */
export function parseRosterText(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: '这不是一份有效的 JSON 文件。' };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, error: '文件内容不是一个对象，认不出这是名册。' };
  }
  if (data.format !== ROSTER_FORMAT) {
    return {
      ok: false,
      error: `不是智能体名册（format = ${JSON.stringify(data.format ?? null)}，期望 ${ROSTER_FORMAT}）。`,
    };
  }
  const v = Number(data.version);
  if (!Number.isFinite(v) || v < 1) {
    return { ok: false, error: '名册缺少版本号。' };
  }
  if (v > ROSTER_VERSION) {
    return { ok: false, error: `这份名册来自更新的版本（v${v}），本页只认到 v${ROSTER_VERSION}。` };
  }
  if (!Array.isArray(data.agents) || !data.agents.length) {
    return { ok: false, error: '名册里一位智能体都没有。' };
  }

  const agents = data.agents.map(normalizeAgent);
  const warnings = [];
  const fell = agents.filter((a) => a.avatarFallback);
  if (fell.length) {
    const names = fell.map((a) => a.name).join('、');
    warnings.push(`有 ${fell.length} 位的形象这台机器上没有（${names}），已退回「${AVATARS[DEFAULT_AVATAR].label}」。`);
  }
  const dropped = data.agents.length - agents.length;
  if (dropped > 0) warnings.push(`${dropped} 条记录格式不对，已跳过。`);
  return { ok: true, agents, warnings };
}

export function downloadJson(filename, text) {
  const blob = new Blob([text], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---------------------------------------------------------------------------
// 落座
// ---------------------------------------------------------------------------

/**
 * 取本局上场的智能体，长度恒为 need。
 *
 * picked 故意允许「不够」：切场景、导入名册之后都可能出现中间态
 * （比如导入的新名册里没有原先选中的那几位）。这里用名册里还没上场的人补齐，
 * 而不是让渲染层去处理 undefined —— 崩在渲染里比补一个默认值难查得多。
 *
 * **顺序就是落座顺序**（先选的坐第一个座位）。
 */
export function activeAgents(picked, need) {
  const out = [];
  for (const id of picked || []) {
    const a = roster.find((x) => x.id === id);
    if (a && !out.includes(a)) out.push(a);
    if (out.length >= need) break;
  }
  for (const a of roster) {
    if (out.length >= need) break;
    if (!out.includes(a)) out.push(a);
  }
  return out.slice(0, need);
}

/** 把 picked 收拾成「只留下名册里还在的、且不超过 need 位」 */
export function prunePicked(picked, need) {
  const keep = (picked || []).filter((id) => roster.some((a) => a.id === id));
  const out = [];
  for (const id of keep) {
    if (out.length >= need) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
