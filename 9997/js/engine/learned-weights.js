/**
 * learned-weights.js — 自博弈学习出来的那组权重（训练产物的落点）
 *
 * 这个文件为什么单独存在
 * ------------------------------------------------------------------
 * 手调的权重住在 doudizhu-sim.js 的 POLICY_WEIGHTS 里，那是「人读得懂、改得动」
 * 的地方。自博弈学出来的权重不一样：它是一台优化器在几十代里推出来的数字，
 * 单看某一个数说不出所以然，只能整体看待。把两者分开，是为了让
 *   「smart 被我改坏了」
 * 和
 *   「learned 这一轮训练学歪了」
 * 变成两件互不牵连的事 —— 前者动代码，后者只重跑训练。
 *
 * TRAINED 为 null 表示还没训练过。此时 learned 档会整个退回 POLICY_WEIGHTS，
 * 也就是 learned 与 smart 完全同源（有自检钉住这一点，见 tools/smoke-learn.mjs）。
 * 写入只由 tools/selfplay-learn.mjs --write 执行，不许手改。
 *
 * 注意：这里【只放差值】不是设计选择，只是方便阅读 —— 实际就是一份完整权重表。
 */

/** @type {{weights: object, meta: object}|null} */
export const TRAINED = null;
