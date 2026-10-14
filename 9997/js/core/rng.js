/**
 * rng.js — 可复现随机数
 *
 * 为什么不用 Math.random()
 * ------------------------------------------------------------------
 * 牌局必须可复现：给定同一个 seed，发牌与后续所有「随机」结果完全一致。
 * 这样 LLM 的错误输出才能在本地重放，也才能做训练数据回溯。
 * 所以内部一律走确定性 PRNG，随机性只由「种子从哪来」这一个点决定。
 *
 * 三层分工：
 *   randomSeed()   —— 种子来源之一：用 crypto 取真熵，不可预测（默认）
 *   seedFromTime() —— 种子来源之一：本机时间戳低位，可读、可按时辰复现
 *   hashSeed()     —— 把任意文字变成种子，让「同一句话=同一局牌」
 *   resolveSeed()  —— 按「输入框优先、其次来源下拉框」的规则定下本局种子
 *   makeRng()      —— 确定性 PRNG，给定种子产出可复现的随机流
 */

/** mulberry32 —— 小而快的 32 位 PRNG，状态就是那 32 位 */
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function next() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 取一个新的种子。
 *
 * 用 crypto.getRandomValues 而不是 Date.now()：
 * 时间戳的取值空间只有几万且周期极短，对手一眼就能猜出这一局发的是什么牌。
 * 这里给的是 32 位无符号整数，空间 2^32 ≈ 43 亿。
 */
export function randomSeed() {
  const g = globalThis.crypto;
  if (g && typeof g.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    g.getRandomValues(buf);
    return buf[0] >>> 0;
  }
  // 老浏览器兜底：仍然比时间戳好，至少带小数位
  return Math.floor(Math.random() * 4294967296) >>> 0;
}

/**
 * 把任意字符串散列成 32 位种子。
 * 用途：允许「用一句话当种子」—— 同一天同一句话，发到同一手牌。
 */
export function hashSeed(str) {
  const s = String(str ?? '');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // 再补一轮混合，避免短字符串的低位规律
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  return h >>> 0;
}

/** 可选的种子来源。crypto 是默认，其余两个是给「想复现」和「想手动」的场合。 */
export const SEED_SOURCES = [
  { id: 'crypto', label: '加密随机（推荐）', hint: '取 43 亿分之一的空间，谁也猜不到' },
  { id: 'time', label: '本机时间', hint: '用开机时刻当种子，可读、可按时辰复现' },
  { id: 'manual', label: '手动填入', hint: '数字原值使用；文字会被散列成种子' },
];

/**
 * 时间戳种子：取本机毫秒时间戳的低 32 位。
 *
 * 注意它并不比 crypto 更随机，反而更弱 —— 详见 resolveSeed 的注释。
 * 保留它的价值在于「可读」：一局牌对应一个时刻，可以用来复现和归档。
 */
export function seedFromTime(at = Date.now()) {
  const t = Number(at);
  const n = Number.isFinite(t) ? Math.floor(t) : Date.now();
  return (n >>> 0) || 1;
}

/**
 * 决定本局的种子。
 *
 * 关于「时间种子算不算真随机」——不算，而且明显弱于 crypto：
 *   - 时间戳取值是可枚举的。知道大致开局时刻的人，只需在一个小窗口里
 *     穷举（每毫秒一个候选），用已知的公开手牌一比对就能反推出整副牌。
 *     洗牌算法是公开的，种子一旦确定，54 张牌全在明面上。
 *   - crypto.getRandomValues 的取值空间是 2^32 ≈ 43 亿，且与任何可观察量
 *     无关，穷举没有着力点。
 * 所以默认仍是 crypto；time 只作为「可读 / 可按时辰复现」的选项保留，
 * 并在界面上标明它的代价。
 *
 * 优先级：输入框里只要有内容，就永远以它为准 ——
 * 这样界面上显示的那个种子数字，粘回输入框就能原样复现一局。
 *
 * @param raw       输入框内容
 * @param source    'crypto' | 'time' | 'manual'
 * @param at        时间种子的取样时刻（可注入，便于测试）
 * @param recent    最近用过的种子，用来错开同一毫秒内连开的两局
 * @returns { seed, origin, echo, at }
 */
export function resolveSeed({ raw = '', source = 'crypto', at = Date.now(), recent = [] } = {}) {
  const s = String(raw ?? '').trim();

  // 手动优先：填了东西就以它为准，与来源下拉框无关
  if (s) {
    if (/^\d+$/.test(s)) return { seed: Number(s) >>> 0, origin: 'manual-number', echo: null, at: null };
    return { seed: hashSeed(s), origin: 'manual-text', echo: s, at: null };
  }

  if (source === 'manual') {
    // 选了手动却没写东西：不能静默吞掉，调用方据此给出提示
    return { seed: randomSeed(), origin: 'manual-empty', echo: null, at: null };
  }

  if (source === 'time') {
    const stamp = Number.isFinite(Number(at)) ? Math.floor(Number(at)) : Date.now();
    let seed = seedFromTime(stamp);
    // 同一毫秒内连开两局会撞成同一副牌，用黄金比例常数往后错开
    const taken = new Set((recent || []).map((x) => x >>> 0));
    for (let i = 0; i < 64 && taken.has(seed); i++) seed = (seed + 0x9e3779b1) >>> 0;
    return { seed, origin: 'time', echo: null, at: stamp };
  }

  return { seed: randomSeed(), origin: 'crypto', echo: null, at: null };
}

/**
 * 解析用户填的种子（兼容旧调用）。
 *   全数字 → 直接当种子用（这样界面上显示的种子可以直接粘回来复现）
 *   其它文字 → 散列
 *   空       → 取新种子
 * 返回 { seed, source }，source 是原文（文字种子会回显给用户看）。
 */
export function parseSeed(raw) {
  const r = resolveSeed({ raw, source: 'crypto' });
  return { seed: r.seed, source: r.echo };
}

/** 原地洗牌（Fisher-Yates），返回同一个数组 */
export function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/** 从数组里随机取 n 个不重复元素 */
export function pick(arr, n, rng) {
  const copy = [...arr];
  shuffle(copy, rng);
  return copy.slice(0, n);
}

/**
 * 由「种子 + 一个计数器」派生出一个下标。
 *
 * 破例动作（抢牌抢到哪张、偷看到哪张）需要「随机但可复现」。
 * 直接写 (seed + n * 7) % len 是不行的 —— 那是个线性函数，
 * 分布会偏向小下标，而且知道 seed 的人可以精确预测结果。
 * 这里改成先用混合函数把两个数搅开，再用 PRNG 取一个下标。
 */
export function derivedIndex(seed, counter, len) {
  const n = Math.max(0, Number(len) | 0);
  if (n <= 1) return 0;
  let h = (seed >>> 0) ^ Math.imul((Number(counter) | 0) + 1, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  h = (h ^ (h >>> 16)) >>> 0;
  return Math.floor(makeRng(h)() * n);
}
