/**
 * protocol.js — LLM 输出协议：解析、规范化、纠错重试
 *
 * 输出协议（智能体每次必须返回一个 JSON 对象）
 * {
 *   "speech":      "说出来的台词，没有就填 \"\"",
 *   "actions":     [ { "type": "play", "cards": ["c12"] }, … ],
 *   "endTurn":     true,
 *   "note":        "可选，留给下一次自己的便签",
 *   "profilePatch":"可选，修改自己的设定"
 * }
 *
 * 兼容旧的单动作写法：{"action": {…}} 等价于 actions 里放一个，
 * 也接受在 actions 里写 {"type":"endTurn"} 表示结束本回合。
 *
 * 本地是规则权威：LLM 只是提案者。凡是它提出但本地校验不通过的
 * 动作，一律打回重来，重试上限用尽后交给本地兜底策略。
 */

import { isEndTurnAction } from '../core/rules.js';

export const MAX_ATTEMPTS = 3;
export const SPEECH_MAX_CHARS = 500;

/** 从可能夹带废话或代码围栏的文本里抠出 JSON */
export function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();

  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  try {
    return JSON.parse(s);
  } catch {
    /* 继续尝试更宽松的提取 */
  }

  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) {
    const candidate = s.slice(start, end + 1);
    try {
      return JSON.parse(candidate);
    } catch {
      // 逗号尾随是模型最常见的笔误
      try {
        return JSON.parse(candidate.replace(/,\s*([}\]])/g, '$1'));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * 规范化 + 结构校验。
 * 返回 { ok, errors, value }，value.actions 一定是数组、value.endTurn 一定是布尔。
 */
export function normalizeResponse(obj) {
  const errors = [];
  const value = { speech: '', actions: [], endTurn: false, note: null, profilePatch: null };

  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    return { ok: false, errors: ['返回内容不是一个 JSON 对象'], value };
  }

  if (typeof obj.speech === 'string') {
    value.speech = obj.speech.trim().slice(0, SPEECH_MAX_CHARS);
  } else if (obj.speech == null) {
    errors.push('缺少 speech 字段');
  } else {
    errors.push('speech 必须是字符串');
  }

  let raw = [];
  const hasActions = Array.isArray(obj.actions);
  const hasAction = obj.action && typeof obj.action === 'object' && !Array.isArray(obj.action);

  if (hasActions) {
    raw = obj.actions;
  } else if (hasAction) {
    raw = [obj.action];
  } else if (obj.actions != null || obj.action != null) {
    errors.push('actions 必须是数组，action 必须是对象');
  }
  // 两者都缺省不报错：视为「这一手什么都不做」，这在牌桌上是合法的

  if (obj.endTurn === true) value.endTurn = true;

  for (const a of raw) {
    if (!a || typeof a !== 'object' || Array.isArray(a)) {
      errors.push('actions 里出现了不是对象的元素');
      continue;
    }
    if (isEndTurnAction(a)) {
      value.endTurn = true;
      continue;
    }
    value.actions.push(a);
  }

  if (typeof obj.note === 'string' && obj.note.trim()) value.note = obj.note.trim();
  if (typeof obj.profilePatch === 'string' && obj.profilePatch.trim()) {
    value.profilePatch = obj.profilePatch.trim();
  } else if (obj.profilePatch && typeof obj.profilePatch === 'object') {
    value.profilePatch = obj.profilePatch;
  }

  return { ok: errors.length === 0, errors, value };
}

/** 一次性走完解析与结构校验 */
export function parseResponse(text) {
  const json = extractJson(text);
  if (json === null) {
    return {
      ok: false,
      errors: ['没有从返回内容中找到合法的 JSON 对象'],
      value: { speech: '', actions: [], endTurn: false, note: null, profilePatch: null },
    };
  }
  return normalizeResponse(json);
}

/**
 * 构造纠错重试的提示词。
 * 把上次的原文、解析错误、以及规则层的拒绝理由一并回传给模型，
 * 让它知道具体哪里错了，而不是简单地「再试一次」。
 */
export function buildCorrectionPrompt({ previousText, errors, rejectedAction, rejectReason, truncated }) {
  const lines = ['你上一次的回复无法被本地执行，请重新给出一个正确的 JSON 对象。', ''];

  // 截断和「写错了」是两回事，要给它的话也不一样：格式错是要它改写法，
  // 截断是要它写短一点 —— 否则它会再写一遍同样长的东西，再被切一次。
  if (truncated) {
    lines.push('原因：你上一次的输出【被长度上限截断了】，JSON 还没写完就断了。');
    lines.push('这一次请把话压到一两句以内，并且先把 JSON 写完整（actions 和 endTurn 都要有）。');
    lines.push('');
  }

  if (previousText) {
    lines.push('你上次的原文：');
    lines.push(String(previousText).slice(0, 800));
    lines.push('');
  }

  if (errors && errors.length) {
    lines.push('解析时发现的问题：');
    for (const e of errors) lines.push(`- ${e}`);
    lines.push('');
  }

  if (rejectedAction) {
    lines.push('你提出的动作里，有一个被规则拒绝了：');
    lines.push(JSON.stringify(rejectedAction).slice(0, 400));
    lines.push('');
  }

  if (rejectReason) {
    lines.push('拒绝它的理由是：');
    lines.push(`- ${rejectReason}`);
    lines.push('');
    lines.push('你可以换一个合规动作，也可以明知代价地改用「破例动作」；');
    lines.push('但如果那确实做不到，就换别的。');
  }

  lines.push('请只输出修正后的 JSON 对象，不要任何额外文字。');
  return lines.join('\n');
}
