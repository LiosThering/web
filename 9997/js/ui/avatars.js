/**
 * avatars.js — 形象库（素材层）
 *
 * 这一层只回答一个问题：**长什么样**。
 * 它不认识「谁」，也不知道谁上场 —— 那是名册（roster.js）的事。
 *
 * 为什么要拆成两层
 * ------------------------------------------------------------------
 * 上一版把形象和座位焊死在一条配置里（`TABLES[].chars = ['char-1-qianke', …]`），
 * 后果是形象不可选、名字不可改、没法「选谁和你玩」、更没法导入导出。
 * 现在：
 *
 *   AVATARS   形象库 —— 素材。一项就是一张立绘图 + 它的宽高比。
 *   roster    名册   —— 选手。可增删改、能导入导出，每人**指向**形象库里的一项。
 *
 * 于是「同一个形象派给两个智能体」是允许的（可能是刻意的，只是桌面会认错人），
 * 而「换个形象不改名字」「改名字不动形象」都成了自然结果。
 *
 * 导出名册时只带形象 **id**、不带图：文件小，且换机可用（前提是对方也有这几张）。
 * 所以路径与宽高比必须写在一处，画面和导出清单才不会各说各话。
 */

/** 素材根目录。裸 file:// 打开页面时相对图会加载失败，用 tools/dev-server.mjs 起服务。 */
export const ASSET_BASE = 'design/assets/';

/**
 * aspect = 宽 ÷ 高。
 * 立绘一律按「高度定死、宽度按比例算」摆放（人站在桌面上，脚底对齐、身高一致），
 * 少了它就只能拉变形 —— 八个角色的画幅差得很远：老千 0.517、仙子 0.837。
 *
 * 加新形象：概念图进 design/concepts/ → 跑 tools/prep-assets.py（它会出 png + webp）
 * → 把 manifest.json 里的 size 抄成这里的 aspect。**file 必须指向真实存在的文件**：
 * <img> 拿 404 不抛异常也不报错，只是那一块永远空白（女仆的 nvpv 就踩过这个坑）。
 */
export const AVATARS = {
  'char-1-qianke': {
    label: '老千',
    file: 'char-1-qianke.webp',
    aspect: 397 / 768,
  },
  // 注意是 nvpv 不是 npv —— 磁盘上的文件就叫这个名。
  // 少一个 v 时 <img> 拿 404 不抛异常、不报 console 错，只是那一块永远空白，
  // 于是「女仆从来没显示出来过」而每一轮看图都像正常。以磁盘上的文件名为准。
  'char-2-nvpv': {
    label: '女仆',
    file: 'char-2-nvpv.webp',
    aspect: 416 / 768,
  },
  'char-3-pixel-heitao-wangzi': {
    label: '黑桃王子',
    file: 'char-3-pixel-heitao-wangzi.webp',
    aspect: 464 / 657,
  },
  // ↓ 以下五位 2026-10-14 加，与上面三位同一批（动漫 chibi 手绘、灰底、身高归一 768）。
  // 形象 id 里的序号只是**出厂顺序**（跟 concepts 的文件名一一对应），
  // 不代表它们在界面上的排序 —— 界面顺序一律按名册走。
  'char-5-gongzhu': {
    label: '公主',
    file: 'char-5-gongzhu.webp',
    aspect: 477 / 768,
  },
  'char-6-qishi': {
    label: '骑士',
    file: 'char-6-qishi.webp',
    aspect: 433 / 768,
  },
  'char-7-wangzi': {
    label: '王子',
    file: 'char-7-wangzi.webp',
    aspect: 442 / 768,
  },
  'char-8-kulou': {
    label: '骷髅',
    file: 'char-8-kulou.webp',
    aspect: 481 / 768,
  },
  // 仙子最宽（0.837）：立绘里含一对展开的翅膀，裁到包围盒后横向就铺开了。
  // 它跟别的立绘一样是「高度定死」，所以桌面上会显得比旁人宽一圈 —— 这是图本身的样子。
  'char-9-xianzi': {
    label: '仙子',
    file: 'char-9-xianzi.webp',
    aspect: 643 / 768,
  },
};

export const AVATAR_IDS = Object.keys(AVATARS);
export const DEFAULT_AVATAR = AVATAR_IDS[0];

/** 形象 → 立绘图地址 */
export function avatarUrl(id) {
  const a = AVATARS[id] || AVATARS[DEFAULT_AVATAR];
  return ASSET_BASE + a.file;
}

/**
 * 座位还没有配智能体时用的剪影。
 * 真前端里「座位空着」是合法状态（人多于名册可选的人），要画得出来。
 */
export const DEFAULT_SEAT_URL = ASSET_BASE + 'default-seat.png';

/**
 * 桌面底图。按人数挑一张：四个人比三个人多占一整排，垂直方向就那么点地方，
 * 四人底图本身留白更宽。
 *
 * 注意这图是**俯视**的 —— 这里只当「桌面图案」用。
 * 俯视地图 + 正面立牌是棋盘游戏的通用解法（棋盘上的单位也都正面朝向玩家）。
 */
export function tableUrl(players) {
  return ASSET_BASE + (players >= 4 ? 'table-4p.webp' : 'table-3p.webp');
}

/** 底图的原始尺寸，cover 铺满时要用 */
export const TABLE_IMG = { w: 1536, h: 1024 };
