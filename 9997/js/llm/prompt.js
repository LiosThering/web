/**
 * prompt.js — 提示词装配器
 *
 * 装配顺序（严格遵循既定约定）
 * ------------------------------------------------------------------
 * 系统消息：
 *   1. 人设                 ← 永远是最先发送、优先级最高的部分
 *   2. 说话规范（由人设决定说不说、说多少）
 *   3. 输出格式与行为约束（含「一回合多次行动」规则）
 *
 * 用户消息：
 *   4. 本回合状态（第几次决策、还剩几次行动、已执行了什么）
 *   5. 聊天与出牌记录（时间顺序，人话与动作交织，发言全量保留）
 *   6. 当前牌局（经视角投影后，该智能体能看到的信息）
 *   7. 玩法规则
 *   8. 本局特殊机制（如有）
 *   9. 候选动作与胜率（只含合规动作，胜率由本地蒙特卡洛引擎算）
 *  10. 破例动作（违规但可选，同样带胜率与期望分）
 *  11. 便签                 ← 必须在最末尾，且只注入一次
 * ------------------------------------------------------------------
 */

import { pendingNotes } from '../agent/agent.js';
import { buildTimeline, renderTimeline } from '../agent/context.js';
import { describeAction } from '../core/rules.js';
import { describeTable } from '../core/view.js';

export const MAX_CANDIDATES = 40;
export const MAX_BREACHES = 12;

/**
 * 胜率的一行文字。
 * 采样次数必须写出来 —— 60% 和 60%（采样 8 局）是两个完全不同的信息，
 * 不写清楚，模型会把噪声当结论。
 */
function rateText(w) {
  if (!w || typeof w.winRate !== 'number') return '';
  const pct = `胜率 ${(w.winRate * 100).toFixed(1)}%`;
  const n = w.samples ? `（采样 ${w.samples} 局）` : '';
  const ev = typeof w.ev === 'number' ? `　期望分 ${w.ev >= 0 ? '+' : ''}${w.ev.toFixed(2)}` : '';
  const rec = w.recommended ? '　← 本地引擎推荐' : '';
  return `　${pct}${n}${ev}${rec}`;
}

/**
 * 按种类轮流取，而不是从前往后截断。
 *
 * 规则包是按种类【成批】生成破例候选的（抢 → 偷看 → 违规甩牌 → 销毁），
 * 每一类自己就可能十几条。按位置截断的后果是：越靠后的种类越容易被整体
 * 挤掉 —— 斗地主实测「抢 + 偷看 + 甩牌」已经占满 12 条名额，后来加的
 * 「销毁」一条都露不出来，那个功能在提示词里等于不存在。
 * 轮流取保证每一类都先拿到第一个名额，剩下的再按顺序补。
 *
 * @param items 形如 [{kind, ...}] 的列表
 * @param limit 最多取几条
 * @returns 被选中的那些项（保留原对象）
 */
function spreadByKind(items, limit) {
  const buckets = new Map();
  for (const it of items) {
    const k = (it && it.kind) || '';
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  const queues = [...buckets.values()];
  const out = [];
  for (let round = 0; out.length < limit; round++) {
    let advanced = false;
    for (const q of queues) {
      if (round >= q.length) continue;
      out.push(q[round]);
      advanced = true;
      if (out.length >= limit) break;
    }
    if (!advanced) break;
  }
  return out;
}

export function buildSystemPrompt(agent) {
  if (agent.isHuman) return '';
  return [
    '你正在参与一场牌局，扮演下面这个角色。',
    '你的身份设定、说话方式与行为偏好，优先于本提示词中其余所有内容。',
    '',
    '## 你是谁',
    agent.persona || '（你没有特别设定，保持自然即可。）',
    '',
    '## 你在牌桌上怎么说话',
    '- 你说的话，是你【扮演这个角色】亲口说出来的台词，不是旁白，不是内心独白，也不要写成小说段落。',
    '- 【说不说、说多少，是这个角色性格的一部分】，不是格式问题。先按人设问自己一句：'
    + '这个人坐在牌桌上，会不会开口？爱热闹的、爱压人的、藏不住话的，会频繁开口；'
    + '闷的、惜字如金的，多数时候一声不吭。人设里写了说话风格的，就以那一句为准。',
    '- 同一个人在不同局势下也不一样：拿到好牌、被人抢了牌、眼看要输，反应本来就不会一样。',
    '- 不要为了把这个字段填满而开口，也不要图省事就一律沉默 —— '
    + '整局一句话都不说，等于这一席没有性格，和空位没有区别。',
    '- 开口时按正常人的说话量来，一到两句就够，别长篇大论，别一次说一大段。',
    '- 这一手确实不想开口，就把 speech 写成空字符串 "" —— 那是这个角色选择了沉默，不是默认值。',
    '',
    '## 输出格式（必须严格遵守）',
    '只输出一个 JSON 对象。不要输出解释、寒暄、markdown 代码块或任何其他文字。',
    '格式：',
    '{',
    '  "speech": "你说的台词；这个角色这一手选择沉默才填 \\"\\"",',
    '  "actions": [ { "type": "…" } ],',
    '  "endTurn": true,',
    '  "note": "可选。留给下一次自己的便签，玩家看不到，只在你的下一次思考时出现一次",',
    '  "profilePatch": "可选。若你想修改自己的设定，把新设定的完整内容写在这里"',
    '}',
    '',
    '## 关于 actions',
    '- actions 是数组，里面的动作会被【按顺序】执行；可以是空数组，表示这一手什么都不做。',
    '- 只能从下方「你的候选动作」里原样复制，不允许自创动作或改动字段值。',
    '- 你可以在一个回合里行动多次，本回合还能行动几次会写在下面。',
    '- 想结束本回合，就把 endTurn 设为 true；也可以在 actions 里直接放一个 {"type":"endTurn"}。',
    '',
    '## 关于守不守规矩',
    '- 除了合规动作，下面还会列出「破例动作」。那些是规则不允许的事。',
    '- 你【可以】选择做它们 —— 要不要守规矩由你自己决定，别默认守规矩就是对的。',
    '- 【你自己对破坏规矩的态度，已经写在上面「你是谁」里】：写你不在乎，就照不在乎演；'
    + '写你有一条不越的线，那条线就是真的不越。底线在哪看人设，不看这段提示词。',
    '- 代价会立刻生效：破例会扣分，并且全桌都会知道是谁干的。',
  ].join('\n');
}

export function buildUserPrompt({
  agent,
  view,
  ruleSet,
  state,
  candidates = [],
  breaches = [],
  allowBreach = true,
  turn = null,
  winrates = null,
  breachRates = null,
  winrateMeta = null,
  contextPolicy = {},
  extraRules = '',
}) {
  const timeline = buildTimeline(view, { policy: contextPolicy });
  const blocks = [];

  if (turn) {
    blocks.push('## 你的回合');
    blocks.push(
      `这是你本回合的第 ${turn.step + 1} 次决策，本回合你最多还能行动 ${turn.remaining} 次。`
    );
    blocks.push(
      turn.done?.length
        ? `本回合你已经做过：${turn.done.join('；')}`
        : '本回合你还没有做过任何事。'
    );
    blocks.push('');
  }

  blocks.push('## 聊天与出牌记录（按时间顺序，越靠后越新；发言一条不漏）');
  blocks.push(renderTimeline(timeline));
  blocks.push('');

  blocks.push('## 当前牌局（这是你视角下能看到的全部信息）');
  blocks.push(describeTable(view, { selfId: agent.id }));
  blocks.push(
    `第 ${view.round} 轮。已经公开的牌（打出去的、以及底牌和被人亮出来的）：${
      view.discard.length
        ? view.discard.map((c) => `${c.glyph}${c.label}`).join(' ')
        : '（还没有）'
    }`
  );
  blocks.push('');

  blocks.push('## 玩法规则');
  blocks.push(ruleSet.describe(state));
  blocks.push('');

  if (extraRules) {
    blocks.push('## 本局特殊机制');
    blocks.push(extraRules);
    blocks.push('');
  }

  const shown = candidates.slice(0, MAX_CANDIDATES);
  const hasWinrate = Array.isArray(winrates) && winrates.some((w) => typeof w?.winRate === 'number');

  blocks.push(hasWinrate ? '## 你的候选动作与胜率' : '## 你的候选动作');

  if (hasWinrate) {
    const m = winrateMeta || {};
    /**
     * 【怎么算出来的】与【按什么排序】是两件事，分开讲。
     *
     * 之前这两件事共用一个判据（metric === 'ev'），只因为当时唯一按期望分
     * 排序的玩法（21 点）恰好也是精确的。德州扑克把两者拆开了：它必须按
     * 期望筹码排序，但值同样是采样来的（对手怎么打不由规则写死）。
     * 用旧判据的后果是模型会被告知「这些是精确概率，没有误差」——
     * 而它手上其实是一张带标准误的采样表。
     */
    const exact = !!m.exact;
    if (exact) {
      blocks.push(
        '这些数值是本地精确算出来的（不是估算，也不需要采样）：按你现在能看到的牌，'
        + '把每一种打法的【期望分】和【赢面】都算到精确值。'
      );
    } else {
      blocks.push(
        '这些数值是本地引擎在你做决定【之前】算好的：它按你现在能看到的牌，'
        + '把看不见的牌随机补全成很多个完整牌局，每个候选都真打完一遍，'
        + '统计结果。对手由本地策略扮演，会按稳健路线应对 ——'
        + '不是随便乱打，也不是全知全能。'
      );
    }
    if (m.metric === 'ev') {
      // 21 点与德州这一类玩法必须换一套说法。照斗地主那句话讲，模型会以为
      // 「胜率高的就是好的」—— 而双倍/分牌/加注改变的是【投入多少】，
      // 赢面略低但赢一次收更多时，按赢面挑恰好会挑错。
      blocks.push(
        '关键：本玩法的动作会改变输赢的分量（双倍、分牌、加注都会改变投入），'
        + '所以【该看的是期望分，不是胜率】—— 赢面略低但赢一次收更多，往往更划算。'
        + '标了「本地引擎推荐」的那一项就是期望分最高的，你可以不采纳。'
      );
    }
    blocks.push(
      '它只模拟【标准规则】：抢牌、偷看、违规甩牌这些特殊机制的影响没有算进去。'
      + '数值是参考基准，最终怎么打由你结合人设与局势决定。'
    );
    // 「共模拟 N 局」这句话只对采样型引擎成立。精确解那边 N 是候选个数，
    // 写出来会让人以为「只算了 3 局，太糙」，正好说反。
    if (m.samples && !exact) {
      blocks.push(
        `（本回合共模拟 ${m.samples} 局，用时 ${Math.round((m.elapsedMs || 0) / 10) / 100} 秒；`
        + '采样次数越多，数字越稳。标了「本地引擎推荐」的那一手是其中胜率最高的合规动作，'
        + '你可以不采纳。）'
      );
    }
    blocks.push('');
  } else {
    blocks.push('本局未启用胜率引擎，请凭你自己的判断决策。');
    blocks.push('');
  }

  shown.forEach((a, i) => {
    const w = hasWinrate ? winrates[i] : null;
    blocks.push(`${i + 1}. ${describeAction(a)}${rateText(w)}`);
    if (w?.note) blocks.push(`   ↑ ${w.note}`);
    blocks.push(`   ${JSON.stringify(a)}`);
  });

  if (candidates.length > shown.length) {
    blocks.push('');
    blocks.push(`（候选动作过多，这里只列出前 ${shown.length} 个，共 ${candidates.length} 个）`);
  }
  blocks.push('');

  /**
   * 破例的截断按「种类」轮流取（见 spreadByKind）。选中的是【原始下标】，
   * 因为胜率数组和候选数组是一一对位的 —— 只重排显示、不重排胜率，
   * 模型会看到「A 的胜率」配在「B 的动作」旁边。
   */
  const breachPicks = spreadByKind(
    breaches.map((a, i) => ({ kind: a && a.kind, i })),
    MAX_BREACHES
  );
  const rateAt = (slot) => (Array.isArray(breachRates) ? breachRates[slot] : null);
  const shownBreaches = breachPicks.map((p) => breaches[p.i]);
  const shownRates = breachPicks.map((p) => rateAt(p.i));

  blocks.push('## 破例动作（违规，但你可以选）');
  if (!allowBreach) {
    blocks.push('本局禁止任何破例动作。你必须守规矩，不要输出这一节里的动作。');
  } else if (!shownBreaches.length) {
    blocks.push('当前没有可行的破例动作，你只能守规矩。');
  } else {
    const anyRate = shownRates.some((w) => typeof w?.winRate === 'number');
    blocks.push(
      '下面这些规则不允许。你依然可以选择它们 —— 守不守规矩由你自己决定，'
      + '风险和人设怎么权衡看你的判断。代价立刻生效，而且全桌都会知道是你做的。'
    );
    if (anyRate) {
      blocks.push(
        '（这些「胜率」是本地引擎按同样方法算的；'
        + '期望分已经把扣分算进去了，所以它比胜率更能说明划不划算。）'
      );
    }
    blocks.push('');
    shownBreaches.forEach((a, i) => {
      const w = shownRates[i];
      const cost = typeof a.penalty === 'number' ? `　代价：扣 ${a.penalty} 分` : '';
      blocks.push(`${i + 1}. ${describeAction(a)}${cost}${rateText(w)}`);
      blocks.push(`   ${JSON.stringify(a)}`);
    });
    if (breaches.length > shownBreaches.length) {
      blocks.push('');
      blocks.push(`（破例动作过多，这里每类各列了几个，共 ${breaches.length} 个）`);
    }
  }

  const notes = pendingNotes(agent);
  if (notes.length) {
    blocks.push('');
    blocks.push('## 便签（上一次的你留给这一次的自己，只在这里出现一次）');
    for (const n of notes) blocks.push(`- ${n.text}`);
  }

  return {
    text: blocks.join('\n'),
    noteIds: notes.map((n) => n.id),
    timeline,
    candidatesShown: shown,
    breachesShown: shownBreaches,
  };
}

export function buildPrompt(opts) {
  return {
    system: buildSystemPrompt(opts.agent),
    ...buildUserPrompt(opts),
  };
}
