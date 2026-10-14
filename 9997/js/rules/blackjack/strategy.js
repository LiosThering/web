/**
 * strategy.js — 最优策略表：从精确期望值反推出来，而不是抄来的
 *
 * 这张表是【算出来的】：对每一个「我的手牌 × 庄家明牌」的组合，
 * 让 exact.js 把要牌 / 停牌 / 双倍 / 分牌 四个动作的精确期望都算一遍，
 * 取最高的那个。所以它不是一个需要维护的常量表 ——
 * 它是一份【可以随时重算、并和教科书对拍】的产物。
 *
 * 为什么要对拍
 * ------------------------------------------------------------------
 * 「自己推出来的表和全世界公认的表一致」这件事本身就是最强的正确性证据：
 * 300 多格全部独立命中，几乎不可能是巧合。反过来说，如果差了一大片，
 * 那八成是我的枚举或结算写错了 —— 而不是全世界都错了。
 *
 * 对拍用的教科书口径必须和引擎的模型对齐，否则差异全是噪声：
 *   牌堆  → infinite（教科书假设无限牌堆，抽牌放回）
 *   偷看  → peek（教科书表默认美式规则：庄家 A/10 时先看暗牌）
 *   分牌后双倍 → 允许（DAS，绝大多数现代牌桌）
 *   庄家软 17 → 停（S17）
 * 这四项里任何一项改了，表都会变 —— 尤其 peek，它会把「11 对 10」
 * 从要牌翻成双倍。所以差异不能靠肉眼忽略，要么对齐口径，要么写进文档。
 * ------------------------------------------------------------------
 */

import { evaluateHand, unseenCounts } from './exact.js';
import { faceValue, handTotal, isPair } from './hand.js';

/**
 * 庄家明牌的取值轴 —— 用【面值】，11 代表 A。
 *
 * 注意别把它直接当牌面点数传给引擎：牌面里 A 是 14，
 * 而面值 11 在牌面里是 J。这里混过一次，后果是整整一列
 * 「对 A」被当成「对 J」算 —— 而 J 和 A 都是 10 点起手，
 * 很多格子碰巧一致，只有 11 对 A 这种格子会露馅。
 * 所以下面统一用 upRankOf 转换，不在调用点手写。
 */
export const UPCARDS = [2, 3, 4, 5, 6, 7, 8, 9, 10, 11];

/** 面值 → 牌面点数（11 → 14） */
const upRankOf = (v) => (v === 11 ? 14 : v);

/** 动作 → 教科书表里的单字母 */
export const LETTER = { stand: 'S', hit: 'H', double: 'D', split: 'P' };

/** 单字母 → 中文，打印差异时用 */
export const ACTION_NAME = { S: '停牌', H: '要牌', D: '双倍', P: '分牌' };

/** 庄家明牌面值 → 列下标 */
const upIndex = (v) => UPCARDS.indexOf(v);

/**
 * 生成一张策略表。
 *
 * @returns {{ hard, soft, pair, model }}
 *   hard[总点数][明牌下标] = { action:'stand'|'hit'|'double', ev }
 *   soft[总点数][明牌下标] = 同上（软手不会分牌）
 *   pair[对子面值][明牌下标] = { action, ev }（含分牌）
 *
 * 每个点数用的代表牌型：
 *   硬 5..11  → 用 [总点数-2, 2]   例如硬 9 = [7,2]
 *   硬 12..20 → 用 [10, 总点数-10] 例如硬 16 = [10,6]
 *   软 13..20 → 用 [A, 总点数-11]
 *   硬 21 不在表里 —— 两张牌凑成 21 一定是天然 21 点（A + 10），
 *   它没有「该不该要牌」这个问题，赔率也不一样，不混进这张表。
 */
export function buildTable({ infinite = true, peek = true } = {}) {
  const model = { infinite, peek };

  /**
   * 一格一算。
   *
   * 有限牌堆口径下，每格都必须从【只剩这些牌】的真实牌堆出发：
   * 一副 52 张，扣掉我这两张、扣掉庄家明牌。传 null 会直接崩，
   * 所以这里统一走 unseenCounts —— 建表和真实对局用的必须是同一个
   * 「未见牌堆」的定义，否则两边算出来的策略会悄悄不一样。
   */
  const cell = (ranks, up, allowSplit = true) => {
    const upRank = upRankOf(up);
    const counts = infinite ? null : unseenCounts([...ranks, upRank]);
    const r = evaluateHand({
      ranks, upRank, counts, infinite, peek, allowSplit, allowDouble: true,
    });
    return { action: r.best.action, ev: r.best.ev };
  };

  const hard = {};
  for (let total = 5; total <= 20; total++) {
    const ranks = total <= 11 ? [total - 2, 2] : [10, total - 10];
    hard[total] = UPCARDS.map((up) => cell(ranks, up));
  }

  const soft = {};
  for (let total = 13; total <= 20; total++) {
    const ranks = [14, total - 11];
    soft[total] = UPCARDS.map((up) => cell(ranks, up, false));
  }

  const pair = {};
  for (const v of [2, 3, 4, 5, 6, 7, 8, 9, 10, 11]) {
    const rank = v === 11 ? 14 : v;
    pair[v] = UPCARDS.map((up) => cell([rank, rank], up));
  }

  return { hard, soft, pair, model };
}

/**
 * 把任意手牌映射到表里的一行，并给出该动作。
 *
 * 用途：没有 API Key 时的本地兜底（也就是不开胜率引擎时的自动牌手）。
 * 手里 ≥3 张牌时不可能再双倍或分牌，所以只落在 hard / soft 两栏里。
 *
 * @param ranks   手牌点数
 * @param upRank  庄家明牌点数
 * @returns {{ row:string, action:string, ev:number }|null}
 */
export function lookupTable(table, ranks, upRank) {
  /**
   * 明牌从「牌面点数」翻到「面值」，才能对上 UPCARDS 这条轴。
   *
   * 这一步【只有 A 需要特殊处理】是一种很容易犯的错觉：J/Q/K 的牌面点数
   * 是 11/12/13，面值却都是 10。漏了它们，upIndex 会返回 -1，
   * 整列「对 J/Q/K」查不到格子 —— 而调用方（本地牌手的兜底）拿到 null
   * 就会退成「停牌」，于是庄家一亮出人头牌，本地牌手就一手都不补。
   * 不报错、还能打完全局，只有翻牌时才发现自己一直在 12 点停牌。
   * faceValue 正好就是这个映射，所以直接用，不手写。
   */
  const v = upRank >= 2 && upRank <= 14 ? faceValue(upRank) : null;
  const col = v === null ? -1 : upIndex(v);
  if (col < 0) return null;

  const t = handTotal(ranks);
  if (isPair(ranks)) {
    const pv = ranks[0] === 14 ? 11 : Math.min(ranks[0], 10);
    const cell = table.pair[pv]?.[col];
    if (cell) return { row: `pair:${pv}`, action: cell.action, ev: cell.ev };
  }
  if (t.soft && t.total >= 13 && t.total <= 20) {
    const cell = table.soft[t.total]?.[col];
    if (cell) return { row: `soft:${t.total}`, action: cell.action, ev: cell.ev };
  }
  const clamped = Math.max(5, Math.min(20, t.total));
  const cell = table.hard[clamped]?.[col];
  if (cell) {
    // 硬 21 及以上落到「永远停牌」那一行；爆牌的判断在规则包里已经做过了
    return { row: `hard:${clamped}`, action: t.total > 20 ? 'stand' : cell.action, ev: cell.ev };
  }
  return null;
}

// ---------------------------------------------------------------------------
// 教科书基本策略表（用于对拍，不用于出牌）
// ---------------------------------------------------------------------------

/**
 * 教科书表（多副牌 S17 / DAS，与 buildTable 的默认口径对齐）。
 * 每行 10 个字母，从左到右对应明牌 2,3,4,5,6,7,8,9,10,A。
 *
 * 这张表只在这里出现一次，用途只有一个：和算出来的表对拍。
 * 出牌永远走引擎 —— 免得「表的出处」和「表的用法」混在一起，
 * 将来改了规则却忘了改这张手抄表。
 */
export const TEXTBOOK = {
  hard: {
    5: 'HHHHHHHHHH',
    6: 'HHHHHHHHHH',
    7: 'HHHHHHHHHH',
    8: 'HHHHHHHHHH',
    9: 'HDDDDHHHHH',
    10: 'DDDDDDDDHH',
    11: 'DDDDDDDDDH',
    12: 'HHSSSHHHHH',
    13: 'SSSSSHHHHH',
    14: 'SSSSSHHHHH',
    15: 'SSSSSHHHHH',
    16: 'SSSSSHHHHH',
    17: 'SSSSSSSSSS',
    18: 'SSSSSSSSSS',
    19: 'SSSSSSSSSS',
    20: 'SSSSSSSSSS',
  },
  soft: {
    // A,2 / A,3 只在明牌 5、6 时双倍；明牌 4 要牌。这一格各家的表印得不一致，
    // 但多副牌 S17 / DAS 的主流口径是「5、6 才双倍」。
    13: 'HHHDDHHHHH',
    14: 'HHHDDHHHHH',
    15: 'HHDDDHHHHH',
    16: 'HHDDDHHHHH',
    17: 'HDDDDHHHHH',
    18: 'SDDDDSSHHH',
    19: 'SSSSSSSSSS',
    20: 'SSSSSSSSSS',
  },
  pair: {
    2: 'PPPPPPHHHH',
    3: 'PPPPPPHHHH',
    4: 'HHHPPHHHHH',
    5: 'DDDDDDDDHH',
    // 6,6 只对到明牌 6 为止；对 7 开始要牌
    6: 'PPPPPHHHHH',
    7: 'PPPPPPHHHH',
    8: 'PPPPPPPPPP',
    9: 'PPPPPSPPSS',
    10: 'SSSSSSSSSS',
    11: 'PPPPPPPPPP',
  },
};

/**
 * 对拍：把算出来的表和教科书表逐格比。
 *
 * @returns {{ total, agreed, rate, diffs:[{row, up, mine, book}] }}
 *   差异【不抛异常】—— 它是一份要读的数据，不是一条要炸的断言。
 *   因为「差在哪」本身就是结论（比如软 18 对 2 这一格，各家印的表
 *   本来就不一致），把它变成红叉只会让人把它删掉。
 */
export function compareToTextbook(table) {
  const diffs = [];
  let total = 0;
  let agreed = 0;

  const walk = (kind) => {
    for (const [key, rowStr] of Object.entries(TEXTBOOK[kind])) {
      for (let i = 0; i < UPCARDS.length; i++) {
        const cell = table[kind][Number(key)]?.[i];
        if (!cell) continue;
        total++;
        const mine = LETTER[cell.action];
        const book = rowStr[i];
        if (mine === book) agreed++;
        else diffs.push({ row: `${kind}:${key}`, up: UPCARDS[i], mine, book });
      }
    }
  };
  walk('hard');
  walk('soft');
  walk('pair');

  return { total, agreed, rate: total ? agreed / total : 0, diffs };
}

/** 把一行格子打印成可读的一行（自检与文档都用它） */
export function formatRow(cells) {
  return cells.map((c) => LETTER[c.action] || '?').join('');
}
