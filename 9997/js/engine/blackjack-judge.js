/**
 * blackjack-judge.js — 21 点的胜率评估官（精确解，零采样）
 *
 * 为什么这里不需要蒙特卡洛
 * ------------------------------------------------------------------
 * 蒙特卡洛（RolloutEngine）是为斗地主写的：斗地主一局的走法组合爆炸，
 * 只能从观察者视角把看不见的牌补全，随机撒很多个世界，一个个打完再统计。
 *
 * 21 点不用这么干。赢面由「接下来的补牌顺序」决定，而那个顺序可以
 * 被完整枚举 —— 庄家补到 17 点停是一条确定性规则，玩家要牌也只影响自己，
 * 所以每个候选动作的赢面是一个【可精确计算的数】。既然是数，就没有理由
 * 去采样它：采样只会把精确值换成一个带误差的估计。
 *
 * 引擎是按「动作 + 世界编号 → 这局赢没赢」的接口召回的。这里的实现
 * 对所有世界返回同一个值 —— 于是引擎平均出来的 wins/n 与 score/n
 * 恰好就是精确的赢面与期望分，方差为零，采样再多也不会变。
 *
 * 信息边界（这一条不能松）
 * ------------------------------------------------------------------
 * 未见牌堆由【观察者的投影】推出来：只有他看得见的牌才从整副牌里扣掉。
 * 所以每个座位算出来的胜率不同 —— 这不是不一致，是他们掌握的信息真的不同。
 * 绝不能用 rulesState 里的真实手牌去算，那等于让智能体凭空变准。
 *
 * 跨重洗的坑
 * ------------------------------------------------------------------
 * 一副牌用完会重洗，而重洗意味着「刚才出过的那些牌又全都回来了」。
 * 如果不区分牌堆，观察者看过的牌会一手一手地累加，算到第五手时
 * 「未见牌堆」会被扣成负数，而引擎只会看到一张数字很漂亮的表。
 * 所以牌 id 上带了牌堆编号，计数只统计【当前这一副】里的牌。
 * ------------------------------------------------------------------
 */

import { evaluateHand, unseenCounts } from '../rules/blackjack/exact.js';
import { countTotal, FULL_COUNTS } from '../rules/blackjack/hand.js';

/** 牌 id → 牌堆编号。opaqueDeck 的 salt 就是「第几副」（从 1 起） */
const SHOE_TAG = (shoeNo) => `s${(Number(shoeNo) || 0) + 1}`;

/**
 * 观察者视角下的未见牌堆（只算当前这一副）。
 *
 * 看得见的牌有三个来源，缺一个都会把牌数算多：
 *   · 我自己手牌里朝向为正面的；
 *   · 别人手牌里【已经对全桌亮出】的（庄家明牌走的就是这条）；
 *   · 桌面上已经摊开的（上一手结算摊牌摊出来的）。
 * 按 id 去重 —— 一张牌可能同时出现在手牌区和公开列表里。
 *
 * 还有一类牌要从「未见牌堆」里扣掉，而且它比上面三条更容易漏：
 * 【已经被销毁的牌】。销毁掉的牌不在任何人的视线里，如果不专门告诉这里，
 * 它就会被当成「还没发」—— 于是引擎在一个只剩 51 张的真实牌堆上，
 * 按 52 张去枚举接下来的补牌顺序。症状是所有胜率一起轻微偏掉，不报错，
 * 数字还都很像样。所以 view.burned 必须并进扣减集合。
 */
export function unseenFromView(view, shoeNo) {
  const tag = SHOE_TAG(shoeNo);
  const seen = new Set();
  const ranks = [];
  const take = (c) => {
    if (!c || typeof c.id !== 'string' || seen.has(c.id)) return;
    if (!String(c.id).startsWith(tag)) return;
    if (c.facing !== 'face' || typeof c.rank !== 'number') return;
    seen.add(c.id);
    ranks.push(c.rank);
  };

  for (const seat of view.seats || []) {
    for (const c of seat.hand || []) take(c);
  }
  for (const c of view.table || []) take(c);
  for (const c of view.exposed || []) take(c);

  // 已销毁的牌：只算【当前这一副】的（跨重洗后，上一副烧掉的牌跟这一副无关）
  const burnedSeen = new Set();
  const burnedRanks = [];
  for (const c of view.burned || []) {
    if (!c || typeof c.id !== 'string' || burnedSeen.has(c.id)) continue;
    if (!String(c.id).startsWith(tag)) continue;
    if (typeof c.rank !== 'number') continue;
    burnedSeen.add(c.id);
    burnedRanks.push(c.rank);
  }

  return {
    counts: unseenCounts([...ranks, ...burnedRanks]),
    seenOffShoe: ranks.length,
    burnedOffShoe: burnedRanks.length,
    visible: seen.size,
  };
}

/** 候选动作 → 引擎里的那一栏 */
const STAT_OF = { hit: 'hit', stand: 'stand', double: 'double', split: 'split' };

const NOTE = {
  double: '双倍已经把注翻成 2 注：赢了收两倍，输了也输两倍，上面的期望分按 2 注算过了。',
  split: '分牌之后是两手各自结算，总注变成 2 注；上面的期望分已经是两手的合计。',
  hit: '要牌有爆牌的风险，期望分里已经扣掉了爆掉的那一部分。',
  stand: '停牌之后你的点数就定了，剩下的全看庄家补到什么。',
};

/**
 * @returns 引擎要的评估官对象。
 *   构造阶段就会把精确值算好（第一次约十几毫秒，之后走记忆表），
 *   所以 run() 是常数时间 —— 引擎想采样多少次都不会变慢，也永远不会变数。
 */
export function createBlackjackJudge({
  view, selfId, ruleSet, ruleState = {}, seed = 0, simPolicy = 'smart',
}) {
  const rs = ruleState || {};
  const hands = Array.isArray(rs.hands) ? rs.hands : [];
  const hand = hands.find((h) => h && h.ownerId === selfId) || null;
  const dealer = rs.dealer && rs.dealer.hand ? rs.dealer.hand : null;

  if (!hand || !Array.isArray(hand.ranks) || !hand.ranks.length) {
    // 抛出去而不是返回空表：引擎会把异常转成「局面无法补全：<这句话>」，
    // 让候选行显示真正的原因，而不是一句笼统的「没有采到有效样本」。
    throw new Error(`在你（${selfId}）名下找不到正在行动的手牌，无法算出精确胜率`);
  }
  if (!dealer || !dealer.ranks || !dealer.ranks.length) {
    throw new Error('庄家还没有牌（明牌未知），无法算出精确胜率');
  }

  const upRank = dealer.ranks[0];
  const { counts, visible, burnedOffShoe } = unseenFromView(view, rs.shoeNo);

  // 纸牌守恒：当前这副牌里看得见的那部分不可能超过一副牌。
  // 这只是个下限检查 —— 真正的保证来自「计数只统计当前牌堆」这条规则。
  const left = countTotal(counts);
  const balanced = left >= 0 && left <= 52
    && counts.every((c, i) => c <= FULL_COUNTS[i]);

  const stats = balanced
    ? evaluateHand({
      ranks: hand.ranks,
      upRank,
      counts,
      infinite: false,
      peek: true,
      allowDouble: true,
      allowSplit: true,
    })
    : null;

  let lastReason = '';

  return {
    id: 'blackjack-exact',
    /** 精确解：没有「补全的牌局」这回事，纸牌守恒由未见牌堆的构造保证 */
    balanced,
    /**
     * 声明自己是精确解。引擎据此【跳过铺量与加深】：那些阶段存在的意义是
     * 「多采几局把估计变准」，而对一个可精确计算的数，重算一百遍只会得到
     * 同一个数（实测一个决策 430ms 里有 429ms 在重复求值）。声明之后
     * 每个候选只求一次，决策回到 1ms 量级，而数字一个比特都不会变。
     */
    exact: true,
    phase: 'play',
    /** 决定「哪个动作更好」的度量。见 winrate.js 的说明：
     *  21 点必须按期望分排 —— 双倍/分牌的注是 2 注，赢面高不等于划算。 */
    metric: 'ev',
    /** 这里没有「对手强度」这一档：庄家的打法被规则写死了（17 停） */
    simPolicy: 'dealer-fixed',
    selfId,
    upRank,
    shoeNo: rs.shoeNo | 0,

    get lastReason() {
      return lastReason;
    },

    run(action, world) {
      const key = STAT_OF[action && action.type];
      if (!key) {
        lastReason = `「${action && action.type}」不是牌面动作，精确引擎算不出它的价值`;
        return null;
      }
      if (!stats) {
        lastReason = '未见牌堆不自洽，本次不出数';
        return null;
      }
      const s = stats[key];
      if (!s) {
        lastReason = `这一手现在做不了「${key}」（点数或牌数不允许）`;
        return null;
      }
      /**
       * pWin 是【赢面】，score 是【期望分】。两个都给，是因为它们回答的是
       * 两个不同的问题：赢面说「这一手有多大概率赢」，期望分说「这一手平均
       * 值多少钱」。双倍和分牌会把注翻倍，两者的排序就会分叉 ——
       * 排序用哪个由 metric 声明，不猜。
       */
      return { pWin: s.win, score: s.ev, won: s.win >= 0.5 };
    },

    noteFor(action) {
      const key = STAT_OF[action && action.type];
      return key ? NOTE[key] : '';
    },

    /** 调试/自检用：把这一次算出来的原件摊开 */
    snapshot() {
      // burnedOffShoe 单独报出来：未见牌堆少了几张，原因有两个
      // （看得见 vs 被销毁），混在一起看会分不清牌是「露出来了」还是「没了」。
      return {
        upRank,
        ranks: [...hand.ranks],
        visible,
        burnedOffShoe,
        left,
        counts: [...counts],
        stats,
      };
    },
  };
}
