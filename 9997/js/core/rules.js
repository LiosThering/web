/**
 * rules.js — 规则包契约与注册表
 *
 * 规则包是可插拔的：内核、渲染、LLM 回路都只依赖这里的接口，
 * 不依赖任何具体玩法。要加斗地主/21点/梭哈，只需再写一个
 * 满足下列契约的对象并 registerRuleSet。
 *
 * 契约
 * ------------------------------------------------------------------
 * 【必需】
 * id / name / minPlayers / maxPlayers / description
 *   createDeck()                       → 牌数组
 *   deal(players, seed)                → { deck, hands }
 *   start(state)                       → 开局事件数组
 *   nextTurn(state)                    → 下一个该行动的 playerId，
 *                                        或 RETURN（本轮已满）
 *   legalActions(state, playerId)      → 【合规】候选动作数组
 *   validate(state, playerId, action, opts) → { ok, reason, breach?, penalty? }
 *   apply(state, playerId, action, check)   → 事件数组
 *   isRoundComplete(state)             → 本轮是否所有人都已行动
 *   resolveRound(state)                → 结算事件数组
 *   isTerminal(state)                  → 是否终局
 *   outcome(state)                     → 终局结果对象
 *   describe(state)                    → 给 LLM 看的规则文本（见下条【硬约束】）
 *
 * describe 的硬约束：它的输出会进【每一个】智能体的提示词
 * ------------------------------------------------------------------
 * describe 拿到的是原始 state，不带观察者，所以它写出来的话等于替所有座位
 * 一起发言。由此：
 *   · 只能写【全桌都看得见】的东西（轮次、张数、底池、已经公开的牌、
 *     谁弃了牌……）；
 *   · 【不能】写任何一个人的私有信息 —— 手牌牌面、手牌之和、暗牌是第几张。
 *     想写「你手上是什么」，走投影通道：describeTable(view) / turnHint /
 *     候选动作的 label。这几条都是按观察者取过材的。
 *   · 也【不能】写「你已经分成两手」这类话：describe 不知道「你」是谁。
 *
 * 这一条不是风格问题，是泄露问题：写在 describe 里，等于给所有智能体
 * 人手发一份别人的底牌。两个玩法都在这上面栽过（21 点的注释里反复写了
 * 一遍，比大小还是写漏了），所以审计工具 tools/audit-describe.mjs 会
 * 把每个规则包的 describe 拿出来，把私有字段改掉、要求文本一字不变 ——
 * 光靠注释约束不住的东西，就用断言钉住。
 *
 * 【可选 —— 支持「一回合内多次行动」】
 *   maxActionsPerTurn(state, playerId) → 本回合最多行动几次，默认 3
 *   mustEndTurn(state, playerId)       → 规则上要求立即结束回合？
 *                                        返回 true 时本回合到此为止
 *
 * 【可选 —— 支持「破例动作」】
 *   breachActions(state, playerId, opts) → 违规但可选的候选动作数组
 *
 * 【可选 —— 本地兜底策略用的启发式】
 *   heuristic(state, playerId, legalActions) → 从中挑一个，或 null
 *
 * 【可选 —— 界面适配（不给也能跑，只是手感按斗地主那一套来）】
 *   statusLine(state)                  → 顶栏上那行状态文字
 *   extraSeats()                       → 额外座位（如 21 点的荷官）。
 *                                        它不是玩家：不行动、不建智能体、不出现在人数下拉框里，
 *                                        但会出现在投影里 —— 于是它的牌能被渲染、能被提示词描述。
 *   cardGesture                        → 'play'（默认，左键点牌即出牌）| 'select' | 'none'
 *   turnHint(state, playerId)          → 轮到人类时提示条上写什么
 *   selectionHint(state, cardIds)      → 选中牌之后提示条上写什么
 *   multiSelect / allowFold            → 是否多选出牌 / 是否显示「认输」按钮
 *   foldLabel                          → 「认输」按钮上写什么。
 *                                        斗地主认输就是整局认输；德州扑克里
 *                                        同一个动作叫【弃牌】，只是放弃这一手 ——
 *                                        按钮写「认输」会让人以为点了就整局结束。
 *   localPolicyAllowFold               → 本地兜底（没有 API Key 时）允不允许弃牌。
 *                                        默认 false：本地策略只能弃牌的话，
 *                                        牌局会变成「谁都不打」，所以它一律守规矩打下去。
 *                                        德州扑克是例外 —— 弃牌本身就是它的正常打法，
 *                                        不让弃会让本地兜底拿着 7-2 也一路跟到底。
 *
 * 关于合法与违例的分工（重要）
 * ------------------------------------------------------------------
 * legalActions 只给【合规】动作。抢牌、多出一张这类破坏规则的行为
 * 不进 legalActions，它们属于 breachActions：
 *   - 本地兜底策略（没有 API Key 时）【绝不】碰 breachActions；
 *   - LLM 可以选择 breachActions 里的动作，代价由规则包声明，
 *     由 apply 写成事件（扣分、公示），全部记录在案。
 * 这样「守规矩」就成了智能体的一个真实选择，而不是硬约束。
 *
 * 规则包有义务净化自己的 ruleState（重要）
 * ------------------------------------------------------------------
 * 内核的 destroy 事件只保证【手牌】里不出现已销毁的牌（见 state.js）。
 * 那些只有规则包自己认识的字段 —— 21 点的 hands / dealer / pending、
 * 斗地主的 lead / bottom —— 内核不认识，也就清不掉。
 * 漏掉的后果全都是静默的：
 *   · 21 点不清 hands → 算出一手幽灵点数（那张牌明明没了，点数还在加）；
 *   · 斗地主不清 lead → 台面上那一手少了一张，却还按原牌型比大小。
 * 所以规则包的 apply 在处理 destroy 时必须自己发一条 ev.ruleState 把它摘干净。
 * 本文件提供 destroyCandidates() 生成候选、resolveDestroy() 做目标解析，
 * 就是为了让三个规则包共用同一份「销毁谁、能不能销毁」的判断，
 * 免得三处各写一份、各自跑偏。
 * ------------------------------------------------------------------
 */

export const RETURN = '__round_end__';

/** 默认回合行动上限 */
export const DEFAULT_MAX_ACTIONS_PER_TURN = 3;

const registry = new Map();

export function registerRuleSet(rs) {
  if (!rs || !rs.id) throw new Error('规则包必须有 id');
  registry.set(rs.id, rs);
  return rs;
}

export function getRuleSet(id) {
  return registry.get(id) || null;
}

export function listRuleSets() {
  return [...registry.values()];
}

// ---------------------------------------------------------------------------
// 动作构造器 —— 统一字段名，避免各处拼错
// ---------------------------------------------------------------------------

const TURN_END = 'endturn';

export const act = {
  play: (cardIds, label) => ({ type: 'play', cards: cardIds, label }),
  reveal: (cardId, mode, label) => ({ type: 'reveal', card: cardId, mode, label }),
  pass: (reason) => ({ type: 'pass', reason }),

  /**
   * 放弃这一局 / 这一手。
   *
   * label 可选。斗地主里它是「认输」（整局认输），德州扑克里它是「弃牌」
   * （放弃这一手，但牌局继续）—— 同一件事在两个玩法里的分量完全不同，
   * 所以文案交给规则包写。不传就退回通用文案。
   */
  fold: (label) => ({ type: 'fold', label }),

  /**
   * 「跟牌型无关」的一类动作：玩家不指定具体哪张牌，由规则包自己从牌堆发给他。
   * 21 点的要牌 / 停牌 / 双倍 / 分牌都是这一类 —— 它们共同的特征是
   * 【动作本身不带牌】，所以不能硬塞进 play（play 的语义是「我打出这几张」，
   * 校验时会去查这几张在不在你手上，用在这里会立刻被自己的规则拦下）。
   */
  hit: (label) => ({ type: 'hit', label }),
  stand: (label) => ({ type: 'stand', label }),
  double: (label) => ({ type: 'double', label }),
  split: (label) => ({ type: 'split', label }),

  /**
   * 下注类动作（德州扑克）。
   *
   * 与 hit/stand 同一族 —— 它们也【不指定牌】，所以不能塞进 play
   * （play 的校验会去查「这几张牌在不在你手上」，用在这里会被自己拦下）。
   * 区别在于它们带【金额】：金额是动作的一部分而不是描述，
   * 校验要靠它判断「够不够跟注」「加注额有没有到最小加注单位」。
   * allin 不带金额 —— 加多少由规则算（把手上的筹码全推出去），
   * 让模型自己报一个数，它就会报出超过自己筹码的数。
   */
  check: (label) => ({ type: 'check', label }),
  call: (amount, label) => ({ type: 'call', amount, label }),
  raise: (amount, label) => ({ type: 'raise', amount, label }),
  allin: (label) => ({ type: 'allin', label }),

  /** 破例动作统一走这个入口，kind 由规则包定义 */
  breach: (kind, extra = {}) => ({ type: 'breach', kind, ...extra }),
  endTurn: () => ({ type: TURN_END }),
};

/**
 * 「推进牌局」的动作类型 —— 也就是【真的改变了局势】的那些。
 *
 * 本地兜底策略（没有 API Key 时）只在这一类里取值：像「亮牌」这种
 * 不推进牌局的动作，测出来的胜率约等于「我最好的那一手」（因为算完它
 * 之后牌局照常由策略接着打），数字好看但一步都没走。照着数字挑，
 * 智能体会一直亮牌，牌局永远走不动。见 local-policy.js。
 */
export const ADVANCING_ACTIONS = new Set([
  'play', 'pass', 'hit', 'stand', 'double', 'split',
  'check', 'call', 'raise', 'allin',
]);

// ---------------------------------------------------------------------------
// 破例「销毁」的公共服务
// ---------------------------------------------------------------------------
// 三个玩法都要有这一条，而它的难点不在规则、在【信息边界】：
//   看得见的牌（自己的手牌、桌面已出的牌）→ 可以指定销毁哪一张；
//   看不见的牌（对手手里的暗牌）      → 只能「随机销毁他一张」，不能指定。
// 如果让 AI 指定对手暗牌的 id，它就能借这个动作反推出那张牌是什么 ——
// 销毁本身反而成了探针。所以候选里对看不见的牌【只给到人，不给到牌】。
//
// 目标到【执行那一刻】才落定，和抢牌是同一个道理：同种子同局面必得同一结果，
// 否则回放与自检都不成立。

/** 确定性抽一张（同种子 + 同事件数 + 同轮次 → 同结果） */
export function pickDeterministic(ids, state, salt = 7) {
  if (!Array.isArray(ids) || !ids.length) return null;
  const h = (state.seed >>> 0) + state.log.length * salt + (state.round | 0);
  return ids[h % ids.length];
}

/** 牌面文字（用于候选 label 与公示文案） */
function faceOf(state, cid) {
  const c = state.cards[cid];
  return c ? `${c.glyph}${c.label}` : '一张牌';
}

/**
 * 这张牌还能不能销毁。
 *
 * 通用底线只有两条 —— 都是「销毁之后规则会失去定义」的情形，
 * 不是平衡性调参，所以放在这里对所有玩法生效：
 *
 *   1. 牌不存在或已经销毁过 → 没什么可销毁的；
 *   2. 【某一手牌的最后一张不能销毁】。手牌空了之后，「这点数是多少」
 *      「还能不能出牌」「是不是已经赢了」全都没有定义；斗地主那边更直接 ——
 *      「手上没牌」就是胜利条件，销毁对手最后一张牌会把他送上胜利。
 *
 * 玩法特有的底线由规则包自己用 allow 钩子加（见 destroyCandidates）。
 */
export function destroyable(state, cid) {
  const c = state.cards[cid];
  if (!c || c.zone === 'void') return false;
  for (const p of state.players) {
    if (p.hand.includes(cid) && p.hand.length <= 1) return false;
  }
  return true;
}

/**
 * 生成「销毁」的破例候选。
 *
 * @param penalty 代价，由调用方定 —— 它随玩法的记分单位而变（分 / 注）
 * @param allowTable 是否允许销毁桌面已出的牌
 * @param allowShoe  是否允许盲烧牌堆（只有 21 点这类「牌堆还在」的玩法有）
 * @param allow      规则包自己的否决钩子 (state, cardId) => boolean。
 *                   通用底线（destroyable）管不到的东西在这里挡，
 *                   比如 21 点的庄家明牌 —— 毁掉它之后暗牌会顶到第一张，
 *                   而「第一张是明牌」是整套信息隔离的支点。
 */
export function destroyCandidates(state, playerId, opts = {}) {
  const { penalty = 1, allowTable = true, allowShoe = false, allow = null } = opts;
  const me = state.players.find((p) => p.id === playerId);
  if (!me) return [];
  const out = [];
  const cost = `代价 ${penalty}`;
  const okCard = (cid) => destroyable(state, cid) && (!allow || allow(state, cid));

  for (const cid of me.hand) {
    if (!okCard(cid)) continue;
    out.push(
      act.breach('destroy', {
        pick: 'card',
        cardId: cid,
        penalty,
        label: `销毁自己手上的 ${faceOf(state, cid)}（${cost}，全桌都会知道）`,
      })
    );
  }

  if (allowTable) {
    for (const c of Object.values(state.cards)) {
      if (c.zone !== 'table') continue;
      if (!okCard(c.id)) continue;
      out.push(
        act.breach('destroy', {
          pick: 'card',
          cardId: c.id,
          penalty,
          label: `销毁桌上已出的 ${c.glyph}${c.label}（${cost}，全桌都会知道）`,
        })
      );
    }
  }

  for (const other of state.players) {
    if (other.id === playerId || !other.alive || other.folded) continue;
    const targets = other.hand.filter(okCard);
    if (!targets.length) continue;
    out.push(
      act.breach('destroy', {
        pick: 'random',
        from: other.id,
        penalty,
        label: `销毁 ${other.name} 手上的一张牌（随机一张，你看不见是哪张；${cost}，全桌都会知道）`,
      })
    );
  }

  /**
   * 「牌堆顶上还有牌吗」—— 这是盲烧唯一的判据。
   *
   * 原来这里写的是 `phase === 'play'`，那是把某一个玩法的阶段名硬编码进了
   * 公共服务：比大小和 21 点的行动阶段恰好叫 'play'，所以一直没暴露；
   * 德州扑克把阶段叫 'bet'，于是它的盲烧候选【悄悄消失】了 ——
   * 不报错，只是那个选项不在菜单里，谁也看不出少了个东西。
   * 现在改成问「有没有一个可以烧的牌堆」，与 resolveDestroy 判 pick:'shoe'
   * 用的是同一条，两处不会再走偏。
   */
  if (allowShoe && state.ruleState && typeof state.ruleState.shoePos === 'number') {
    out.push(
      act.breach('destroy', {
        pick: 'shoe',
        penalty,
        label: `盲烧牌堆顶上的下一张（你不知道是哪张，翻开后全桌都看见；${cost}）`,
      })
    );
  }

  return out;
}

/**
 * 发起者能不能【认出】这张牌。
 *
 * 为什么需要这一条：投影对背面牌也保留 id（渲染层要靠它把牌位对上，
 * 见 view.js 的设计说明）。于是「指定卡 id」这条路是通的 ——
 * AI 完全可以在候选之外自己拼一个动作，点名销毁对手那张背面牌的 id。
 * 那条路不会泄露牌面，但它绕过了「看不见的牌只能随机」这条线：
 * 同样是销毁对手一张暗牌，「点名」是确定的，「随机」是赌的，
 * 两者的价值差得远，而差别只来自「能不能读到那个 id」。
 *
 * 判定标准：在自己手上（持有即可，看不看得见牌面无关），或者已经对全桌公开。
 * 其余一律只能走按人头随机的路径。
 */
export function identifiable(state, playerId, cid) {
  const c = state.cards[cid];
  if (!c) return false;
  const mine = state.players.find((p) => p.id === playerId);
  if (mine && mine.hand.includes(cid)) return true;
  return c.reveal && c.reveal.public === 'face';
}

/**
 * 把 destroy 破例动作解析成「到底销毁哪一张」。
 * validate 用它做合法性判断，apply 用它拿最终的牌 id —— 只有一份实现，
 * 免得两处对「随机」的理解走偏（一处随机、一处不随机就会各不相同）。
 */
export function resolveDestroy(state, playerId, action, opts = {}) {
  const allow = opts.allow || null;
  const okCard = (cid) => destroyable(state, cid) && (!allow || allow(state, cid));
  const me = state.players.find((p) => p.id === playerId);
  if (!me) return { ok: false, reason: `玩家 ${playerId} 不存在于此局` };
  const pick = action.pick || 'card';

  if (pick === 'card') {
    const cid = action.cardId;
    if (typeof cid !== 'string') return { ok: false, reason: '销毁动作必须指定要销毁哪张牌' };
    if (!destroyable(state, cid)) return { ok: false, reason: `牌 ${cid} 不存在、已经销毁过，或者是某人的最后一张牌` };
    if (!identifiable(state, playerId, cid)) {
      return { ok: false, reason: '你看不见这张牌，不能点名销毁 —— 只能按人头随机销毁一张' };
    }
    if (!okCard(cid)) return { ok: false, reason: '这张牌在本玩法里不能销毁' };
    return { ok: true, cardId: cid };
  }

  if (pick === 'random') {
    const victim = state.players.find((p) => p.id === action.from);
    if (!victim) return { ok: false, reason: `找不到目标玩家 ${action.from}` };
    if (victim.id === playerId) return { ok: false, reason: '要销毁对手的牌，请用「销毁自己的牌」那一项' };
    if (!victim.alive || victim.folded) return { ok: false, reason: `${victim.name} 已经不在局中了` };
    const targets = victim.hand.filter(okCard);
    if (!targets.length) return { ok: false, reason: `${victim.name} 手上没有牌可销毁` };
    // 抽哪一张由本地定，不由发起者定 —— 他看不见对方的手牌。
    const cardId = pickDeterministic(targets, state, 13);
    return { ok: true, cardId, random: true };
  }

  if (pick === 'shoe') {
    const rs = state.ruleState || {};
    if (typeof rs.shoePos !== 'number') {
      return { ok: false, reason: '这个玩法的牌堆不是「抽一张少一张」，没有牌堆顶可以烧' };
    }
    return { ok: true, cardId: null, shoe: true };
  }

  return { ok: false, reason: `未定义的销毁方式 ${pick}` };
}

/** 判断一个动作是不是「结束回合」标记 */
export function isEndTurnAction(action) {
  if (!action || typeof action !== 'object') return false;
  const t = String(action.type || '').toLowerCase().replace(/[^a-z]/g, '');
  return t === TURN_END;
}

export { TURN_END };

/** 动作 → 人类可读文本（用于记录与提示词） */
export function describeAction(action) {
  if (!action) return '（无动作）';
  switch (action.type) {
    case 'play':
      return `出牌 ${action.label || (action.cards || []).join(' ')}`;
    case 'reveal':
      return action.label || '调整可见性';
    // 这四个动作【优先用规则包给的 label】—— 因为它自带局面信息
    // （「要牌（当前 16 点）」「分牌（拆成两手 ♠8 / ♣8）」），
    // 而通用文案说不出这些。模型看到的候选列表就是这个函数拼出来的，
    // 所以 label 质量直接决定了模型知不知道自己在做什么选择。
    case 'hit':
      return action.label || '要牌';
    case 'stand':
      return action.label || '停牌';
    case 'double':
      return action.label || '双倍';
    case 'split':
      return action.label || '分牌';
    case 'check':
      return action.label || '看牌';
    case 'call':
      return action.label || '跟注';
    case 'raise':
      return action.label || '加注';
    case 'allin':
      return action.label || '全下';
    case 'breach':
      return `破例：${action.label || action.kind || '违规动作'}`;
    // 叫分也在候选表里出现过，而它一度落到 default 分支 ——
    // 于是界面上写的是「最后选择：未知动作 bid」。规则包本来就给了
    // label（「叫 3 分」/「不叫」），照用即可。
    case 'bid':
      return action.label || (action.score ? `叫 ${action.score} 分` : '不叫');
    case 'fold':
      return action.label || '认输';
    case 'pass':
      return `跳过${action.reason ? `（${action.reason}）` : ''}`;
    case TURN_END:
      return '结束回合';
    default:
      return `未知动作 ${action.type}`;
  }
}
