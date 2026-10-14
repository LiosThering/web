/**
 * policy-learn.js — 自博弈学习的「参数空间」与「优化器」
 *
 * 这个文件只解决两件事
 * ------------------------------------------------------------------
 *   1. 把「一组权重」看成「一个向量」，并且规定好这个向量的每个分量
 *      【扰动幅度该有多大】（PARAM_SIGMA）。这不是装饰：不规定量纲，
 *      优化器就得自己摸索「hands 该动 1 还是动 100」，等于把最难的部分
 *      交给一个瞎猜的家伙。
 *   2. 给出一步镜像采样的进化策略（ES）更新。
 *
 * 为什么用 ES，而不是梯度反传 / CFR
 * ------------------------------------------------------------------
 * 在这套代码里，「策略好不好」只能通过【打完整局牌】量出来 —— 模拟器是一串
 * 不可微的分支（分解手牌、比大小、走候选）。这种目标函数没有解析梯度可用。
 * ES 的特点恰好对症：它把梯度当成黑盒来估，只需要能「给一组权重打个分」。
 *
 * 镜像采样（antithetic）也就是一次取 ±ε 两个点。这不是为了省事，而是这个
 * 问题里最要紧的一招：报出来的分是【胜率】，天然带噪声，而同一副牌同一组
 * 对手下，θ+σ 与 θ−σ 的差别里绝大部分噪声是共模的，相减就抵消掉了。
 * 每个分量上「这一对谁更好」的信号因此变得干净得多。
 *
 * 这跟 tools/tune-policy.mjs 是什么关系
 * ------------------------------------------------------------------
 * 那个脚本搜的是同一批旋钮，但用的是网格（每维挑几个值、全组合试一遍）。
 * 网格的毛病是「格子有多大，精度就有多粗」，而且维数一多组合就爆掉 ——
 * 上一轮的结论「最优解落在网格边界上，得扩范围重搜」就是这个毛病的症状。
 * ES 在连续空间里走，不需要网格，代价是它得靠梯度估计（因此更吃噪声）。
 * 两条路都留着：网格直观、可复现、结论好读；ES 细、能走格子之间。
 */

import { makeRng } from '../core/rng.js';
import { POLICY_PARAM_KEYS, POLICY_WEIGHTS } from './doudizhu-sim.js';

/**
 * 每个参数被扰动时的标准差。
 *
 * 定这个表的依据是「这个参数在公式里被乘上的东西有多大」：
 *   · hands / llHands / ffHands 乘的是「手数」（个位数），所以 σ 取十几；
 *   · noCtrl / oppLead* / oppBeat 乘的是 0/1 的开关，权重本身就得几百
 *     才能跟手数项抗衡，所以 σ 也取百量级；
 *   · rankCost 乘的是脱手代价（最大 240 上下），权重是个小数，σ 取 0.3；
 *   · passHands 乘的是剩余手数，量级同 hands，所以 σ 同量级。
 *
 * σ 定错会怎样（实测，不是推演）
 * ------------------------------------------------------------------
 * 下面这几个新参数第一版是按"跟 noCtrl 同类的开关"给的 σ（150~300）。
 * 结果：只动它们、幅度只有 0.1σ，平均就掉 8.3pt，16 次里 16 次变差 ——
 * 整片地形像一个断崖，优化器一步都迈不出去。
 *
 * 根因是【它们不是开关】：
 *   · gradeTop 乘的是一条 0~1 的坡（每张单牌都算），不是 0/1；
 *   · oppGrad* 乘的是 0~1 的压力值，每个候选都算。
 * 一个永远在线的坡 × σ=300，意味着 0.1σ 就能把分数搬动 30 分 ——
 * 而打分表里「少一手」才值 50 分。这不是"小扰动"。
 *
 * 反过来，老参数（noCtrl 这些）用同样的相对幅度扰动是【中性】的
 * （实测 −2.3pt，16 次里 11 次变差，落在噪声内）。所以问题不在"打分表太尖锐"，
 * 而在这几个新参数的刻度一开始就选错了。
 *
 * 现在的原则：σ 取「让分数搬动大约一手（=50 分）的几分之一」。
 * 常常触发的坡 → σ 小（40~60）；很少触发的开关 → σ 可以大（150~200）。
 *
 * 缺项不报错，按 1 处理 —— 但 POLICY_PARAM_KEYS 有自检钉住每个键都在这里，
 * 免得将来加了新参数却忘了给 σ，静悄悄用了一个差两个数量级的默认值。
 */
export const PARAM_SIGMA = {
  // ---- smart 原本就在用、已经调好的那些（小幅扰动实测中性）----
  hands: 12,
  noCtrl: 120,
  rankCost: 0.3,
  oppLeadMulti: 120,
  oppLeadSingle: 60,
  oppBeat: 90,
  cheapBig: 60,
  wasteTop: 150,
  feedMate: 200,
  passHands: 25,
  passNoCtrl: 45,

  // ---- 为学习新开的口子：常常触发的坡，σ 必须小 ----
  gradeTop: 50,
  oppGradLeadMulti: 60,
  oppGradLeadSingle: 40,
  oppGradBeat: 50,
  mateNear: 200,

  // ---- 角色拆开的「手数」：乘的是手数，跟 hands 同量级 ----
  llHands: 20,
  ffHands: 20,

  // ---- 平局偏好：乘的是点数（3~17），σ 取 0.75 = 半个点数量级 ----
  // 上限同 cheapTie 本身：整段偏好的跨度是 14×σ，不能大到盖过脱手代价的 20 分档。
  cheapTie: 0.75,
};

/** 按 POLICY_PARAM_KEYS 的顺序，把权重对象摊成一个向量 */
export function thetaFromWeights(W) {
  const out = new Float64Array(POLICY_PARAM_KEYS.length);
  for (let i = 0; i < out.length; i++) {
    const v = Number(W[POLICY_PARAM_KEYS[i]]);
    out[i] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** 把向量装回权重对象。base 决定「不属于参数向量」的那几项（finish、addLowSingle） */
export function weightsFromTheta(theta, base = POLICY_WEIGHTS) {
  const out = { ...base };
  for (let i = 0; i < POLICY_PARAM_KEYS.length; i++) {
    const v = theta[i];
    // 一个不是数的权重会让整张打分表变成 NaN，而 NaN 的比较全是 false ——
    // 表现是「所有候选同分、随便挑一个」，看起来像"策略变呆了"，
    // 完全不像数值错误。所以在这里就挡掉。
    out[POLICY_PARAM_KEYS[i]] = Number.isFinite(v) ? v : 0;
  }
  return out;
}

/** 参数向量的标准差向量 */
export function sigmaArray(key = 'sigma') {
  if (key === 'zero') return new Float64Array(POLICY_PARAM_KEYS.length);
  return Float64Array.from(POLICY_PARAM_KEYS, (k) => PARAM_SIGMA[k] || 1);
}

/** 标准正态。Box–Muller，用项目自己的 PRNG，保证整轮训练可复现。 */
export function gaussian(rng) {
  let u = 0;
  while (u === 0) u = rng(); // log(0) 会得到 -Infinity
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * 一步镜像采样 ES —— 只算方向，不定步长。
 *
 * 为什么不在这里把步长一起定下来
 * ------------------------------------------------------------------
 * 「该走多远」取决于目标函数的坡度，而坡度在这里是不可预知的：一次评估是
 * 打几百局牌，报出来的是胜率，梯度估计本身量级小得可怜（千分之几）。所以
 * 「θ 该动 0.1 还是动 10」这个问题没法事先算，只能【测】——
 * 由调用方拿这个方向去试几个步长，挑实际效果最好的那个。
 *
 * 这不是偷懒，恰恰是这类问题里最稳的做法：目标函数没有解析形式、噪声又不小，
 * 唯一可信的坡度信息就是"走一步看看"。见 tools/selfplay-learn.mjs 里的线搜索。
 *
 * @param theta    当前参数（Float64Array）
 * @param sigma    每个分量的扰动幅度
 * @param pairs    采几对（每对 2 次评估）
 * @param evaluate (theta) => number，越大越好，必须【确定性】
 * @param rng      随机流
 *
 * @returns {{dir, grad, meanPlus, meanMinus}}
 *   dir = σ ⊙ ḡ，含义是「步长取 1 时 θ 该挪多少」。乘上 eta 就是实际位移。
 */
export function esStep({ theta, sigma, pairs = 8, evaluate, rng }) {
  const dim = theta.length;
  const grad = new Float64Array(dim);
  const eps = new Float64Array(dim);
  const plus = new Float64Array(dim);
  const minus = new Float64Array(dim);
  let sumPlus = 0;
  let sumMinus = 0;

  for (let k = 0; k < pairs; k++) {
    for (let j = 0; j < dim; j++) eps[j] = gaussian(rng);
    for (let j = 0; j < dim; j++) {
      const d = sigma[j] * eps[j];
      plus[j] = theta[j] + d;
      minus[j] = theta[j] - d;
    }
    const fp = evaluate(plus);
    const fm = evaluate(minus);
    sumPlus += fp;
    sumMinus += fm;
    for (let j = 0; j < dim; j++) grad[j] += (fp - fm) * eps[j];
  }

  const norm = 1 / (2 * pairs);
  for (let j = 0; j < dim; j++) grad[j] *= norm;

  return {
    dir: Float64Array.from(grad, (g, j) => sigma[j] * g),
    grad,
    meanPlus: sumPlus / pairs,
    meanMinus: sumMinus / pairs,
  };
}

/**
 * 把方向向量换算成「步长取 1 时 θ 该挪多少」。
 *
 * 为什么要归一化：ES 估出来的梯度量级完全取决于「评估噪声有多大、采了几对」，
 * 跟"该走多远"没有稳定关系。实测里 dir 的模长在 5~26 之间跳，而参数本身的
 * 尺度是几百 —— 不归一化的话，线搜索得去试 0.001 到 100 这么宽的档，
 * 而且每一代的合适档位还不一样。
 *
 * 归一化的基准选「σ 单位下的模长」：
 *     ‖g‖ = √( Σ (dir_j / σ_j)² )
 * 因为 σ_j 才是这个参数"一动就明显不一样"的天然刻度。归一化之后，
 * eta = 1 的含义是「在 σ 尺度上移动一整格」，跨参数、跨代都可比。
 *
 * 代价：丢掉了坡度大小携带的信息（地形陡的时候本来该走大步）。这是有意换的 ——
 * 在这类黑盒目标上，「步长量纲统一、可以事先定死」比「按坡度自适应」更不容易翻车。
 *
 * @returns {{unit: Float64Array, mag: number}} unit 已乘好等比例，直接当 eta=1 用
 */
export function scaleDir(dir, sigma) {
  let n = 0;
  for (let j = 0; j < dir.length; j++) {
    const u = dir[j] / sigma[j];
    n += u * u;
  }
  n = Math.sqrt(n);
  const unit = new Float64Array(dir.length);
  if (!(n > 0)) return { unit, mag: 0 }; // 方向为零：这一代没有任何可用信号
  for (let j = 0; j < dir.length; j++) unit[j] = dir[j] / n;
  return { unit, mag: n };
}

/**
 * 沿方向走 eta 步，并把每个分量限制在 base ± bound·σ 之内。
 *
 * 为什么要设边界：这不只是防数值爆炸。边界本身是个【诊断信号】——
 * 某个参数一路顶到边上，意思是"它还想往那边走，是框子拦住了"。
 * 那和网格搜索里"冠军落在网格边界上"是同一件事：说明搜索范围设窄了。
 * 所以撞边界要被数出来、报出来，而不是悄悄夹断。
 */
export function applyStep({ theta, base, dir, eta, sigma, bound = 6 }) {
  const dim = theta.length;
  const out = new Float64Array(dim);
  let hits = 0;
  for (let j = 0; j < dim; j++) {
    let v = theta[j] + eta * dir[j];
    const lo = base[j] - bound * sigma[j];
    const hi = base[j] + bound * sigma[j];
    if (v <= lo) { v = lo; hits++; } else if (v >= hi) { v = hi; hits++; }
    out[j] = v;
  }
  return { theta: out, hits };
}

/** 两个参数向量的差别（只列变了的分量），给报告用 */
export function diffTheta(base, theta, minRel = 0) {
  const rows = [];
  for (let i = 0; i < POLICY_PARAM_KEYS.length; i++) {
    const k = POLICY_PARAM_KEYS[i];
    const a = base[i];
    const b = theta[i];
    if (a === b) continue;
    const s = PARAM_SIGMA[k] || 1;
    if (Math.abs(b - a) < minRel * s) continue;
    rows.push({ key: k, from: a, to: b, sigmas: (b - a) / s });
  }
  rows.sort((x, y) => Math.abs(y.sigmas) - Math.abs(x.sigmas));
  return rows;
}

/** 造一个可复现的随机流（训练入口用） */
export function learnerRng(seed) {
  return makeRng(seed >>> 0);
}
