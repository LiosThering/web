/**
 * lobby.js — 启动层：选模式 → 选谁和你玩 → 进牌桌
 *
 * 为什么要有这一层
 * ------------------------------------------------------------------
 * 开局前有两件事要定，而且是两件不同的事：
 *   ① 玩什么、几个人 —— 由规则包决定（斗地主 3-4 人、21 点固定 2 人……）
 *   ② 谁和你玩 —— 由**名册**决定，每个人还带着自己的名字、形象、人设
 * 原来的界面把这两件事揉在侧栏的下拉框里，而且「谁」根本不存在（形象和座位焊死了）。
 * 拆出来之后，「选谁和你玩」才有一个能站住的位置。
 *
 * 视觉上这一层是**纯黑**的：黑底、白字、留白大、按钮就是唯一的视觉元素。
 * 局内那套东西（顶栏、牌桌、抽屉把手）在启动层里一律让位 ——
 * 局还没开，它们就不该出现。
 *
 * 这一层只管「选」，不碰对局状态；选定之后把结果交给 onStart，
 * 由 app.js 去建 state。所以它可以单独被测试脚本驱动。
 */

import { listRuleSets } from '../core/rules.js';
import { avatarUrl } from './avatars.js';
import {
  AVATARS, AVATAR_IDS, DEFAULT_AVATAR, activeAgents, addAgent, downloadJson,
  getRoster, onRosterChange, parseRosterText, prunePicked,
  removeAgent, rosterKey, rosterPayload, setRoster, takeSeedNotice, updateAgent,
} from './roster.js';

const $ = (id) => document.getElementById(id);

const COUNT_WORD = { 1: '单人局', 2: '二人局', 3: '三人局', 4: '四人局', 5: '五人局', 6: '六人局' };
const countWord = (n) => COUNT_WORD[n] || `${n} 人局`;

function el(tag, cls, html) {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (html != null) d.innerHTML = html;
  return d;
}

/**
 * @param {object} opts
 * @param {(sel:{rsId:string, players:number, agents:Array}) => void} opts.onStart
 * @param {(msg:string) => void} [opts.onToast]
 */
export function initLobby({ onStart, onToast }) {
  const toast = onToast || (() => {});
  // 排序：主力玩法在前。注册顺序由模块导入顺序决定，跟"哪个是主打"没关系，
  // 所以这里显式排一遍，别让大厅的第一张卡随打包顺序变。
  const PREFER = ['doudizhu', 'blackjack', 'holdem', 'highcard'];
  const rulesets = listRuleSets().slice().sort((a, b) => {
    const ia = PREFER.indexOf(a.id);
    const ib = PREFER.indexOf(b.id);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  const st = {
    scene: 'lobby',
    rsId: rulesets[0]?.id || '',
    players: 3,
    picked: [],
  };

  // 名册里补进了默认人物、或默认人设的文案更新了，都要说一声。用户的名册里
  // 凭空多出五个人、或者某个人的设定被换掉，却什么也不说，他只能以为是自己
  // 点错了或者被人改过 —— 「兜底可以兜，但不许静默」。
  // 读一次就清空（takeSeedNotice 的语义），所以只会在真正动过的那一次出现。
  // 两件事可能同时发生（老存档第一次打开），合成一条说，别连弹两条。
  const seededIn = takeSeedNotice();
  {
    const bits = [];
    if (seededIn.added.length) {
      bits.push(`补上了 ${seededIn.added.length} 位默认人物`
        + `（${seededIn.added.map((a) => a.name).join('、')}）`);
    }
    if (seededIn.updated.length) {
      bits.push(`更新了 ${seededIn.updated.length} 位默认人物的设定文案`
        + `（${seededIn.updated.map((a) => a.name).join('、')}）`);
    }
    if (bits.length) toast(`名册有更新：${bits.join('；')}`);
  }

  // -------------------------------------------------------------------------
  // 场景
  // -------------------------------------------------------------------------
  function setScene(name) {
    st.scene = name;
    document.body.classList.remove('scene-lobby', 'scene-pick', 'scene-table');
    document.body.classList.add('scene-' + name);
    if (name === 'lobby') renderLobby();
    if (name === 'pick') renderPick();
  }

  function ruleSetOf(id) {
    return rulesets.find((r) => r.id === id) || rulesets[0] || null;
  }

  function need() {
    return Math.max(0, st.players - 1);
  }

  /** 点进某个玩法时先落在哪一档人数：不写死，按规则包的范围取中间那个 */
  function defaultPlayers(rs) {
    const min = rs.minPlayers || 2;
    const max = rs.maxPlayers || 4;
    return Math.max(min, Math.min(max, 3));
  }

  // -------------------------------------------------------------------------
  // ① 选玩法 —— 只管一件事：挑一个进去
  // -------------------------------------------------------------------------
  // 大厅里**只有玩法名**，竖着排一行一个。卡片里塞介绍的那一版，五段说明
  // 一起铺开，名字反而成了每张卡上最小的一行字：想找"斗地主"得先把五段
  // 介绍都扫一遍。玩法是什么、几个人玩、带谁玩，点进去那一页再说。
  function renderLobby() {
    const wrap = $('modes');
    if (!wrap) return;
    wrap.textContent = '';
    for (const rs of rulesets) {
      const card = el('button', 'mode', rs.name);
      card.type = 'button';
      card.dataset.rs = rs.id;
      wrap.appendChild(card);
    }
  }

  $('modes')?.addEventListener('click', (e) => {
    const card = e.target.closest('.mode');
    if (!card) return;
    const rs = ruleSetOf(card.dataset.rs);
    if (!rs) return;
    st.rsId = rs.id;
    st.players = defaultPlayers(rs);
    // 换玩法就把上次选的人清掉：人还是"上一位玩法的人"，
    // 在新玩法里未必坐得下，留着反而要用户自己去对照
    st.picked = [];
    enterPick();
  });

  // -------------------------------------------------------------------------
  // ② 玩法的样子（名字 / 介绍 / 人数）+ ③ 选谁和你玩
  // -------------------------------------------------------------------------
  // 这两件事摆在同一页，但顺序是"先看这是什么玩法，再决定带谁"。
  // 一位对手都不用的玩法（21 点单人局）也照样进这一页 —— 跳过它，
  // 用户就看不到这个玩法的介绍了，只剩一个"点了名字就直接开局"的意外。
  function enterPick() {
    const n = need();
    // 进选人页时先把名单补齐到这一局需要的人数：
    // 空着的话「开始游戏」一直是灰的，用户不知道自己该干什么。
    // 补齐之后照样可以取消换人，顺序仍然 = 落座顺序
    if (n > 0) {
      st.picked = prunePicked(st.picked, n);
      if (st.picked.length < n) {
        const rest = getRoster().filter((a) => !st.picked.includes(a.id));
        for (const a of rest) {
          if (st.picked.length >= n) break;
          st.picked.push(a.id);
        }
      }
    }
    setScene('pick');
  }

  /** 开局：交给 app.js 去建状态。启动层只负责"定下来" */
  function startNow() {
    setScene('table');
    onStart({ rsId: st.rsId, players: st.players, agents: activeAgents(st.picked, need()) });
  }

  let pickListKey = '';

  function renderPick() {
    const rs = ruleSetOf(st.rsId);
    const n = need();
    // 玩法名、介绍、人数 —— 三样都在这一页，正是大厅里省掉的那些
    $('pick-rule').textContent = rs ? rs.name : '';
    $('pick-desc').textContent = rs ? (rs.description || '') : '';
    $('pick-count').textContent = n > 0 ? `已选 ${st.picked.length} / ${n}` : '';
    renderPlayerChips(rs);

    // 这一局不需要对手：把整块"选谁和你玩"收起来。
    // 留着的话用户会对着三张卡片点半天，而点击什么也不会发生
    const rosterWrap = $('pick-roster');
    if (rosterWrap) rosterWrap.style.display = n > 0 ? '' : 'none';

    // 卡片列表只在**名册本身**变了时才重建。
    // 每点一张卡就重建整份列表的话，浏览器得把每张立绘重新解码一遍 ——
    // 三五个人看不出来，导入一份几十人的名册就会卡，而且会闪
    // （外部脚本也会撞上：重建之后它手里的元素句柄全失效了）。
    const key = rosterKey();
    if (key !== pickListKey) {
      pickListKey = key;
      buildPickList();
    }
    syncPickState(n);
  }

  /** 人数档。只有一档时这不算"选择"，整行收起来 */
  function renderPlayerChips(rs) {
    const row = $('pick-row');
    const wrap = $('pick-players');
    if (!row || !wrap) return;
    const min = rs?.minPlayers || 2;
    const max = rs?.maxPlayers || 4;
    row.style.display = min < max ? '' : 'none';
    wrap.textContent = '';
    for (let k = min; k <= max; k++) {
      const b = el('button', 'pick-chip' + (k === st.players ? ' on' : ''), countWord(k));
      b.type = 'button';
      b.dataset.players = String(k);
      wrap.appendChild(b);
    }
  }

  function buildPickList() {
    const wrap = $('pick-roster');
    if (!wrap) return;
    wrap.textContent = '';
    if (need() <= 0) return; // 不用选人，别白渲染一份立绘列表
    for (const a of getRoster()) {
      const av = AVATARS[a.avatar] || AVATARS[DEFAULT_AVATAR];
      const card = el('div', 'agcard');
      card.dataset.id = a.id;

      const port = el('div', 'port');
      const im = el('img');
      im.src = avatarUrl(a.avatar);
      im.alt = a.name;
      port.appendChild(im);
      card.appendChild(port);

      card.appendChild(el('div', 'meta',
        '<div class="nm"><span class="no"></span><span class="nmtext"></span>'
        // 形象标签只在与名字不同时才显示 —— 默认名册里「老千」用的就是老千那张形象，
        // 并排写两遍同一个词，读起来像出了 bug
        + `<span class="av">${av.label !== a.name ? av.label : ''}</span>`
        + '<button class="pen" title="编辑这位智能体">✎</button></div>'
        + '<div class="ps"></div>'));

      card.addEventListener('click', () => togglePick(a.id));
      // 编辑入口必须吞掉冒泡 —— 否则点它会顺带把这张卡选中/取消
      card.querySelector('.pen').addEventListener('click', (ev) => {
        ev.stopPropagation();
        openEditor(a.id);
      });
      wrap.appendChild(card);
    }
  }

  function syncPickState(n) {
    // 形象重复检测：同一局里两个人长得一样，桌面上就读不出谁是谁。
    // 不禁止（可能是刻意的），但要说出来
    const used = {};
    for (const id of st.picked) {
      const a = getRoster().find((x) => x.id === id);
      if (a) used[a.avatar] = (used[a.avatar] || 0) + 1;
    }

    for (const card of document.querySelectorAll('.agcard')) {
      const a = getRoster().find((x) => x.id === card.dataset.id);
      if (!a) continue;
      const at = st.picked.indexOf(a.id);
      const on = at >= 0;
      card.classList.toggle('on', on);
      card.querySelector('.no').textContent = on ? String(at + 1) : '';
      card.querySelector('.nmtext').textContent = a.name;
      card.querySelector('.ps').textContent = a.persona || '（没写人设）';

      const dupe = card.querySelector('.dupe');
      if (on && used[a.avatar] > 1) {
        if (!dupe) card.appendChild(el('div', 'dupe', '形象重复'));
      } else if (dupe) {
        dupe.remove();
      }
    }

    const roster = getRoster();
    const start = $('pick-start');
    start.disabled = st.picked.length !== n || roster.length < n;
    start.textContent = st.picked.length === n ? '开始游戏' : `还要选 ${n - st.picked.length} 位`;

    const dupes = Object.values(used).filter((c) => c > 1).length;
    const names = st.picked
      .map((id) => roster.find((x) => x.id === id)?.name)
      .filter(Boolean);
    const dupName = names.length !== new Set(names).size;
    const note = $('pick-note');
    if (n <= 0) {
      note.textContent = '这一局桌上只有你和荷官，不用选对手 —— 直接开始就行。';
    } else if (roster.length < n) {
      // 名册比这一局需要的人还少。不说出来的话，用户只会看到「开始游戏」一直灰着，
      // 不知道自己该干什么 —— 导入一份只有两位的名册、再点四人局就会撞上
      note.textContent = `名册里只有 ${roster.length} 位智能体，这一局需要 ${n} 位 —— `
        + '先「新建智能体」，或导入一份更全的名册。';
    } else if (dupes) {
      note.textContent = '有两位智能体共用同一副形象，桌面上会认不出谁是谁 —— 不拦你，只是提醒。';
    } else if (dupName) {
      note.textContent = '有两位智能体重名，牌桌记录里会分不清是谁 —— 不拦你，只是提醒。';
    } else {
      note.textContent = '选中顺序 = 落座顺序（先选的坐左边）。';
    }
  }

  function togglePick(id) {
    const n = need();
    const at = st.picked.indexOf(id);
    if (at >= 0) {
      st.picked.splice(at, 1);
    } else if (st.picked.length < n) {
      st.picked.push(id);
    } else {
      toast(`已经选满 ${n} 位了，想换人先取消一个。`);
      return;
    }
    renderPick();
  }

  // -------------------------------------------------------------------------
  // 名册：导入 / 导出
  // -------------------------------------------------------------------------
  $('roster-export')?.addEventListener('click', () => {
    downloadJson('ai-card-table.agents.json', JSON.stringify(rosterPayload(), null, 2));
    toast(`已导出 ${getRoster().length} 位智能体（不含 API Key）。`);
  });

  $('roster-import')?.addEventListener('click', () => $('roster-file')?.click());

  $('roster-file')?.addEventListener('change', async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = ''; // 允许连续两次选同一个文件
    if (!file) return;
    applyRosterImport(await file.text());
  });

  /**
   * 导入名册并**落到界面上**。抽出来是为了让测试脚本能直接喂一段文本测边界，
   * 不必真去造一个 File 对象 —— 导入的健壮性是这个功能最容易烂的地方。
   */
  function applyRosterImport(text) {
    const r = parseRosterText(text);
    if (!r.ok) {
      toast('导入失败：' + r.error);
      return { ok: false, error: r.error };
    }
    setRoster(r.agents);
    // 名册换了人，原来选中的 id 可能已经不存在 —— 只留下还认得的那几个，
    // 其余由 enterPick/activeAgents 补齐
    st.picked = st.picked.filter((id) => getRoster().some((a) => a.id === id));
    enterPick();
    toast(`已导入 ${getRoster().length} 位智能体。` + (r.warnings.length ? ' ' + r.warnings.join(' ') : ''));
    return { ok: true, warnings: r.warnings, count: getRoster().length };
  }

  // -------------------------------------------------------------------------
  // 编辑 / 新建智能体
  // -------------------------------------------------------------------------
  let editingId = null;
  let delArmed = false;

  /**
   * 这个编辑框是被谁打开的：
   *   'roster' —— 大厅 / 选人页里管理名册：能新建、能删
   *   'table'  —— 牌桌上点开某个人看 / 改他的设定：删除收起来
   *               （牌打到一半把人从名册里删掉，不会把他从牌桌上请下去，
   *                只会让"名册"和"桌上这个人"两边对不上）
   */
  let editorScope = 'roster';

  function openEditor(id, opts = {}) {
    editorScope = opts.scope === 'table' ? 'table' : 'roster';
    editingId = id || null;
    const a = editingId ? getRoster().find((x) => x.id === editingId) : null;
    const cur = a || { name: '', avatar: DEFAULT_AVATAR, persona: '' };

    $('edit-title').textContent = !a
      ? '新建智能体'
      : (editorScope === 'table' ? `${a.name} 的设定` : '编辑智能体');
    $('edit-name').value = cur.name;
    $('edit-persona').value = cur.persona;

    delArmed = false;
    const del = $('edit-del');
    del.textContent = '删除这位';
    del.style.display = a && editorScope !== 'table' ? '' : 'none';

    buildAvatarOptions(cur.avatar);
    document.body.classList.add('editing');
    setTimeout(() => $('edit-name').focus(), 30);
  }

  function buildAvatarOptions(sel) {
    const wrap = $('edit-avatars');
    if (!wrap) return;
    wrap.textContent = '';
    for (const id of AVATAR_IDS) {
      const o = el('div', 'avopt' + (id === sel ? ' on' : ''));
      o.dataset.avatar = id;
      const im = el('img');
      im.src = avatarUrl(id);
      im.alt = AVATARS[id].label;
      o.appendChild(im);
      o.appendChild(el('span', null, AVATARS[id].label));
      o.addEventListener('click', () => {
        wrap.querySelectorAll('.avopt').forEach((x) => x.classList.remove('on'));
        o.classList.add('on');
      });
      wrap.appendChild(o);
    }
  }

  function closeEditor() {
    document.body.classList.remove('editing');
    editingId = null;
  }

  function saveEditor() {
    const name = $('edit-name').value.trim();
    const persona = $('edit-persona').value.trim();
    const chosen = document.querySelector('.avopt.on');
    const avatar = chosen ? chosen.dataset.avatar : DEFAULT_AVATAR;
    if (!name) { toast('名字不能空着。'); return; }

    const isNew = !editingId;
    if (isNew) {
      const a = addAgent({ name, avatar, persona });
      if (st.picked.length < need()) st.picked.push(a.id);
    } else {
      updateAgent(editingId, { name, avatar, persona });
    }
    closeEditor();
    // 选人页开着才需要重画它；在牌桌上改的（点人物改设定）由 app 那边跟着走
    if (st.scene === 'pick') renderPick();
    toast(`已${isNew ? '新建' : '保存'}「${name}」。`);
  }

  function deleteEditing() {
    if (!editingId) return;
    const a = getRoster().find((x) => x.id === editingId);
    if (!a) return;
    if (getRoster().length <= 1) { toast('名册里总得留下一位。'); return; }

    // 删除不可逆，所以要点两下。没用 confirm()：系统对话框会打断整条流程
    const del = $('edit-del');
    if (!delArmed) {
      delArmed = true;
      del.textContent = '真的删掉？';
      setTimeout(() => { delArmed = false; del.textContent = '删除这位'; }, 3500);
      return;
    }
    removeAgent(editingId);
    st.picked = st.picked.filter((id) => id !== editingId);
    closeEditor();
    enterPick();
    toast(`已删掉「${a.name}」。`);
  }

  $('roster-new')?.addEventListener('click', () => openEditor(null));
  $('edit-cancel')?.addEventListener('click', closeEditor);
  $('edit-save')?.addEventListener('click', saveEditor);
  $('edit-del')?.addEventListener('click', deleteEditing);
  // 点遮罩空白处关闭；点面板内部不关（否则在输入框里选中文字拖到外面就关了）
  $('editmask')?.addEventListener('click', (e) => {
    if (e.target.id === 'editmask') closeEditor();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('editing')) closeEditor();
  });

  $('pick-back')?.addEventListener('click', () => setScene('lobby'));

  // 换人数就在这一页换，不必退回大厅重挑一次玩法 ——
  // "玩哪个玩法"和"几个人玩"本来就是同一件事的两面。
  // 改完直接走 enterPick：人数变多时要自动把新位置补上人，别让用户自己再点。
  $('pick-players')?.addEventListener('click', (e) => {
    const chip = e.target.closest('.pick-chip');
    if (!chip) return;
    const k = Number(chip.dataset.players);
    if (!k || k === st.players) return;
    st.players = k;
    st.picked = prunePicked(st.picked, need());
    enterPick();
  });

  $('pick-start')?.addEventListener('click', () => {
    if (st.picked.length !== need()) return;
    startNow();
  });

  // 名册在别处被改了（导入、删除）也要让选人页跟上
  onRosterChange(() => {
    if (st.scene === 'pick') {
      pickListKey = ''; // 强制重建
      renderPick();
    }
  });

  renderLobby();

  return {
    state: st,
    setScene,
    renderLobby,
    renderPick,
    /** 从抽屉那边改玩法/人数时同步过来 —— 启动层是这两件事的唯一出处 */
    setRuleset(id) {
      const rs = ruleSetOf(id);
      if (!rs) return;
      st.rsId = rs.id;
      st.players = Math.min(rs.maxPlayers || 4, Math.max(rs.minPlayers || 2, st.players || 3));
      st.picked = prunePicked(st.picked, need());
    },
    setPlayers(k) {
      const rs = ruleSetOf(st.rsId);
      const min = rs?.minPlayers || 2;
      const max = rs?.maxPlayers || 4;
      st.players = Math.max(min, Math.min(max, Number(k) || min));
      st.picked = prunePicked(st.picked, need());
    },
    selection() {
      return { rsId: st.rsId, players: st.players, picked: [...st.picked], agents: activeAgents(st.picked, need()) };
    },
    applyRosterImport,
    openEditor,
    togglePick,
    /** 测试用：当前这一局需要几位对手 */
    need,
  };
}

/**
 * 座位空着时用的兜底身份。
 * avatar 显式留 null —— 渲染层据此画金色剪影，把「这里有个位子但没人」
 * 和「这里有个人」区分开。不能走 normalizeAgent：它会把 null 补成默认形象，
 * 那样空位就伪装成了一个真人。
 */
export function fallbackAgent(seq) {
  return { id: `ag-fallback-${seq}`, name: `AI-${seq}`, avatar: null, persona: '', isFallback: true };
}
