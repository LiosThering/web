/**
 * fast.js — 斗地主的「快路径」：点数计数上的牌型识别、比较、出牌生成
 *
 * 为什么需要它
 * ------------------------------------------------------------------
 * combo.js / enumerate.js 面对的是【牌对象】和【人类可读的标签】，
 * 每次调用都要分组、排序、拼字符串。对「一次决策」来说这点开销无所谓，
 * 但胜率引擎要在几百次模拟里反复问「这手牌现在能出什么」，
 * 那份开销会直接把采样数压到个位数，胜率就没意义了。
 *
 * 所以这里用一副点数计数表（cnt[3..17]）重写同一套规则：
 *   - 识别：classifyCounts   ≡  parseCombo
 *   - 比较：beatsCode        ≡  beats
 *   - 生成：beatingMoves / decompose
 * 三者的语义【必须】和 combo.js 完全一致，否则模拟出来的胜率是另一套
 * 游戏的胜率。这条一致性由 tools/smoke-winrate.mjs 用穷举/随机对照验证，
 * 不靠人眼审查。
 *
 * 计数表约定
 * ------------------------------------------------------------------
 *   Uint8Array(18)，索引就是点数：3..14 = 3..A，15 = 2，16 = 小王，17 = 大王。
 *   索引 0..2 空着不用，为的是「下标即点数」，读写都不必换算。
 *
 * 牌型编码
 * ------------------------------------------------------------------
 *   { t, r, n }   t = 牌型（复用 combo.js 的 COMBO 常量）
 *                 r = 主点数（比大小只看它）
 *                 n = 张数（beats 要求同型同张数）
 *   需要真正打出去的牌时，另带 ranks: [点数…]（可重复，重复几次就是几张）。
 */

import { COMBO, MAX_CHAIN_RANK } from './combo.js';

export const MIN_RANK = 3;
export const MAX_RANK = 17;

/** 牌数组 → 计数表 */
export function toCounts(cards) {
  const cnt = new Uint8Array(18);
  for (const c of cards || []) {
    if (c && c.rank >= MIN_RANK && c.rank <= MAX_RANK) cnt[c.rank]++;
  }
  return cnt;
}

export function totalOf(cnt) {
  let s = 0;
  for (let r = MIN_RANK; r <= MAX_RANK; r++) s += cnt[r];
  return s;
}

export function cloneCounts(cnt) {
  return Uint8Array.from(cnt);
}

/** 计数表 → 点数数组（升序，重复点数重复出现） */
export function ranksOf(cnt) {
  const out = [];
  for (let r = MIN_RANK; r <= MAX_RANK; r++) for (let i = 0; i < cnt[r]; i++) out.push(r);
  return out;
}

/** 连续段：ranks 已是升序且不重复时，返回 top（且 top ≤ A），否则返回 0 */
function runTop(ranks) {
  if (ranks.length < 2) return ranks.length === 1 ? (ranks[0] <= MAX_CHAIN_RANK ? ranks[0] : 0) : 0;
  for (let i = 1; i < ranks.length; i++) {
    if (ranks[i] !== ranks[i - 1] + 1) return 0;
  }
  const top = ranks[ranks.length - 1];
  return top <= MAX_CHAIN_RANK ? top : 0;
}

// ---------------------------------------------------------------------------
// 识别：classifyCounts ≡ parseCombo
// ---------------------------------------------------------------------------

/**
 * 把一整手牌（计数表）识别成一个牌型。
 * 判定顺序与 parseCombo 逐条对齐 —— 顺序错了会给出不同的牌型，
 * 而牌型不同直接导致「能不能压过」的结论不同。
 *
 * @returns {{ok:true,t:number,r:number,n:number}|{ok:false,reason:string}}
 */
export function classifyCounts(cnt) {
  const n = totalOf(cnt);
  if (!n) return { ok: false, reason: '没有牌' };

  const g = [];
  for (let r = MIN_RANK; r <= MAX_RANK; r++) if (cnt[r]) g.push({ r, n: cnt[r] });
  const mk = (t, r) => ({ ok: true, t, r, n });

  if (n === 2 && g.length === 2 && g[0].r === 16 && g[1].r === 17) return mk(COMBO.ROCKET, 17);
  if (n === 1) return mk(COMBO.SINGLE, g[0].r);
  if (n === 2 && g.length === 1) return mk(COMBO.PAIR, g[0].r);
  if (n === 3 && g.length === 1) return mk(COMBO.TRIPLE, g[0].r);
  if (n === 4 && g.length === 1) return mk(COMBO.BOMB, g[0].r);

  if (n === 4 && g.length === 2) {
    const t = g.find((x) => x.n === 3);
    const o = g.find((x) => x.n === 1);
    if (t && o) return mk(COMBO.TRIPLE_ONE, t.r);
  }
  if (n === 5 && g.length === 2) {
    const t = g.find((x) => x.n === 3);
    const p = g.find((x) => x.n === 2);
    if (t && p) return mk(COMBO.TRIPLE_PAIR, t.r);
  }

  if (n >= 5 && g.every((x) => x.n === 1)) {
    const top = runTop(g.map((x) => x.r));
    if (top) return mk(COMBO.STRAIGHT, top);
  }
  if (n >= 6 && n % 2 === 0 && g.every((x) => x.n === 2)) {
    const top = runTop(g.map((x) => x.r));
    if (top) return mk(COMBO.STRAIGHT_PAIR, top);
  }
  if (n >= 6 && n % 3 === 0 && g.every((x) => x.n === 3)) {
    const top = runTop(g.map((x) => x.r));
    if (top) return mk(COMBO.PLANE, top);
  }

  // 飞机带翅膀：先找「三张及以上」点数里的连续段，再验剩下的牌是不是等量翅膀
  const tri = g.filter((x) => x.n >= 3).map((x) => x.r);
  for (let k = tri.length; k >= 2; k--) {
    for (let s = 0; s + k <= tri.length; s++) {
      const run = tri.slice(s, s + k);
      const top = runTop(run);
      if (!top) continue;
      const work = cloneCounts(cnt);
      for (const r of run) work[r] -= 3;
      let restN = 0;
      let restGroups = 0;
      let allOne = true;
      let allTwo = true;
      for (let r = MIN_RANK; r <= MAX_RANK; r++) {
        if (!work[r]) continue;
        restN += work[r];
        restGroups++;
        if (work[r] !== 1) allOne = false;
        if (work[r] !== 2) allTwo = false;
      }
      if (restN === k && restGroups === k && allOne) return mk(COMBO.PLANE_SINGLE, top);
      if (restN === k * 2 && restGroups === k && allTwo) return mk(COMBO.PLANE_PAIR, top);
    }
  }

  const four = g.find((x) => x.n === 4);
  if (four) {
    const others = g.filter((x) => x.r !== four.r);
    if (n === 6 && n - 4 === 2) return mk(COMBO.FOUR_TWO, four.r);
    if (n === 8 && others.length === 2 && others.every((x) => x.n === 2)) {
      return mk(COMBO.FOUR_TWO_PAIR, four.r);
    }
  }

  return { ok: false, reason: '这组牌不构成任何合法牌型' };
}

// ---------------------------------------------------------------------------
// 比较：beatsCode ≡ beats
// ---------------------------------------------------------------------------

export function isBombCode(m) {
  return !!m && (m.t === COMBO.BOMB || m.t === COMBO.ROCKET);
}

/** a 能不能压过 b（b 为 null 表示 a 是这一手的第一家） */
export function beatsCode(a, b) {
  if (!a) return false;
  if (!b) return true;

  if (a.t === COMBO.ROCKET) return b.t !== COMBO.ROCKET;
  if (b.t === COMBO.ROCKET) return false;

  if (a.t === COMBO.BOMB && b.t === COMBO.BOMB) return a.r > b.r;
  if (a.t === COMBO.BOMB) return true;
  if (b.t === COMBO.BOMB) return false;

  if (a.t !== b.t) return false;
  if (a.n !== b.n) return false;
  return a.r > b.r;
}

/** 把外部（enumerate.js / 规则包）产出的 combo 对象转成快路径编码 */
export function codeOf(combo) {
  if (!combo) return null;
  return { t: combo.type, r: combo.rank, n: combo.size };
}

// ---------------------------------------------------------------------------
// 带牌（翅膀）的选择
// ---------------------------------------------------------------------------

/**
 * 挑 k 组翅膀，每组 per 张。挑法遵循「越不心疼越先出」：
 *   散牌 → 对子里的一张 → 三张里的一张 → 王 → 拆炸弹（最后手段）
 * 返回点数数组（长度 k），挑不齐就返回 null。
 */
function pickWings(cnt, used, k, per) {
  const cand = [];
  for (let r = MIN_RANK; r <= MAX_RANK; r++) {
    if (used.has(r)) continue;
    const n = cnt[r];
    if (n < per) continue;
    let cost;
    if (n === 4) cost = 400;                    // 拆炸弹
    else if (per === 1) cost = n === 1 ? 0 : n === 2 ? 30 : 60;
    else cost = n === 2 ? 0 : 30;
    if (r >= 16) cost += 200;                   // 王太贵
    else if (r >= 15) cost += 80;               // 2 也贵
    cand.push({ r, cost });
  }
  if (cand.length < k) return null;
  cand.sort((a, b) => a.cost - b.cost || a.r - b.r);
  return cand.slice(0, k).map((x) => x.r);
}

// ---------------------------------------------------------------------------
// 跟牌生成：只生成「能压过这一手」的走法
// ---------------------------------------------------------------------------

/**
 * @param cnt    我的手牌计数表
 * @param target 台面上要压过的一手 { t, r, n }
 * @returns {Array<{t,r,n,ranks:number[]}>} 按「便宜优先」排序，炸弹与王炸排在最后
 */
export function beatingMoves(cnt, target) {
  const out = [];
  if (!target) return out;
  if (target.t === COMBO.ROCKET) return out; // 王炸压不过

  const body = (t, r, n, ranks) => out.push({ t, r, n, ranks });
  const has = (r, k) => r >= MIN_RANK && r <= MAX_RANK && cnt[r] >= k;

  if (target.t === COMBO.BOMB) {
    for (let r = target.r + 1; r <= 17; r++) if (has(r, 4)) body(COMBO.BOMB, r, 4, [r, r, r, r]);
    if (cnt[16] && cnt[17]) body(COMBO.ROCKET, 17, 2, [16, 17]);
    return out;
  }

  const T = target.t;
  const R = target.r;
  const N = target.n;

  switch (T) {
    case COMBO.SINGLE:
      for (let r = R + 1; r <= 17; r++) if (has(r, 1)) body(T, r, 1, [r]);
      break;

    case COMBO.PAIR:
      for (let r = R + 1; r <= 15; r++) if (has(r, 2)) body(T, r, 2, [r, r]);
      break;

    case COMBO.TRIPLE:
      for (let r = R + 1; r <= 15; r++) if (has(r, 3)) body(T, r, 3, [r, r, r]);
      break;

    case COMBO.TRIPLE_ONE:
    case COMBO.TRIPLE_PAIR: {
      const per = T === COMBO.TRIPLE_ONE ? 1 : 2;
      for (let r = R + 1; r <= 15; r++) {
        if (!has(r, 3)) continue;
        const used = new Set([r]);
        const w = pickWings(cnt, used, 1, per);
        if (!w) continue;
        const ranks = [r, r, r];
        for (const x of w) for (let i = 0; i < per; i++) ranks.push(x);
        body(T, r, 3 + per, ranks);
      }
      break;
    }

    case COMBO.STRAIGHT: {
      for (let top = R + 1; top <= MAX_CHAIN_RANK; top++) {
        const start = top - N + 1;
        if (start < MIN_RANK) continue;
        let ok = true;
        for (let r = start; r <= top; r++) if (!cnt[r]) { ok = false; break; }
        if (!ok) continue;
        const ranks = [];
        for (let r = start; r <= top; r++) ranks.push(r);
        body(T, top, N, ranks);
      }
      break;
    }

    case COMBO.STRAIGHT_PAIR: {
      const len = N / 2;
      if (!Number.isInteger(len)) break;
      for (let top = R + 1; top <= MAX_CHAIN_RANK; top++) {
        const start = top - len + 1;
        if (start < MIN_RANK) continue;
        let ok = true;
        for (let r = start; r <= top; r++) if (cnt[r] < 2) { ok = false; break; }
        if (!ok) continue;
        const ranks = [];
        for (let r = start; r <= top; r++) ranks.push(r, r);
        body(T, top, N, ranks);
      }
      break;
    }

    case COMBO.PLANE:
    case COMBO.PLANE_SINGLE:
    case COMBO.PLANE_PAIR: {
      const per = T === COMBO.PLANE ? 0 : T === COMBO.PLANE_SINGLE ? 1 : 2;
      const k = N / (3 + per);
      if (!Number.isInteger(k) || k < 2) break;
      for (let top = R + 1; top <= MAX_CHAIN_RANK; top++) {
        const start = top - k + 1;
        if (start < MIN_RANK) continue;
        let ok = true;
        for (let r = start; r <= top; r++) if (cnt[r] < 3) { ok = false; break; }
        if (!ok) continue;
        const ranks = [];
        const used = new Set();
        for (let r = start; r <= top; r++) {
          used.add(r);
          ranks.push(r, r, r);
        }
        if (per === 0) {
          body(T, top, N, ranks);
          continue;
        }
        const w = pickWings(cnt, used, k, per);
        if (!w) continue;
        for (const x of w) for (let i = 0; i < per; i++) ranks.push(x);
        body(T, top, N, ranks);
      }
      break;
    }

    case COMBO.FOUR_TWO:
    case COMBO.FOUR_TWO_PAIR: {
      const per = T === COMBO.FOUR_TWO ? 1 : 2;
      for (let r = R + 1; r <= 15; r++) {
        if (!has(r, 4)) continue;
        const used = new Set([r]);
        const w = pickWings(cnt, used, 2, per);
        if (!w) continue;
        const ranks = [r, r, r, r];
        for (const x of w) for (let i = 0; i < per; i++) ranks.push(x);
        body(T, r, 4 + per * 2, ranks);
      }
      break;
    }

    default:
      break;
  }

  // 炸弹与王炸永远可以跟
  for (let r = MIN_RANK; r <= MAX_RANK; r++) {
    if (cnt[r] >= 4) body(COMBO.BOMB, r, 4, [r, r, r, r]);
  }
  if (cnt[16] && cnt[17]) body(COMBO.ROCKET, 17, 2, [16, 17]);

  // 去重（同型同主点同张数只留一份：翅膀选法不同但价值等价）
  const seen = new Set();
  const uniq = [];
  for (const m of out) {
    const key = `${m.t}|${m.r}|${m.n}`;
    if (seen.has(key)) continue;
    seen.add(key);
    uniq.push(m);
  }

  // 便宜优先：先非炸弹（点数小优先），炸弹按点数，王炸最后
  uniq.sort((a, b) => {
    const ba = isBombCode(a) ? 1 : 0;
    const bb = isBombCode(b) ? 1 : 0;
    if (ba !== bb) return ba - bb;
    return a.r - b.r;
  });
  return uniq;
}

// ---------------------------------------------------------------------------
// 手牌分解：这一手牌「最少还要出几次」的估计
// ---------------------------------------------------------------------------

/**
 * 把手牌贪婪拆成若干「组」，组的数量就是「还要出几手」的估计值。
 * 它是个启发式上界（真正的最少手数是 NP 的），但足够稳定：
 * 胜率引擎用它判断「这一手出完之后，我离走完是近了还是远了」。
 *
 * 抽取顺序：王炸 → 炸弹 → 飞机 → 连对 → 顺子 → 三张 → 对子 → 单张。
 * 顺序不是随手定的：连对必须早于顺子，否则 334455667788 会被拆成
 * 一条顺子加一堆散牌（7 手），而真相是 3 个连对（3 手）。
 *
 * @returns {Array<{t,r,n,ranks:number[]}>}
 */
export function decompose(cnt) {
  const work = cloneCounts(cnt);
  const groups = [];
  const take = (t, r, n, ranks) => {
    for (const x of ranks) work[x]--;
    groups.push({ t, r, n, ranks: [...ranks] });
  };

  if (work[16] && work[17]) take(COMBO.ROCKET, 17, 2, [16, 17]);

  for (let r = MIN_RANK; r <= 15; r++) {
    if (work[r] === 4) take(COMBO.BOMB, r, 4, [r, r, r, r]);
  }

  // 飞机：连续三张 ≥2 组
  for (;;) {
    const run = longestRun(work, MIN_RANK, MAX_CHAIN_RANK, 3, Infinity);
    if (!run || run.length < 2) break;
    const ranks = [];
    for (const r of run) ranks.push(r, r, r);
    take(COMBO.PLANE, run[run.length - 1], run.length * 3, ranks);
  }

  // 连对：每个点数至少两张；允许从三张里抽两张（留一张）
  //
  // 上界为什么是 3 而不是 2
  // ------------------------------------------------------------------
  // 原本卡在 2（「只吃正好两张的点数，别拆三张」），代价是整条连对被掐断：
  // 手上 333 44 55 明明能出 334455 一手走完，却因为 3 有三张而一条都抽不出来，
  // 只好拆成 333 + 44 + 55 三手。实测（tools/minhands-audit.mjs 的定点牌例）
  // 这类高估能到 2~4 手，而「还要几手走完」正是 smart 策略的打分主项。
  // 上界留在 3 是有意的：**不碰炸弹**（4 张同点）。炸弹的价值不在点数，
  // 而在「压得住任何牌」，拆去凑顺子是亏的 —— 审计里也看得见，精确解会拆炸弹，
  // 但那是「纸面最少手数」，不是「好打法」。
  for (;;) {
    const run = longestRun(work, MIN_RANK, MAX_CHAIN_RANK, 2, 3);
    if (!run || run.length < 3) break;
    const ranks = [];
    for (const r of run) ranks.push(r, r);
    take(COMBO.STRAIGHT_PAIR, run[run.length - 1], run.length * 2, ranks);
  }

  // 顺子：每个点数至少一张，同样允许从三张里抽一张（理由同上）
  for (;;) {
    const run = longestRun(work, MIN_RANK, MAX_CHAIN_RANK, 1, 3);
    if (!run || run.length < 5) break;
    take(COMBO.STRAIGHT, run[run.length - 1], run.length, run);
  }

  for (let r = MIN_RANK; r <= 15; r++) {
    if (work[r] === 3) take(COMBO.TRIPLE, r, 3, [r, r, r]);
  }
  for (let r = MIN_RANK; r <= 15; r++) {
    if (work[r] === 2) take(COMBO.PAIR, r, 2, [r, r]);
  }
  for (let r = MIN_RANK; r <= MAX_RANK; r++) {
    while (work[r] > 0) take(COMBO.SINGLE, r, 1, [r]);
  }
  return groups;
}

/** [lo,hi] 里最长的连续段：每点至少 need 张，且不超过 maxCnt 张（Infinity 表示不限） */
function longestRun(work, lo, hi, need, maxCnt) {
  let best = null;
  let cur = null;
  for (let r = lo; r <= hi; r++) {
    const ok = work[r] >= need && work[r] <= maxCnt;
    if (ok) {
      if (!cur) cur = [];
      cur.push(r);
    } else if (cur) {
      if (!best || cur.length > best.length) best = cur;
      cur = null;
    }
  }
  if (cur && (!best || cur.length > best.length)) best = cur;
  return best;
}

/** 「还要几手走完」的估计 */
export function minHands(cnt) {
  return decompose(cnt).length;
}

/**
 * 控制牌数量：2、小王、大王、炸弹。
 * 这些牌的价值不在点数大小，而在「压得住场面」，
 * 用来衡量「手里还剩几张能收回出牌权的牌」。
 */
export function controlCount(cnt) {
  let s = cnt[15] + cnt[16] + cnt[17];
  for (let r = MIN_RANK; r <= 14; r++) if (cnt[r] === 4) s += 1;
  return s;
}
