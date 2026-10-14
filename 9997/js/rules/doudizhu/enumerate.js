/**
 * enumerate.js — 从一手牌里枚举可行的出牌方案
 *
 * 这是把「斗地主」变成 LLM 能用的东西的桥梁：
 * LLM 自己不可能在 20 张牌里算出所有顺子和飞机，所以本地先枚举好，
 * 再连同胜率一起喂过去。本地枚举、本地校验，LLM 只负责挑。
 *
 * 枚举原则
 * ------------------------------------------------------------------
 * 1. 同点数的牌彼此等价，所以每个点数只取「最少张数」的那几张
 *    （出对子就取两张，不会把 C(4,2) 种组合全列一遍）。
 * 2. 翅膀（三带一、飞机带单）一律挑剩余牌里最小的，避免组合爆炸。
 * 3. 结果按「便宜优先」排序：先非炸弹、点数小、张数少。
 */

import {
  COMBO, MAX_CHAIN_RANK, beats, parseCombo,
} from './combo.js';

/** 按点数分组：rank → 该点数的所有牌（已按点数升序） */
export function byRank(cards) {
  const m = new Map();
  for (const c of cards || []) {
    if (!c) continue;
    if (!m.has(c.rank)) m.set(c.rank, []);
    m.get(c.rank).push(c);
  }
  return [...m.entries()]
    .map(([rank, list]) => ({ rank, list }))
    .sort((a, b) => a.rank - b.rank);
}

/** 连续点数的所有区间，长度在 [min, max] 之间，且都在 3..A 之内 */
function chainRanges(groups, minLen, maxLen, need) {
  const ok = groups.filter((g) => g.list.length >= need && g.rank >= 3 && g.rank <= MAX_CHAIN_RANK);
  const out = [];
  for (let i = 0; i < ok.length; i++) {
    for (let j = i + minLen - 1; j < ok.length && j - i + 1 <= maxLen; j++) {
      const run = ok.slice(i, j + 1);
      let consecutive = true;
      for (let k = 1; k < run.length; k++) {
        if (run[k].rank !== run[k - 1].rank + 1) {
          consecutive = false;
          break;
        }
      }
      if (!consecutive) break;
      out.push(run);
    }
  }
  return out;
}

/** 从若干点数里各取一张/两张/三张，拼成牌 id 列表 */
function takeFrom(ranks, groups, perRank, exclude = new Set()) {
  const ids = [];
  for (const r of ranks) {
    if (exclude.has(r)) continue;
    const g = groups.find((x) => x.rank === r);
    if (!g || g.list.length < perRank) return null;
    for (let i = 0; i < perRank; i++) ids.push(g.list[i].id);
  }
  return ids;
}

function desc(cardIds, cards) {
  const map = new Map((cards || []).map((c) => [c.id, c]));
  const picked = cardIds.map((id) => map.get(id)).filter(Boolean);
  const parsed = parseCombo(picked);
  if (!parsed.ok) return null;
  return { combo: parsed.combo, cardIds: [...cardIds] };
}

/** 排序：先非炸弹；再点数小；再张数少 */
function cheapFirst(a, b) {
  const ba = a.combo.type === COMBO.BOMB || a.combo.type === COMBO.ROCKET ? 1 : 0;
  const bb = b.combo.type === COMBO.BOMB || b.combo.type === COMBO.ROCKET ? 1 : 0;
  if (ba !== bb) return ba - bb;
  if (a.combo.rank !== b.combo.rank) return a.combo.rank - b.combo.rank;
  if (a.combo.size !== b.combo.size) return a.combo.size - b.combo.size;
  return String(a.combo.type).localeCompare(String(b.combo.type));
}

// ---------------------------------------------------------------------------
// 全量枚举（当前可以自由出牌时用）
// ---------------------------------------------------------------------------

export function enumerateAll(cards, { limit = 60 } = {}) {
  const groups = byRank(cards);
  const out = [];
  const push = (ids) => {
    if (!ids) return;
    const d = desc(ids, cards);
    if (d) out.push(d);
  };

  // 单张 / 对子 / 三张 / 炸弹
  for (const g of groups) {
    push([g.list[0].id]);
    if (g.list.length >= 2) push(g.list.slice(0, 2).map((c) => c.id));
    if (g.list.length >= 3) push(g.list.slice(0, 3).map((c) => c.id));
    if (g.list.length >= 4) push(g.list.slice(0, 4).map((c) => c.id));
  }

  // 王炸
  const small = groups.find((g) => g.rank === 16);
  const big = groups.find((g) => g.rank === 17);
  if (small && big) push([small.list[0].id, big.list[0].id]);

  // 三带一 / 三带二（翅膀取最小的若干点数）
  const tripleRanks = groups.filter((g) => g.list.length >= 3).map((g) => g.rank);
  const singleRanks = groups.map((g) => g.rank);
  const pairRanks = groups.filter((g) => g.list.length >= 2).map((g) => g.rank);
  for (const t of tripleRanks) {
    const body = takeFrom([t], groups, 3);
    for (const s of singleRanks) {
      if (s === t) continue;
      const w = takeFrom([s], groups, 1);
      if (w) push([...body, ...w]);
    }
    for (const p of pairRanks) {
      if (p === t) continue;
      const w = takeFrom([p], groups, 2);
      if (w) push([...body, ...w]);
    }
  }

  // 顺子（≥5）与连对（≥3 对）
  for (const run of chainRanges(groups, 5, 12, 1)) {
    push(takeFrom(run.map((g) => g.rank), groups, 1));
  }
  for (const run of chainRanges(groups, 3, 10, 2)) {
    push(takeFrom(run.map((g) => g.rank), groups, 2));
  }

  // 飞机（≥2 个连续三张）与飞机带翅膀
  for (const run of chainRanges(groups, 2, 6, 3)) {
    const runRanks = run.map((g) => g.rank);
    const body = takeFrom(runRanks, groups, 3);
    push(body);
    const k = runRanks.length;
    const used = new Set(runRanks);
    const wingSingles = singleRanks.filter((r) => !used.has(r)).slice(0, k);
    if (wingSingles.length === k) {
      const w = wingSingles.flatMap((r) => takeFrom([r], groups, 1) || []);
      if (w.length === k) push([...body, ...w]);
    }
    const wingPairs = pairRanks.filter((r) => !used.has(r)).slice(0, k);
    if (wingPairs.length === k) {
      const w = wingPairs.flatMap((r) => takeFrom([r], groups, 2) || []);
      if (w.length === k * 2) push([...body, ...w]);
    }
  }

  // 四带二 / 四带两对
  for (const g of groups.filter((x) => x.list.length >= 4)) {
    const body = g.list.slice(0, 4).map((c) => c.id);
    const others = singleRanks.filter((r) => r !== g.rank);
    const two = others.slice(0, 2).flatMap((r) => takeFrom([r], groups, 1) || []);
    if (two.length === 2) push([...body, ...two]);
    const twoPairs = pairRanks.filter((r) => r !== g.rank).slice(0, 2);
    const four = twoPairs.flatMap((r) => takeFrom([r], groups, 2) || []);
    if (four.length === 4) push([...body, ...four]);
  }

  // 去重（同牌型同点数同张数只留一份）+ 排序 + 截断
  const seen = new Set();
  const unique = [];
  for (const d of out) {
    const key = `${d.combo.type}|${d.combo.rank}|${d.combo.size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(d);
  }
  unique.sort(cheapFirst);
  return unique.slice(0, limit);
}

// ---------------------------------------------------------------------------
// 跟牌：只枚举能压过对方的那几手
// ---------------------------------------------------------------------------

export function enumerateBeating(cards, target, { limit = 40 } = {}) {
  if (!target) return enumerateAll(cards, { limit });
  const all = enumerateAll(cards, { limit: 400 });
  const ok = all.filter((d) => beats(d.combo, target));
  ok.sort(cheapFirst);
  return ok.slice(0, limit);
}

/** 手上有没有能压过对方的牌（一次也不出并不算错，但本地兜底需要知道） */
export function canBeat(cards, target) {
  if (!target) return cards.length > 0;
  return enumerateBeating(cards, target, { limit: 1 }).length > 0;
}
