/**
 * local-policy.js — 本地兜底策略（没有 API Key 时的「自动牌手」）
 *
 * 定位：当用户没有配置可用的 LLM 接口（或调用连续失败）时，
 * 由本地接管决策，保证牌局还能继续打下去，而不是全体沉默过牌。
 *
 * 铁律
 * ------------------------------------------------------------------
 * 本地兜底【只从合规动作里挑】，永远不碰破例动作。
 *   出自己手上的牌   → 合规，可以选
 *   抢别人的牌、多出一张 → 违规，本地绝不选
 * 「要不要破例」是留给 LLM 的判断，本地只负责把最优解算出来。
 *
 * 取值优先级
 * ------------------------------------------------------------------
 *   1. 胜率引擎给出的胜率（只对合规动作有意义）→ 取最大
 *   2. 规则包提供的 heuristic() 启发式
 *   3. 兜底：优先出牌，其余照单全收
 */

import { act, ADVANCING_ACTIONS, describeAction } from '../core/rules.js';

/** 判断配置里是否具备一次真实 LLM 调用所需的全部字段 */
export function hasLLMConfig(config) {
  return !!(config && config.apiKey && config.baseUrl && config.model);
}

/**
 * 从候选动作里挑一个「胜率最大的合规动作」。
 *
 * 一个容易踩的坑：候选里混着「亮牌」这种【不推进牌局】的动作。
 * 胜率引擎算它时，走的路径是「亮完牌之后照样由策略接着打」，
 * 所以它的胜率约等于「我最好的那一手」—— 数字很好看，但它一步都没走。
 * 本地兜底如果照数字最大的挑，就会一直亮牌，出牌权白白丢掉。
 * 因此取值池分两层：先只在【会推进牌局】的动作（出牌、过牌）里挑，
 * 实在没有别的可选，才退到亮牌这一类。
 *
 * @returns {{ action:object, source:string, winRate?:number|null, reason?:string }}
 */
export function chooseLocalDecision({
  state,
  playerId,
  ruleSet,
  candidates = [],
  winrates = null,
  opts = {},
}) {
  // 1) 只保留本地校验通过的合规动作
  //
  // 弃牌默认被剔掉：本地策略的任务是「把牌局打下去」，而多数玩法里
  // 弃牌 = 整局认输 —— 让它认输，牌局就没人打了。德州扑克是例外：
  // 弃牌是它的正常打法（拿着 7-2 一路跟到底才是错的），所以由规则包
  // 用 localPolicyAllowFold 显式打开，而不是在通用层按玩法名特判。
  const allowFoldLocally = !!ruleSet.localPolicyAllowFold;
  const legal = candidates.filter((a) => {
    if (!a) return false;
    if (a.type === 'fold' && !allowFoldLocally) return false;
    return ruleSet.validate(state, playerId, a, opts).ok;
  });

  const advancing = legal.filter((a) => ADVANCING_ACTIONS.has(a.type) || a.type === 'fold');
  const pool = advancing.length ? advancing : legal;

  if (!pool.length) {
    return { action: act.pass('没有可用的合规动作'), source: 'local-none', winRate: null };
  }

  // 2) 有胜率就以胜率为准（在取值池里取最大）
  if (Array.isArray(winrates) && winrates.length) {
    let best = null;
    let bestRate = -Infinity;
    pool.forEach((a) => {
      const i = candidates.indexOf(a);
      const w = i >= 0 ? winrates[i] : null;
      // rankValue 是引擎按【该玩法的正确度量】算出来的排序键：
      // 斗地主是赢面，21 点是期望分（双倍/分牌把注翻倍，赢面高不等于划算）。
      // 取不到时退回赢面。
      const rate = typeof w?.rankValue === 'number'
        ? w.rankValue
        : (typeof w?.winRate === 'number' ? w.winRate : null);
      if (rate === null) return;
      if (rate > bestRate) {
        bestRate = rate;
        best = a;
      }
    });
    if (best) {
      const bi = candidates.indexOf(best);
      const row = (bi >= 0 ? winrates[bi] : null) || {};
      const shown = typeof row.rankValue === 'number' && row.rankValue !== row.winRate
        ? `期望分 ${row.rankValue >= 0 ? '+' : ''}${row.rankValue.toFixed(2)}`
        : `胜率 ${((row.winRate ?? bestRate) * 100).toFixed(1)}%`;
      return {
        action: best,
        source: 'local-winrate',
        winRate: row.winRate ?? bestRate,
        reason: `本地引擎推荐：${describeAction(best)}（${shown}）`,
      };
    }
  }

  // 3) 规则包启发式
  if (typeof ruleSet.heuristic === 'function') {
    const h = ruleSet.heuristic(state, playerId, pool);
    if (h) {
      return { action: h, source: 'local-heuristic', winRate: null, reason: describeAction(h) };
    }
  }

  // 4) 兜底：优先出牌；出不了就过牌；最后才退到其它动作。
  //    顺序不能反 —— 「亮牌」这类动作不推进牌局，若被选成兜底动作，
  //    智能体会一直在原地亮牌，整个牌局再也走不动。
  const first =
    pool.find((a) => a.type === 'play') ||
    pool.find((a) => a.type === 'pass') ||
    legal.find((a) => a.type === 'pass') ||
    pool[0];
  return { action: first, source: 'local-first', winRate: null, reason: describeAction(first) };
}
