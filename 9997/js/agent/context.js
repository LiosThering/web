/**
 * context.js — 上下文装配（历史记录）
 *
 * 按既定方案：历史里【不保留】任何胜率数据，只保留
 *   1. 牌桌上出过哪些牌
 *   2. 所有角色说过什么话
 * 且这两类事件按时间顺序交织成一条统一的记录。
 *
 * 压缩策略
 * ------------------------------------------------------------------
 * 出牌事件 —— 全量保留（本身就是记牌器，体量很小）
 * 发言事件 —— 【全量保留】，不做窗口裁剪
 *
 * 关于发言全量保留：
 *   默认 speechWindow = 'all'、maxSpeechChars = Infinity，
 *   也就是一条都不丢。这两个开关仍然保留，是为了留出后路 ——
 *   真到了上下文撑不住的时候，把 maxSpeechChars 设成一个数值
 *   就能从最旧的一端开始裁剪，不必改代码。
 *   裁剪始终从【最旧】的一端砍，保证最近的对话一定在。
 */

export const DEFAULT_CONTEXT_POLICY = {
  /** 发言保留条数；'all' 表示全量保留（默认） */
  speechWindow: 'all',
  /** 发言记录总长度上限（字符）。Infinity 表示不裁剪 */
  maxSpeechChars: Infinity,
  /** 是否把可见性调整写进记录（信息操作，有策略含义） */
  includeReveal: true,
  /** 是否把得分写进记录 */
  includeScore: true,
  /** 是否把破例（违规）行为写进记录 —— 全桌都会知道，必须保留 */
  includeBreach: true,
};

function shortId(view, id) {
  const s = view.seats.find((x) => x.id === id);
  return s ? s.name : id;
}

/**
 * 把投影后的事件流整理成一条带顺序的时间线。
 */
export function buildTimeline(view, { policy = {} } = {}) {
  const p = { ...DEFAULT_CONTEXT_POLICY, ...policy };
  const events = view.events || [];

  const cardLabel = (cid) => {
    const pool = [...(view.table || []), ...(view.exposed || [])];
    const c = pool.find((x) => x.id === cid);
    return c && c.facing === 'face' ? `${c.glyph}${c.label}` : '一张牌';
  };

  const speechSeqs = new Set();
  if (p.speechWindow !== 'all') {
    const speeches = events.filter((e) => e.type === 'speak');
    const kept = speeches.slice(-Math.max(0, p.speechWindow));
    let chars = 0;
    const allowed = [];
    for (let i = kept.length - 1; i >= 0; i--) {
      chars += (kept[i].payload?.text || '').length;
      if (chars > p.maxSpeechChars) break;
      allowed.push(kept[i].seq);
    }
    for (const s of allowed) speechSeqs.add(s);
  }

  const entries = [];
  let droppedSpeeches = 0;

  for (const e of events) {
    const who = e.actorId ? shortId(view, e.actorId) : '系统';
    switch (e.type) {
      case 'speak': {
        if (p.speechWindow !== 'all' && !speechSeqs.has(e.seq)) {
          droppedSpeeches++;
          break;
        }
        entries.push({ kind: 'speech', seq: e.seq, who, text: e.payload?.text || '' });
        break;
      }
      case 'play': {
        entries.push({
          kind: 'play',
          seq: e.seq,
          who,
          cards: (e.payload?.cardIds || []).map(cardLabel),
        });
        break;
      }
      case 'discard': {
        entries.push({
          kind: 'discard',
          seq: e.seq,
          who,
          cards: (e.payload?.cardIds || []).map(cardLabel),
        });
        break;
      }
      case 'showdown': {
        // 一手牌打完摊开。牌面是公开信息，所以直接列出来 ——
        // 它同时就是记牌器的一条输入（「这手出过哪些牌」）。
        entries.push({
          kind: 'showdown',
          seq: e.seq,
          who,
          cards: (e.payload?.cardIds || []).map(cardLabel),
        });
        break;
      }
      case 'private': {
        // 只发给这一个观察者
        entries.push({ kind: 'private', seq: e.seq, text: e.payload?.text || '' });
        break;
      }
      case 'reveal': {
        if (!p.includeReveal) break;
        entries.push({
          kind: 'reveal',
          seq: e.seq,
          who,
          text: e.payload?.text || '调整了自己一张牌的可见性',
        });
        break;
      }
      case 'breach': {
        if (!p.includeBreach) break;
        entries.push({ kind: 'breach', seq: e.seq, who, text: e.payload?.text || '做了规则不允许的事' });
        break;
      }
      case 'transfer': {
        // 牌易主只给当事双方看：拿到的人知道拿到了什么，
        // 失去的人知道少了什么；其余人只知道「发生过一次抢夺」。
        const { fromId, toId, label } = e.payload || {};
        const viewer = view.viewerId;
        let text;
        if (toId === viewer) {
          text = fromId ? `你从 ${shortId(view, fromId)} 那里拿到了 ${label}` : `你拿到了 ${label}`;
        } else if (fromId === viewer) {
          text = `${shortId(view, toId)} 把你的 ${label} 拿走了`;
        } else {
          text = `${label} 换了主人`;
        }
        entries.push({ kind: 'transfer', seq: e.seq, who, text });
        break;
      }
      case 'reject': {
        entries.push({
          kind: 'reject',
          seq: e.seq,
          who,
          text: `想做的事被本地规则拒绝了（${e.payload?.reason || '不合法'}）`,
        });
        break;
      }
      case 'score': {
        if (!p.includeScore) break;
        entries.push({ kind: 'score', seq: e.seq, who, delta: e.payload?.delta ?? 0 });
        break;
      }
      case 'fold':
        entries.push({ kind: 'fold', seq: e.seq, who });
        break;
      case 'pass':
        entries.push({ kind: 'pass', seq: e.seq, who });
        break;
      case 'round:start':
        entries.push({ kind: 'round', seq: e.seq, round: e.payload?.round });
        break;
      case 'announce':
        entries.push({
          kind: 'announce',
          seq: e.seq,
          who,
          text: e.payload?.text || '',
          tone: e.payload?.kind || 'info',
        });
        break;
      default:
        break;
    }
  }

  return { entries, droppedSpeeches, policy: p };
}

/** 把时间线渲染成提示词里的文本块 */
export function renderTimeline(timeline) {
  if (!timeline.entries.length) return '（本局尚未发生任何事）';

  const lines = timeline.entries.map((e) => {
    switch (e.kind) {
      case 'round':
        return `— 第 ${e.round} 轮开始 —`;
      case 'speech':
        return `${e.who}：${e.text}`;
      case 'play':
        return `${e.who} 出牌 ${e.cards.join(' ')}`;
      case 'reveal':
        return `${e.who} ${e.text}`;
      case 'breach':
        return `【破例】${e.who} ${e.text}`;
      case 'transfer':
        // 文本自带主语（「你拿到了 X」/「Y 把你的 X 拿走了」），
        // 前面再挂一次说话人会变成「你：你拿到了 X」。
        return e.text;
      case 'reject':
        return `${e.who} ${e.text}`;
      case 'score':
        return `${e.who} 得 ${e.delta} 分`;
      case 'fold':
        return `${e.who} 认输退出`;
      case 'pass':
        return `${e.who} 过牌`;
      case 'discard':
        return `${e.who} 甩掉了 ${e.cards.join(' ')}`;
      case 'showdown':
        return `${e.who} 亮牌 ${e.cards.join(' ')}`;
      case 'private':
        return `【只有你知道】${e.text}`;
      case 'announce':
        return e.who && e.who !== '系统' ? `${e.who}：${e.text}` : `【公告】${e.text}`;
      default:
        return '';
    }
  });

  const head = timeline.droppedSpeeches > 0
    ? `（更早的 ${timeline.droppedSpeeches} 条发言已省略）\n`
    : '';

  return head + lines.filter(Boolean).join('\n');
}
