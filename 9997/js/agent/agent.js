/**
 * agent.js — 智能体
 *
 * 每个智能体是一份纯数据：人设、便签、历史、统计。
 * 智能体可以在对局中修改自己的人设（自我演化），
 * 也可以给自己留便签 —— 便签对玩家不可见，
 * 且只在「下一次」LLM 调用时注入一次。
 */

let noteSeq = 0;

export const NOTE_MAX_CHARS = 500;

/**
 * avatar 是形象库里的一项 id（见 js/ui/avatars.js），只影响**画面上长什么样**：
 * 座位立绘、抽屉里的头像、名册里的卡片读的都是它。它不进提示词，
 * 也不参与任何规则判断 —— 换个形象不该改变他怎么打牌。
 * 留 null 表示"这一席空着"，渲染层会画成金色剪影。
 */
export function createAgent({
  id, name, isHuman = false, persona = '', color = '#185FA5', avatar = null, rosterId = null,
}) {
  return {
    id,
    name,
    isHuman,
    persona: isHuman ? '' : persona,
    personaHistory: [],
    notes: [],
    stats: { calls: 0, errors: 0, retries: 0, local: 0, lastError: null },
    color,
    avatar,
    // 这个座位对应名册里的哪一条 —— 牌桌上「点人物看 / 改设定」靠它回去找人。
    // 和 avatar 一样属于展示层：不进提示词，不参与任何规则判断
    rosterId,
  };
}

// ---------------------------------------------------------------------------
// 便签
// ---------------------------------------------------------------------------

/**
 * 取尚未注入的便签。
 * 只有这些会被拼到提示词末尾。
 */
export function pendingNotes(agent) {
  return agent.notes.filter((n) => !n.delivered);
}

export function addNote(agent, text) {
  const clean = String(text ?? '').trim();
  if (!clean) return agent;
  return {
    ...agent,
    notes: [
      ...agent.notes,
      {
        id: `note-${++noteSeq}`,
        text: clean.slice(0, NOTE_MAX_CHARS),
        delivered: false,
        at: Date.now(),
      },
    ],
  };
}

/**
 * 标记便签已注入。
 *
 * 【关键】必须在 LLM 调用【成功返回之后】才调用这个函数。
 * 如果在拼装提示词时就标记，一次网络失败就会把便签永久吃掉，
 * 智能体写下的提醒再也送不出去。
 */
export function markNotesDelivered(agent, ids) {
  if (!ids || !ids.length) return agent;
  const set = new Set(ids);
  return {
    ...agent,
    notes: agent.notes.map((n) => (set.has(n.id) ? { ...n, delivered: true } : n)),
  };
}

// ---------------------------------------------------------------------------
// 自我设定修改
// ---------------------------------------------------------------------------

/**
 * 智能体修改自己的设定。
 * patch 有两种形态：
 *   字符串            → 整段替换人设
 *   { append: '...' } → 在人设后追加一条自我认知
 */
export function applyProfilePatch(agent, patch, reason = '') {
  let nextPersona = agent.persona;

  if (typeof patch === 'string') {
    nextPersona = patch.trim();
  } else if (patch && typeof patch === 'object' && typeof patch.append === 'string') {
    nextPersona = `${agent.persona}\n${patch.append.trim()}`;
  } else {
    return agent;
  }

  if (!nextPersona || nextPersona === agent.persona) return agent;

  return {
    ...agent,
    persona: nextPersona,
    personaHistory: [
      ...agent.personaHistory,
      { at: Date.now(), from: agent.persona, to: nextPersona, reason },
    ],
  };
}

export function bumpStats(agent, patch) {
  return { ...agent, stats: { ...agent.stats, ...patch } };
}
