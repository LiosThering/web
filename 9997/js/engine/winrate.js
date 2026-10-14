/**
 * winrate.js — 胜率引擎
 *
 * 定位：在把提示词发给 LLM 之前，本地先把每个候选动作的胜率算出来，
 * 连同提示词一起发过去。胜率必须由本地算，绝不能让 LLM 自己估 ——
 * 让模型自己猜胜率，等于让它在没有棋盘的情况下算残局。
 *
 * 三条实现路线（接口一致，可随时互换）
 * ------------------------------------------------------------------
 *   StubEngine     不产出胜率。提示词里就不出现胜率表。
 *
 *   RolloutEngine  当前默认。信息集蒙特卡洛（determinized rollout）：
 *                  从【智能体视角】把看不见的牌随机补全，得到一个个
 *                  与它掌握的信息完全一致的完整局面，然后按同一套策略
 *                  把这些局面打完，看赢了多少次。
 *                  必须经过视角补全，不能拿真实牌局直接打 ——
 *                  后者算出来的是「上帝视角的胜率」，会让智能体凭空变准。
 *
 *   OnnxEngine     Phase 2 训练完成后接入，用网络拟合
 *                  「局面特征 → 各动作胜率」，一次前向给出全部候选。
 *
 * 训练路线（已确定）：
 *   1. 用蒙特卡洛模拟为海量局面打真实胜率标签 ← RolloutEngine 现在就在做这件事
 *   2. 训练一个网络拟合「局面特征 → 各动作胜率」的映射
 *   3. 导出 ONNX，静态托管，浏览器加载
 *   于是蒙特卡洛从「线上推理引擎」变成「离线标签生成器 + 线上兜底」。
 *
 * 采样预算怎么花
 * ------------------------------------------------------------------
 * 实测一次完整模拟约 0.05ms（规则包本体是 11ms，因为在做事件溯源）。
 * 所以预算足够宽裕，策略是【先铺开、再加深】：
 *   阶段一：每个候选都分到相同数量的世界 —— 保证任何一行数值都不是空着；
 *   阶段二：把剩下的时间给领先的那几个候选，让头部的数字变准。
 * 不这么做的典型错误是「给第一个候选 500 次采样、最后一个 0 次」，
 * 那样表里的数字互相之间不可比，比没有更糟。
 *
 * 关于「对手最优」
 * ------------------------------------------------------------------
 * 严格的最优胜率要解博弈，浏览器里做不到。这里的对手由同一套
 * 启发式策略扮演：能一手走完就走、用 2 和王去压小牌不划算、不抢队友的牌、
 * 对手快走完时才动炸弹。所以数值应理解为「对手稳健应对时」的胜率，
 * 不是「对手全知全能时」的胜率 —— 提示词里也是这么写的。
 */

import { createDoudizhuJudge } from './doudizhu-sim.js';
import { createBlackjackJudge } from './blackjack-judge.js';
import { createHighcardJudge } from './highcard-sim.js';
import { createHoldemJudge } from './holdem-sim.js';

// ---------------------------------------------------------------------------
// 评估官注册表
// ---------------------------------------------------------------------------

/**
 * 每种玩法一个评估官。要再接新玩法，在这里登记一个
 * 能回答「动作 + 世界编号 → 这局赢没赢」的对象即可，引擎本身不用改：
 * 报告的是赢面还是期望分（metric）、是不是精确解（exact）、
 * 对手算哪一档（simPolicy），全部由评估官自己声明。
 *
 * 【不是每种玩法都该用蒙特卡洛】—— 21 点就是一个反例。赢面由补牌顺序决定，
 * 而那个顺序可以被完整枚举，所以它的赢面是一个可精确计算的数，采样只会
 * 把精确值换成一个带误差的估计。blackjack-judge 于是对所有世界返回同一个值，
 * 引擎平均出来就是精确值、方差为零。同一个引擎，两种玩法，各取所长。
 *
 * 【按赢面排还是按期望分排，也不是风格问题】—— 21 点与德州的动作会改变
 * 输赢的分量（双倍/分牌/加注），按赢面排会把它们系统性判低。
 * 而且这两件事互相独立：德州按期望分排，但它的值同样是采样来的。
 */
const JUDGES = {
  doudizhu: createDoudizhuJudge,
  // 斗地主改版（换牌数/换规则）沿用同一套模拟器，故一并登记
  ddz: createDoudizhuJudge,
  blackjack: createBlackjackJudge,
  highcard: createHighcardJudge,
  holdem: createHoldemJudge,
};

export function registerJudge(ruleSetId, factory) {
  JUDGES[ruleSetId] = factory;
}

// ---------------------------------------------------------------------------
// 关闭状态
// ---------------------------------------------------------------------------

export const StubEngine = {
  id: 'stub',
  name: '未启用',
  ready: false,
  engineId: 'off',

  async init() {
    return this;
  },

  /** @returns {Promise<Array<{action:object, winRate:number|null, source:string, reason?:string}>>} */
  async evaluate({ candidates = [] }) {
    return candidates.map((action) => ({ action, winRate: null, source: 'stub' }));
  },
};

// ---------------------------------------------------------------------------
// 蒙特卡洛引擎
// ---------------------------------------------------------------------------

/** 采样档位。budgetMs 是每个决策的时间上限，base 是先铺开的世界数 */
export const ENGINE_MODES = [
  {
    id: 'off',
    label: '关闭',
    hint: '不算胜率，提示词里也不会出现胜率表',
    budgetMs: 0,
    base: 0,
    deep: 0,
    deepWorlds: 0,
  },
  {
    id: 'fast',
    label: '快速',
    hint: '每个候选先铺 16 个世界，约 0.15 秒',
    budgetMs: 150,
    base: 16,
    deep: 8,
    deepWorlds: 240,
  },
  {
    id: 'normal',
    label: '标准',
    hint: '每个候选铺 30 个世界，再加深领先的候选，约 0.4 秒',
    budgetMs: 420,
    base: 30,
    deep: 10,
    deepWorlds: 600,
  },
  {
    id: 'deep',
    label: '深入',
    hint: '每个候选铺 48 个世界，头部候选上千次采样，约 1 秒',
    budgetMs: 1000,
    base: 48,
    deep: 12,
    deepWorlds: 1500,
  },
];

export function getEngineMode(id) {
  return ENGINE_MODES.find((m) => m.id === id) || ENGINE_MODES[2];
}

const yieldToUI = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * 造一个蒙特卡洛引擎。
 * @param modeId     档位 id（见 ENGINE_MODES）
 * @param seed       采样种子：同种子必得同一批世界（可复现、可对比）
 * @param fixedWorlds 固定加深轮数，忽略时间预算。
 *                  时间预算是为了「别把页面卡住」，代价是采样数会随机器快慢浮动 ——
 *                  同一张表在两台机器上不相等。想复现、想做 A/B 对照（例如
 *                  「换了对手的暗牌，胜率该不该变」）时把它写上，结果就是确定的。
 * @param onProgress 进度回调（算得慢的时候给界面一句人话）
 */
export function createRolloutEngine({
  modeId = 'normal', seed = 20260928, fixedWorlds = 0, onProgress = null,
  simPolicy = 'smart',
} = {}) {
  let mode = getEngineMode(modeId);

  return {
    id: 'rollout',
    name: '蒙特卡洛',
    engineId: 'rollout',
    ready: true,
    get modeId() {
      return mode.id;
    },
    setMode(id) {
      mode = getEngineMode(id);
      return this;
    },

    async init() {
      return this;
    },

    /**
     * @returns {Promise<{candidates:Array, breaches:Array, meta:object}>}
     *   两个数组与传入的候选/破例动作【一一对应、顺序不变】，
     *   调用方直接按下标取即可。
     */
    async evaluate({
      view,
      selfId,
      ruleSet,
      ruleState = {},
      candidates = [],
      breaches = [],
      modeId: override = null,
    } = {}) {
      const cfg = override ? getEngineMode(override) : mode;
      const started = Date.now();
      const fill = (list) => list.map((action) => ({
        action,
        winRate: null,
        ev: null,
        samples: 0,
        source: 'rollout',
      }));

      const outCandidates = fill(candidates);
      const outBreaches = fill(breaches);

      const judgeFactory = JUDGES[ruleSet && ruleSet.id];
      if (!judgeFactory) {
        const reason = `尚未为玩法「${ruleSet?.id || '?'}」登记胜率评估官`;
        for (const r of [...outCandidates, ...outBreaches]) r.reason = reason;
        return { candidates: outCandidates, breaches: outBreaches, meta: { engine: 'rollout', ok: false, reason } };
      }
      if (!cfg.base) {
        for (const r of [...outCandidates, ...outBreaches]) r.reason = '胜率引擎已关闭';
        return { candidates: outCandidates, breaches: outBreaches, meta: { engine: 'off', ok: true } };
      }

      let judge;
      try {
        judge = judgeFactory({ view, selfId, ruleSet, ruleState, seed, simPolicy });
      } catch (err) {
        const reason = `局面无法补全：${err && err.message ? err.message : err}`;
        for (const r of [...outCandidates, ...outBreaches]) r.reason = reason;
        return { candidates: outCandidates, breaches: outBreaches, meta: { engine: 'rollout', ok: false, reason } };
      }

      // 纸牌守恒是所有数字的前提。对不上就【不出数】——
      // 一份看着像样的胜率表比一张空白表危险得多。
      if (judge.balanced === false) {
        const reason = '牌数对不上（视角补全失败），本次不出胜率';
        for (const r of [...outCandidates, ...outBreaches]) r.reason = reason;
        return { candidates: outCandidates, breaches: outBreaches, meta: { engine: 'rollout', ok: false, reason } };
      }

      // 候选与破例一起纳入采样，但破例是同分优先级的第二梯队：
      // 它只要一个「划不划算」的量级判断，不需要很准。
      const targets = [
        ...outCandidates.map((r) => ({ row: r, action: r.action, tier: 'candidate' })),
        ...outBreaches.map((r) => ({ row: r, action: r.action, tier: 'breach' })),
      ].map((t) => ({ ...t, st: { n: 0, wins: 0, score: 0, invalid: 0 } }));

      const deadline = started + cfg.budgetMs;
      let samples = 0;
      let yielded = 0;

      const sampleAt = (t, world) => {
        const r = judge.run(t.action, world);
        samples++;
        if (!r) {
          t.st.invalid++;
          // 记下第一次失败的具体原因。只写「没有采到有效样本」等于什么都没说 ——
          // 一个候选全军覆没时，必须能立刻看出是牌型不成立、还是这个世界里
          // 那张牌不在他手上，否则只能靠猜。
          if (!t.st.why) t.st.why = judge.lastReason || '';
          return;
        }
        t.st.n++;
        /**
         * pWin 是可选的【分数赢面】：评估官如果直接给得出精确概率，
         * 就不必把 0.37 这个数取整成「这局赢了」。斗地主不给 pWin
         * （它是真的在数赢了几局），21 点给 —— 于是同一个引擎既能跑抽样，
         * 也能承载精确解。
         */
        if (typeof r.pWin === 'number') t.st.wins += r.pWin;
        else if (r.won) t.st.wins++;
        t.st.score += r.score;
      };

      // ---- 采样 ----
      //
      // 评估官可以声明自己【精确】（judge.exact）：它的 run() 对任何世界都返回
      // 同一个可计算的数，所以「多铺几个世界」不增加任何信息 —— 只会把同一个
      // 精确值重算上百遍。21 点就是这种：实测一个决策 430ms 里有 429ms 在重复
      // 求同一个数。声明精确之后每个候选只求一次，决策回到 1ms 量级。
      if (judge.exact) {
        for (const t of targets) sampleAt(t, 0);
      } else {
        // ---- 阶段一：每个目标都铺同样多的世界 ----
        for (let w = 0; w < cfg.base; w++) {
          for (const t of targets) sampleAt(t, w);
          if (!fixedWorlds && Date.now() > deadline) break;
          if ((w & 7) === 7 && onProgress) {
            yielded++;
            await yieldToUI();
            onProgress({ phase: 'spread', world: w + 1, total: cfg.base, samples });
          }
        }

        // ---- 阶段二：把剩下的时间给领先的候选 ----
        //
        // 只加深【合规候选】，破例不参与这一轮。两个理由：
        //   1. 破例只要一个「划不划算」的量级判断就够了（罚分本来就唱主角）；
        //   2. 更要紧的是稳定性 —— 破例的胜率会随「那一张牌是谁的」浮动，
        //      若让它参与决定加深名单，候选那一栏的数字就会跟着抖，
        //      而候选之间的横向比较正是这张表存在的意义。
      }
      const candTargets = judge.exact ? [] : targets.filter((t) => t.tier === 'candidate');
      const rate = (t) => (t.st.n ? t.st.wins / t.st.n : -1);
      const ranked = [...candTargets]
        .filter((t) => t.st.n > 0)
        .sort((a, b) => rate(b) - rate(a));
      const best = ranked.length ? rate(ranked[0]) : 0;
      const deepSet = ranked
        .slice(0, cfg.deep)
        .concat(ranked.filter((t) => rate(t) >= best - 0.12))
        .filter((t, i, arr) => arr.indexOf(t) === i);

      const rounds = judge.exact ? 0 : (fixedWorlds || cfg.deepWorlds);
      for (let round = 1; round <= rounds; round++) {
        if (!deepSet.length) break;
        for (const t of deepSet) sampleAt(t, cfg.base + round);
        if (!fixedWorlds && Date.now() > deadline) break;
        if ((round & 15) === 15) {
          await yieldToUI();
          if (onProgress) onProgress({ phase: 'deepen', world: round, total: rounds, samples });
        }
      }

      // ---- 结算 ----
      /**
       * 用赢面还是用期望分排序？
       *
       * 这不是风格问题。斗地主一手牌只结算一次，赢面最大的那一手就是最划算
       * 的那一手，两个度量同序。21 点不是：双倍和分牌会把注翻成 2 注，
       * 于是「赢面 43%、赢一次收 2 注」明显好过「赢面 46%、赢一次收 1 注」。
       * 按赢面排会系统性地把双倍判低 —— 实测 11 对 10 就是这样被算成
       * 「该要牌不该双倍」的。所以度量由评估官声明，引擎照着排，
       * 并把用了哪个度量写进 meta，让界面和提示词都能说清楚自己在看什么。
       */
      const byEv = judge.metric === 'ev';
      const rankOf = (row) => (byEv ? row.ev : row.winRate);

      const finish = (t) => {
        const { row, st } = t;
        if (st.invalid) row.invalid = st.invalid;
        if (!st.n) {
          row.reason = st.invalid
            ? `这些牌在当前视角下无法确定，跳过采样${st.why ? `（${st.why}）` : ''}`
            : '没有采到有效样本';
          return;
        }
        row.winRate = st.wins / st.n;
        row.ev = st.score / st.n;
        row.samples = st.n;
        row.source = 'rollout';
        row.rankValue = rankOf(row);
        if (judge.noteFor) {
          const note = judge.noteFor(t.action);
          if (note) row.note = note;
        }
      };
      for (const t of targets) finish(t);

      // 标出本地引擎推荐的那一手（只标合规候选，破例不推荐）
      let bestRow = null;
      for (const t of outCandidates) {
        if (t.winRate === null) continue;
        if (!bestRow || t.rankValue > bestRow.rankValue + 1e-9) bestRow = t;
      }
      if (bestRow) bestRow.recommended = true;

      const bySamples = outCandidates.map((r) => r.samples);
      const invalid = targets.reduce((n, t) => n + t.st.invalid, 0);
      const usable = outCandidates.filter((r) => r.winRate !== null).length;

      // 一个候选都算不出来的时候，这张表就是废纸 —— 不能报「成功」。
      // 引擎此刻真正能做的事是承认自己算不动，让本地策略退回到启发式，
      // 而不是让提示词里挂着一张全是空白的胜率表、让模型以为「没有信息」。
      if (!usable) {
        return {
          candidates: outCandidates,
          breaches: outBreaches,
          meta: {
            engine: 'rollout',
            ok: false,
            reason: '这次没有算出一个可用的胜率（局面在这个视角下无法确定）',
            mode: cfg.id,
            phase: judge.phase,
            exact: !!judge.exact,
            samples,
            invalid,
            elapsedMs: Date.now() - started,
          },
        };
      }

      return {
        candidates: outCandidates,
        breaches: outBreaches,
        meta: {
          engine: 'rollout',
          ok: true,
          mode: cfg.id,
          phase: judge.phase,
          samples,
          invalid,
          usable,
          minSamples: bySamples.length ? Math.min(...bySamples) : 0,
          maxSamples: bySamples.length ? Math.max(...bySamples) : 0,
          elapsedMs: Date.now() - started,
          yields: yielded,
          fixedWorlds: fixedWorlds || 0,
          /**
           * 【精确】与【度量】是两件事，不能混为一个字段。
           *
           * 之前界面和提示词都拿 `metric === 'ev'` 当「这是精确解」的判据，
           * 只因为当时唯一按期望分排序的玩法（21 点）恰好也是精确的。
           * 德州扑克把这两件事拆开了：它的候选优劣必须按【期望筹码】排
           * （加注赢了收一个池、弃牌只赔已投入的），但它的值同样要靠采样 ——
           * 对手会怎么打不是规则写死的。于是「按期望分排序」与「采样」
           * 同时成立，旧判据会把一张采样表标成「精确解·零采样·结果唯一」。
           *
           * 所以这里显式声明 exact，让两边各说各的事实。
           */
          exact: !!judge.exact,
          /** 排序用的度量：'win' 按赢面，'ev' 按期望分 */
          metric: judge.metric || 'win',
          // 这批数字是在多强的对手面前算出来的。它不是术语装饰 ——
          // 换档对手强度会整体改变胜率的读数，用户必须能看见自己在看哪一个。
          opponent: judge.simPolicy || simPolicy,
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// ONNX 推理引擎骨架
// ---------------------------------------------------------------------------

const ORT_VERSION = '1.19.2';

export function createOnnxEngine({ modelUrl, ortUrl } = {}) {
  return {
    id: 'onnx',
    name: 'ONNX 神经网络',
    ready: false,
    session: null,
    ort: null,
    modelUrl: modelUrl || '',
    ortUrl: ortUrl || `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/ort.min.mjs`,
    featureSpec: null,
    lastError: null,

    async init() {
      if (!this.modelUrl) {
        this.lastError = '未配置模型地址';
        return this;
      }
      try {
        const mod = await import(/* webpackIgnore: true */ this.ortUrl);
        const ort = mod.default && mod.default.InferenceSession ? mod.default : mod;
        ort.env.wasm.wasmPaths = this.ortUrl.replace(/ort\.min\.mjs$/, '');
        this.ort = ort;
        this.session = await ort.InferenceSession.create(this.modelUrl, {
          executionProviders: ['wasm'],
        });
        this.ready = true;
        this.lastError = null;
      } catch (err) {
        this.lastError = String(err && err.message ? err.message : err);
        this.ready = false;
      }
      return this;
    },

    /**
     * 把观测量编码成模型输入。
     * 【Phase 2 待实现】特征编码必须与训练时的编码完全一致，
     * 且强依赖具体玩法（牌数、动作空间），所以这里留空，
     * 等玩法锁定后与训练脚本一起确定。
     */
    encode() {
      throw new Error('特征编码尚未实现：需先锁定玩法与训练脚本的特征定义');
    },

    async evaluate({ view, selfId, candidates }) {
      if (!this.ready) {
        return {
          candidates: candidates.map((action) => ({
            action,
            winRate: null,
            source: 'onnx',
            reason: this.lastError || '模型未就绪',
          })),
          breaches: [],
          meta: { engine: 'onnx', ok: false, reason: this.lastError || '模型未就绪' },
        };
      }
      throw new Error('推理尚未实现：等待 Phase 2 训练产物接入');
    },
  };
}

/**
 * 特殊规则修正层。
 *
 * 蒙特卡洛引擎只模拟【标准规则】：它在世界里不会去抢牌、不会偷看，
 * 也不会用「违规甩牌」这种玩法外的手段。所以胜率数值对应的是
 * 「大家都老实打」的世界，特殊机制的影响要在提示词里单独讲清楚，
 * 让 LLM 自己权衡。
 */
export function describeSpecialRules(rules = []) {
  if (!rules.length) return '';
  return [
    '本局启用了以下特殊机制。上方的胜率数值【没有】计入这些机制的影响，',
    '请你在决策时自行权衡：',
    ...rules.map((r) => `- ${r.name}：${r.description}`),
  ].join('\n');
}
