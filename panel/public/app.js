/* 蓝色大肥鱼 · 养鱼面板 —— 零依赖单页应用 */
'use strict';

// ─── 基础工具 ──────────────────────────────────────────────
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const img = (u, size) => {
  if (!u) return '';
  let s = String(u).replace(/^http:/, 'https:');
  if (s.startsWith('//')) s = 'https:' + s;
  return size && /hdslb\.com/.test(s) && !s.includes('@') ? `${s}@${size}.webp` : s;
};
const fmtNum = (n) => {
  n = Number(n || 0);
  return n >= 1e8 ? (n / 1e8).toFixed(1) + '亿' : n >= 1e4 ? (n / 1e4).toFixed(1) + '万' : String(n);
};
const fmtSec = (s) => {
  s = Math.round(Number(s) || 0);
  if (s < 60) return s + '秒';
  if (s < 3600) return Math.floor(s / 60) + '分' + (s % 60 ? String(s % 60).padStart(2, '0') + '秒' : '');
  return Math.floor(s / 3600) + '小时' + Math.round((s % 3600) / 60) + '分';
};
const fmtDur = (s) => {
  if (typeof s === 'string' && s.includes(':')) return s;
  s = Number(s) || 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const pad = (n) => String(n).padStart(2, '0');
const localDate = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (t) => { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ago = (t) => {
  const ms = typeof t === 'number' && t < 1e12 ? t * 1000 : new Date(t).getTime();
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return '刚刚';
  if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
  if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
  if (s < 86400 * 7) return Math.floor(s / 86400) + ' 天前';
  const d = new Date(ms);
  return `${d.getMonth() + 1}月${d.getDate()}日`;
};
const dayLabel = (d) => {
  const today = localDate();
  const y = localDate(new Date(Date.now() - 86400000));
  if (d === today) return '今天';
  if (d === y) return '昨天';
  const [, m, dd] = d.split('-');
  return `${Number(m)}月${Number(dd)}日`;
};

async function api(path, body) {
  const opt = body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
  const r = await fetch(path, opt);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
  return j;
}

function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast show ' + kind;
  clearTimeout(el._t);
  el._t = setTimeout(() => (el.className = 'toast'), 3200);
}

function confirmBox(title, text, yes = '确定') {
  return new Promise((resolve) => {
    const m = $('#modal');
    $('#modalTitle').textContent = title;
    $('#modalText').textContent = text;
    $('#modalYes').textContent = yes;
    m.classList.add('show');
    const done = (v) => { m.classList.remove('show'); $('#modalYes').onclick = $('#modalNo').onclick = null; resolve(v); };
    $('#modalYes').onclick = () => done(true);
    $('#modalNo').onclick = () => done(false);
  });
}

/** 按钮执行期间禁用，出错就 toast */
async function busy(btn, fn) {
  if (btn) btn.disabled = true;
  try { return await fn(); } catch (e) { toast(e.message, 'err'); } finally { if (btn) { btn.disabled = false; } }
}

// ─── 图标 ──────────────────────────────────────────────────
const I = {
  home: '<path d="M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>',
  bolt: '<path d="M13 2L4 14h7l-1 8 9-12h-7z"/>',
  play: '<rect x="3" y="5" width="18" height="14" rx="3"/><path d="M10 9l5 3-5 3z"/>',
  chat: '<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z"/>',
  check: '<path d="M9 11l3 3 8-8"/><path d="M20 12v7a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h9"/>',
  book: '<path d="M4 4h10a4 4 0 0 1 4 4v12H8a4 4 0 0 1-4-4z"/><path d="M4 16a4 4 0 0 1 4-4h10"/>',
};
const icon = (k) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${I[k]}</svg>`;

const PAGES = [
  { id: 'overview', name: '总览', icon: 'home' },
  { id: 'activity', name: '活动记录', icon: 'list' },
  { id: 'autopilot', name: '自动养号', icon: 'bolt' },
  { id: 'explore', name: '刷视频', icon: 'play' },
  { id: 'inbox', name: '消息', icon: 'chat', badge: 'inbox' },
  { id: 'review', name: '待审 · 派活', icon: 'check', badge: 'review' },
  { id: 'diary', name: '养鱼日记', icon: 'book' },
];

const KIND = {
  watch: ['📺', '看视频'], view: ['👀', '打开视频'], like: ['❤️', '点赞'], share: ['↗️', '分享'], coin: ['🪙', '投币'],
  comment: ['💬', '评论'], reply_comment: ['↩️', '回复评论'], dm_send: ['✉️', '私信'], search: ['🔍', '搜索'],
  feed: ['🏠', '刷推荐'], hot: ['🔥', '看热门'], task: ['📋', '派任务'], task_done: ['✅', '完成任务'],
  session_start: ['🐟', '开始刷'], session_end: ['🏁', '刷完了'], draft: ['📝', '起草'], diary: ['📔', '发日记'],
  cooldown: ['🧊', '风控冷却'], pause: ['⏸', '号主叫停'], health: ['🩺', 'QQ 接入'], qq: ['💬', 'QQ 小号'], error: ['⚠️', '出错'], wake: ['☀️', '醒来'], autopilot: ['⚙️', '设置'],
  login: ['🔑', '登录'], notify: ['📮', 'QQ 提醒'], favorite: ['⭐', '收藏'], vip_new: ['🌟', '特别关注更新'], dyn_like: ['👍', '动态点赞'], vip: ['🌟', '特别关注'], follow: ['➕', '关注'],
  mind: ['💭', '心里想'], dig: ['🕳️', '顺藤摸瓜'],
  join: ['🗨️', '评论区搭话'], social: ['📬', '看回复'], reply_like: ['👍', '评论点赞'],
};
const SOURCE = { auto: ['自动', 'blue'], panel: ['面板', 'violet'], bot: ['QQ里的她', 'pink'] };

// ─── 全局状态 ──────────────────────────────────────────────
const S = { page: 'overview', ov: null, badges: { inbox: 0, review: 0 } };

// ─── 导航 ──────────────────────────────────────────────────
function renderNav() {
  const html = PAGES.map((p) => {
    const b = p.badge && S.badges[p.badge] ? `<span class="badge">${S.badges[p.badge]}</span>` : '';
    return `<button class="nav ${S.page === p.id ? 'on' : ''}" data-go="${p.id}">${icon(p.icon)}<span>${p.name}</span>${b}</button>`;
  }).join('');
  $('#nav').innerHTML = html;
  $('#mnav').innerHTML = html;
}
document.addEventListener('click', (e) => {
  const go = e.target.closest('[data-go]');
  if (go) { location.hash = '#/' + go.dataset.go; }
  const v = e.target.closest('[data-bvid]');
  if (v && !e.target.closest('button,a,textarea,input')) openVideo(v.dataset.bvid);
});
window.addEventListener('hashchange', route);
function route() {
  const id = (location.hash.match(/^#\/(\w+)/) || [])[1] || 'overview';
  S.page = PAGES.some((p) => p.id === id) ? id : 'overview';
  closeDrawer();
  renderNav();
  const main = $('#main');
  main.innerHTML = '';
  main.scrollTop = 0;
  window.scrollTo(0, 0);
  ({ overview: pageOverview, activity: pageActivity, autopilot: pageAutopilot, explore: pageExplore, inbox: pageInbox, review: pageReview, diary: pageDiary })[S.page](main);
}

function head(title, desc, right = '') {
  return `<div class="page-head"><div><h1>${title}</h1>${desc ? `<p>${desc}</p>` : ''}</div><div class="row wrap">${right}</div></div>`;
}

// ─── 总览 ──────────────────────────────────────────────────
const LV_EXP = [0, 1, 200, 1500, 4500, 10800, 28800];

async function loadOverview() {
  S.ov = await api('/api/overview');
  const u = S.ov.unread || {};
  S.badges.inbox = (u.reply || 0) + (u.at || 0) + (u.dm || 0);
  S.badges.review = S.ov.reviewPending || 0;
  const ap = S.ov.autopilot;
  renderLoginBanner(S.ov.account);
  renderHealthBanner(S.ov.health);
  $('#footStatus').innerHTML = S.ov.account && !S.ov.account.loggedIn ? '<a href="#" id="footLogin" style="color:var(--red)">⚠️ 掉登录了 · 扫码</a>' : ap.live.running
    ? '<span class="pulse"></span> 她正在刷B站'
    : ap.config.enabled ? '自动养号 · 开' : '自动养号 · 关';
  renderNav();
  return S.ov;
}

function dailyExpRate(ap) {
  const c = ap.config;
  // 登录 5 + 观看 5 + 分享 5 + 投币（新号每天只送 1 枚币，最多 10）
  return 10 + (c.share.daily ? 5 : 0) + (c.coin.enabled && !ap.coinLock ? 10 * Math.min(1, c.coin.dailyMax) : 0);
}

function etaText(acct, ap) {
  if (acct.level >= 6) return '已经满级啦';
  const need = LV_EXP[6] - (acct.exp || 0);
  const rate = dailyExpRate(ap);
  const days = Math.ceil(need / rate);
  const d = new Date(Date.now() + days * 86400000);
  const next = LV_EXP[(acct.level || 0) + 1];
  const daysNext = next ? Math.ceil((next - acct.exp) / rate) : 0;
  return `按每天 ${rate} 经验：Lv${acct.level + 1} 还要约 ${daysNext} 天，Lv6 约 ${days} 天（${d.getFullYear()}年${d.getMonth() + 1}月）`;
}

async function pageOverview(main) {
  main.innerHTML = head('总览', '她今天在B站过得怎么样') + '<div class="empty"><span class="fish">🐟</span>加载中…</div>';
  let ov;
  try { ov = await loadOverview(); } catch (e) { main.innerHTML = head('总览') + `<div class="card err">${esc(e.message)}</div>`; return; }
  if (S.page !== 'overview') return;
  const a = ov.account || {};
  const x = ov.exp || {};
  const ap = ov.autopilot;
  const t = ov.today || {};
  const todayS = ov.series[ov.series.length - 1] || {};
  const pct = a.expNext && a.expNext > 0 ? Math.min(100, ((a.exp - a.expMin) / (a.expNext - a.expMin)) * 100) : 100;

  const acctCard = a.error || !a.loggedIn
    ? `<div class="card span-2"><div class="hero"><div class="avatar" style="display:grid;place-items:center;font-size:32px">🔑</div>
        <div><h2>B站 掉登录了</h2>
        <div class="small muted">${a.error ? '账号连不上：' + esc(a.error) : '改密码、改密保、异地登录之后，B站 会让旧的登录失效。'}自动养号会停着，扫个码就好。</div>
        <div class="row" style="margin-top:12px"><button class="btn primary" id="ovLogin">📱 扫码登录</button></div></div></div></div>`
    : `<div class="card span-2">
        <div class="hero">
          <img class="avatar" src="${esc(img(a.face, '144w_144h'))}" alt="" onerror="this.style.visibility='hidden'">
          <div style="min-width:0">
            <h2>${esc(a.uname)} <span class="lv l${a.level}">LV${a.level}</span>${a.vip ? '<span class="chip pink">大会员</span>' : ''}</h2>
            <div class="small muted">UID ${esc(a.uid)} · <a href="https://space.bilibili.com/${esc(a.uid)}" target="_blank" rel="noopener">B站主页 ↗</a></div>
            <div style="margin-top:10px" class="row"><div class="bar" style="flex:1"><i style="width:${pct}%"></i></div><span class="small num">${a.exp} / ${a.expNext > 0 ? a.expNext : '满级'}</span></div>
            <div class="hint">${esc(etaText(a, ap))}</div>
            <div class="kvs">
              <span>硬币 <b class="num">${a.coins}</b></span>
              <span title="myinfo 里的 moral 字段。正式会员一般就是 70，不是满分 100 的那种信用分">节操值 <b class="num">${a.moral ?? '?'}</b></span>
              <span>手机 <b>${a.mobileVerified ? '已绑' : '未绑'}</b></span>
              <span>邮箱 <b>${a.emailVerified ? '已绑' : '未绑'}</b></span>
            </div>
          </div>
        </div>
      </div>`;

  const chk = (ok, name, sub, cls = '') => `<div class="check ${ok ? 'ok' : ''} ${cls}"><div class="t">${name}</div><div class="s">${ok ? '✓ ' : ''}${sub}</div></div>`;
  const coinCls = ap.coinLock ? 'lock' : '';
  const expCard = `<div class="card span-2">
      <div class="card-h"><h2>今日经验<span class="sub">每天 0 点重置</span></h2><span class="chip">${(x.login ? 5 : 0) + (x.watch ? 5 : 0) + (x.share ? 5 : 0) + (x.coinsExp || 0)} 经验</span></div>
      <div class="checks">
        ${chk(x.login, '登录 +5', x.login ? '已领' : '未领')}
        ${chk(x.watch, '看视频 +5', x.watch ? '已领' : '等她去看')}
        ${chk(x.share, '分享 +5', x.share ? '已领' : '自动养号会顺手分享')}
        ${chk(!ap.coinLock && (x.coinsExp || 0) >= 10, '投币 +10/枚', `${x.coinsExp || 0} / 50${ap.coinLock ? ' · 🔒 已上锁' : ''}`, coinCls)}
      </div>
      ${oneTimeTips(x)}
    </div>`;

  const stat = (k, v, unit, d) => `<div class="card stat"><div class="k">${k}</div><div class="v num">${v}<small>${unit}</small></div><div class="d">${d}</div></div>`;
  const stats = `<div class="grid g-4">
      ${stat('📺 今天看了', t.watch || 0, '个视频', `共 ${fmtSec(todayS.seconds)}`)}
      ${stat('❤️ 点赞', t.like || 0, '', `上限 ${ap.config.like.dailyMax}/天`)}
      ${stat('💬 评论', (t.comment || 0) + (t.reply_comment || 0) + (t.join || 0), '', `${ov.reviewPending ? ov.reviewPending + ' 条待审' : '上限 ' + ap.config.comment.dailyMax + '/天'}`)}
      ${stat('🔔 未读', ov.unread ? (ov.unread.reply + ov.unread.at + ov.unread.dm) : '–', '', ov.unread ? `回复 ${ov.unread.reply} · @ ${ov.unread.at} · 私信 ${ov.unread.dm}` : '查不到')}
    </div>`;

  main.innerHTML = head('总览', '她今天在B站过得怎么样',
      `<button class="btn" id="ovRefresh">刷新</button>`) +
    `<div class="grid g-4">${acctCard}${expCard}</div>
     <div style="height:16px"></div>${stats}<div style="height:16px"></div>
     <div class="grid g-3">
       <div class="span-2 grid">
         <div class="card" id="apCard"></div>
         <div class="card" id="ovDay"></div>
         <div class="card"><div class="card-h"><h2>近 14 天看视频数</h2><span class="small muted">鼠标移上去看当天明细</span></div><div id="ovChart" class="chart"></div></div>
       </div>
       <div class="grid">
         <div class="card" id="ovWish" style="display:none"></div>
         <div class="card"><div class="card-h"><h2>最近动态</h2><a href="#/activity" class="small">全部 →</a></div><div id="ovRecent"></div></div>
       </div>
     </div>`;
  renderWishes($('#ovWish'));

  $('#ovRefresh').onclick = () => route();
  const ol = $('#ovLogin');
  if (ol) ol.onclick = () => openLogin();
  renderApCard($('#apCard'), ap);
  renderDay($('#ovDay'));
  renderChart($('#ovChart'), ov.series);
  const r = await api('/api/actions?limit=6').catch(() => ({ list: [] }));
  $('#ovRecent').innerHTML = r.list.length ? `<ul class="tl compact">${r.list.map((x) => tlItem(x, true)).join('')}</ul>` : '<div class="empty">还没有动作</div>';
}

// 她的一天：心情、着迷的东西、今天心里想过的、最近的她
async function renderDay(el) {
  let d;
  try { d = await api('/api/mind'); } catch (e) { el.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const m = d.mind;
  if (!d.llm || !d.enabled) {
    el.innerHTML = `<div class="card-h"><h2>🐟 她的一天</h2></div><div class="empty">${d.llm ? '「内心」关着（autopilot.json 里 mind.enabled）' : '配了模型（自动养号 → 模型设置）她才会有自己的心思'}</div>`;
    return;
  }
  const state = [['心情', m.mood], ['最近着迷', m.obsession], ['还在想', m.thought], ['小目标', m.goal]]
    .filter(([, v]) => v).map(([k, v]) => `<div><span class="k">${k}</span>${esc(v)}</div>`).join('');
  const grown = m.interests.length ? `<div class="tags" style="margin-top:8px">${m.interests.map((x) => `<span class="chip violet" title="${esc(x.at)} 迷上的">${esc(x.kw)}</span>`).join('')}</div>` : '';
  const lines = [...d.thoughts.map((t) => ({ ts: t.ts, html: `<b>《${esc(t.title)}》</b>${t.dug ? ' <span class="chip">顺藤摸瓜</span>' : ''}${t.heard ? `<div class="small muted">🎧 ${esc(t.heard)}${t.up ? ` · UP：${esc(t.up)}` : ''}</div>` : ''}<div class="thought">💭 ${esc(t.thought)} <span class="muted">${'♥'.repeat(t.score || 0)}</span></div>`, bvid: t.bvid })),
    ...d.moments.filter((x) => x.kind !== 'dig').map((x) => ({ ts: x.ts, html: esc(x.detail) }))].sort((a, b) => (a.ts < b.ts ? -1 : 1));
  const last = m.selfHistory[m.selfHistory.length - 1];
  el.innerHTML = `<div class="card-h"><h2>🐟 她的一天</h2><span class="small muted">${m.updatedAt ? '更新于 ' + hm(m.updatedAt) : ''}</span></div>
    ${d.sky ? `<div class="small muted" style="margin-bottom:8px">🪟 ${esc(d.sky)}</div>` : ''}
    <div class="mind-state">${state || '<span class="muted">还没刷过，心里空空的</span>'}</div>${grown}
    ${lines.length ? `<ul class="tl compact" style="margin-top:10px">${lines.map((l) => `<li ${l.bvid ? `data-bvid="${esc(l.bvid)}" style="cursor:pointer"` : ''}><div class="time num">${hm(l.ts)}</div><div class="ico">•</div><div class="body">${l.html}</div></li>`).join('')}</ul>` : '<div class="empty">今天还没有心里话</div>'}
    ${m.self ? `<details style="margin-top:10px"><summary class="small">最近的她${last?.changed ? ` · ${esc(last.date)}：${esc(last.changed)}` : ''}</summary><p class="small">${esc(m.self)}</p>
      ${m.selfHistory.length > 1 ? `<div class="small muted">${m.selfHistory.slice(-8, -1).reverse().map((h) => `${esc(h.date)}${h.changed ? '：' + esc(h.changed) : ''}`).join('<br>')}</div>` : ''}</details>` : ''}
    ${d.lingo?.length ? `<div class="small" style="margin-top:8px"><span class="k">学会的说法</span> ${d.lingo.map((w) => `<span class="chip" title="${esc(w.meaning)}${w.example ? '\n例：' + esc(w.example) : ''}\n${esc(w.at)} 学会，碰到过 ${w.n} 次">${esc(w.phrase)}</span>`).join(' ')}</div>` : ''}
    <details style="margin-top:6px" id="memBox"><summary class="small">她的记忆（${d.memory?.total || 0} 条，最近的在上面；记错了能改能删）</summary><div id="memList"></div></details>`;
  renderMemories($('#memList', el), d.memory);
}

const MEM_KIND = { watch: '📺', session: '🐟', social: '💬', self: '🌙', gist: '🧩', chat: '🗨️' };
function renderMemories(box, mem) {
  if (!box) return;
  const list = mem?.recent || [];
  box.innerHTML = list.length
    ? `<ul class="vip-list">${list.map((e) => `<li><div style="flex:1;min-width:0" class="small">${MEM_KIND[e.kind] || '•'} ${esc(e.text)}
        <div class="muted">${ago(e.ts)} · 重要 ${e.imp}/5${e.R != null && e.kind !== 'self' ? ` · 还记得 ${Math.round(e.R * 100)}%` : ''}${e.fuzzy ? ' · 记模糊了' : ''}${e.emo >= 0.5 ? ' · 印象深' : ''}${e.from ? ` · ${e.from} 条合成的` : ''}${e.n ? ` · 想起过 ${e.n} 次` : ''}${e.edited ? ' · 你改过' : ''}</div></div>
        <button class="btn sm ghost" data-memedit="${esc(e.id)}" title="改这条">✎</button>
        <button class="btn sm ghost" data-memdel="${esc(e.id)}" title="删掉这条">✕</button></li>`).join('')}</ul>`
    : '<div class="empty">还什么都没记</div>';
  box.insertAdjacentHTML('beforeend', `<div class="row" style="margin-top:6px"><button class="btn sm ghost" id="memTidy">现在整理一下</button><a class="btn sm ghost" href="/brain.html" target="_blank" rel="noopener">🧠 看脑图</a><span class="small muted">每晚睡前反思完会自己整理：零碎的合成印象，清楚度掉到 20% 先记模糊，掉到 5% 忘掉（隔一阵被想起一次的、印象深的记得最牢）</span></div>`);
  $('#memTidy', box).onclick = (ev) => busy(ev.target, async () => {
    const r = await api('/api/memory/tidy', {});
    const x = r.result || {};
    toast(x.merged || x.forgot || x.blurred ? `合并 ${x.merged || 0} 条成 ${x.into || 0} 条，${x.blurred || 0} 条记模糊了，忘掉 ${x.forgot || 0} 条` : '没什么要整理的');
    renderMemories(box, r);
  });
  $$('[data-memedit]', box).forEach((b) => (b.onclick = () => {
    const e = list.find((x) => x.id === b.dataset.memedit);
    const text = prompt('改成什么？', e.text);
    if (text === null) return;
    const imp = prompt('重要程度 1~5（越重要记得越久）', String(e.imp));
    if (imp === null) return;
    busy(b, async () => { renderMemories(box, await api('/api/memory/update', { id: e.id, text, imp: Number(imp) })); toast('改好了'); });
  }));
  $$('[data-memdel]', box).forEach((b) => (b.onclick = () => busy(b, async () => {
    renderMemories(box, await api('/api/memory/delete', { id: b.dataset.memdel }));
  })));
}

// 点赞 / 分享被 B站 拦着时她想点的视频：你在自己浏览器里点，B站 认真浏览器
async function renderWishes(el) {
  if (!el) return;
  const { list } = await api('/api/wishes').catch(() => ({ list: [] }));
  if (!el.isConnected) return;
  if (!list.length) { el.style.display = 'none'; return; }
  el.style.display = '';
  const name = { like: '❤️ 点赞', share: '↗️ 分享' };
  el.innerHTML = `<div class="card-h"><h2>🖱️ 等你帮她点</h2><button class="btn sm ghost" id="wishAll">全部清掉</button></div>
    <p class="small muted" style="margin-top:0">接口点赞 / 分享被 B站 拦着，这些是她看完想点的。点标题会开一个<b>她专用的浏览器窗口</b>（直接用她现在的登录，不用再登录，也不会把这边挤掉），点一下就好（分享 = 点分享按钮复制链接）。<br>别在你自己的浏览器里登录她的号，那样会把面板这边挤掉线。</p>
    <ul class="vip-list">${list.map((w) => `<li><div style="flex:1;min-width:0"><a href="#" data-wopen="${esc(w.bvid)}" title="在她的浏览器里打开">${esc(w.title || w.bvid)}</a>
      <div class="small muted">${name[w.kind] || w.kind}${w.owner ? ' · ' + esc(w.owner) : ''} · ${ago(w.ts)}</div></div>
      <button class="btn sm ghost" data-wdone="${esc(w.id)}" title="点过了">✓</button></li>`).join('')}</ul>`;
  $$('[data-wopen]', el).forEach((a) => (a.onclick = (e) => {
    e.preventDefault();
    busy(null, async () => { await api('/api/browser/open', { bvid: a.dataset.wopen }); toast('在她的浏览器里打开了，去那个窗口点吧'); });
  }));
  $$('[data-wdone]', el).forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/wishes/done', { id: b.dataset.wdone }); renderWishes(el); })));
  $('#wishAll', el).onclick = (e) => busy(e.target, async () => { await api('/api/wishes/done', { id: '*' }); renderWishes(el); });
}

function oneTimeTips(x) {
  const tips = [];
  if (!x.email) tips.push('绑定邮箱 +20');
  if (!x.safeQuestion) tips.push('设置密保问题 +30');
  if (!x.identify) tips.push('实名认证 +50');
  if (!tips.length) return '';
  return `<div class="hint" style="margin-top:12px">💡 一次性经验还没领：${tips.join('、')}。这些得你自己去 B站「账号设置」里弄，脚本不碰。</div>`;
}

// 今天模型用了多少：后台的跟预算比，你点的单独算
function usageLine(u) {
  if (!u) return '';
  const k = (n) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
  const lim = (used, max) => (max > 0 ? `${k(used)} / ${k(max)}` : `${k(used)}（不限）`);
  const NAME = { mind: '内心', social: '评论区社交', comment: '评论', memory: '整理记忆', reply: '回复', diary: '日记', task: '派活', test: '测试', other: '其他' };
  const tags = Object.entries(u.byTag || {}).sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([t, x]) => `${NAME[t] || t} ${x.calls} 次`).join(' · ');
  return `<div class="hint" style="margin-top:8px">今天：后台 ${lim(u.bg.calls, u.limit.calls)} 次、${lim(u.bg.tokens, u.limit.tokens)} tokens；一共 ${u.calls} 次 ${k(u.tokens)} tokens${u.hitAt ? ` · <b>${hm(u.hitAt)} 用完了</b>` : ''}${tags ? `<br>${tags}` : ''}</div>`;
}

function slotClass(s) { return s ? s.status : ''; }

function renderApCard(el, ap) {
  const c = ap.config;
  const now = new Date();
  const curH = now.getHours();
  const planBy = Object.fromEntries((ap.plan || []).map((s) => [s.key, s]));
  const dial = ap.shichen.map((sc) => {
    const s = planBy[sc.key];
    const isNow = sc.start === 23 ? curH >= 23 || curH < 1 : curH >= sc.start && curH < sc.end;
    const title = s ? `${sc.label} · ${s.status === 'pending' ? '计划 ' + hm(s.at) : { done: '已刷完', skipped: '今天随机跳过', missed: '错过了（电脑在睡觉）', running: '正在刷', failed: '中断了' }[s.status] || s.status}` : sc.label;
    return `<div class="h ${s ? 'sel' : ''} ${slotClass(s)} ${isNow ? 'now' : ''}" title="${esc(title)}">${sc.key}<small>${s && s.status === 'pending' ? hm(s.at) : pad(sc.start)}</small></div>`;
  }).join('');
  const next = (ap.plan || []).filter((s) => s.status === 'pending' && s.at > Date.now()).sort((a, b) => a.at - b.at)[0];
  const live = ap.live;
  const liveHtml = live.running
    ? `<div class="live">${live.video ? `<img src="${esc(img(live.video.pic, '172w_108h'))}" alt="">` : ''}
        <div style="min-width:0;flex:1">
          <div class="row small"><span class="pulse"></span><b>${esc(live.step || '刷B站中')}</b><span class="muted">第 ${Math.min(live.done + 1, live.planned || 1)} / ${live.planned || '?'} 个</span></div>
          ${live.video ? `<div class="t" style="margin-top:4px">${esc(live.video.title)}</div>
          <div class="row" style="margin-top:6px"><div class="bar pink" style="flex:1"><i style="width:${Math.min(100, (live.video.played / live.video.target) * 100)}%"></i></div><span class="small num">${fmtSec(live.video.played)} / ${fmtSec(live.video.target)}</span></div>` : ''}
        </div>
        <button class="btn sm danger" id="apStop">叫停</button></div>`
    : '';
  el.innerHTML = `
    <div class="card-h"><h2>自动养号</h2>
      <label class="row small" style="gap:8px">${c.enabled ? '<span class="chip green">运行中</span>' : '<span class="chip">已关闭</span>'}
        <span class="switch"><input type="checkbox" id="apToggle" ${c.enabled ? 'checked' : ''}><span></span></span></label></div>
    ${liveHtml}
    <div class="dial" style="margin-top:${live.running ? 12 : 0}px">${dial}</div>
    <div class="row wrap small" style="justify-content:space-between">
      <span class="muted">${ap.pause ? `⏸ 号主叫停了${ap.pause.reason ? `（${esc(ap.pause.reason)}）` : ''}，${ap.pause.untilResume ? `等他说好了（最晚 ${hm(ap.pause.until)}）` : `到 ${hm(ap.pause.until)}`}` : ap.cooldownUntil ? `🧊 风控冷却到 ${hm(ap.cooldownUntil)}` : !c.enabled ? '打开后，会在蓝色的时辰里随机挑时间去刷' : next ? `下一轮：${next.label.slice(0, 2)} ${hm(next.at)}` : '今天的计划都跑完了'}
      ${ap.lastRun ? ` · 上一轮 ${ago(ap.lastRun.at)}` : ''}
      ${(ap.blocks || []).length ? `<br>⏸ 暂停中：${ap.blocks.map((b) => `${esc(b.name)}（到 ${new Date(b.until).getMonth() + 1}/${new Date(b.until).getDate()} ${hm(b.until)}）`).join('、')}` : ''}</span>
      <span class="row">${ap.pause ? '<button class="btn sm" id="apResume">恢复</button>' : ''}${ap.cooldownUntil ? '<button class="btn sm" id="apCool">解除冷却</button>' : ''}
        <button class="btn sm" ${live.running ? 'disabled' : ''} id="apRun">现在刷一轮</button>
        <a class="btn sm ghost" href="#/autopilot">设置</a></span>
    </div>`;
  $('#apToggle', el).onchange = (e) => busy(null, async () => {
    await api('/api/autopilot/config', { enabled: e.target.checked });
    toast(e.target.checked ? '自动养号已打开' : '自动养号已关闭');
    route();
  });
  const run = $('#apRun', el);
  if (run) run.onclick = () => busy(run, async () => { await api('/api/autopilot/run', {}); toast('她去刷B站了'); pollLive(); });
  const stop = $('#apStop', el);
  if (stop) stop.onclick = () => busy(stop, async () => { await api('/api/autopilot/stop', {}); toast('已叫停，这个视频看完当前心跳就停'); });
  const cool = $('#apCool', el);
  if (cool) cool.onclick = () => busy(cool, async () => { await api('/api/autopilot/clear-cooldown', {}); route(); });
  const resume = $('#apResume', el);
  if (resume) resume.onclick = () => busy(resume, async () => { await api('/api/pause/clear', {}); toast('她接着过自己的日子了'); route(); });
}

let liveTimer = null;
function pollLive() {
  clearTimeout(liveTimer);
  liveTimer = setTimeout(async () => {
    try {
      const ap = await api('/api/autopilot');
      const el = $('#apCard');
      if (el && S.page === 'overview') renderApCard(el, ap);
      $('#footStatus').innerHTML = ap.live.running ? '<span class="pulse"></span> 她正在刷B站' : ap.config.enabled ? '自动养号 · 开' : '自动养号 · 关';
      if (ap.live.running) pollLive();
      else if (S.page === 'overview') route();
    } catch { /* ignore */ }
  }, 3000);
}

// 单系列柱状图：每天看了几个视频（今天用粉色）。悬停显示当天明细。
function renderChart(el, series) {
  const W = 700, H = 190, P = { l: 28, r: 8, t: 10, b: 24 };
  const max = Math.max(4, ...series.map((d) => d.watch));
  const step = Math.ceil(max / 4);
  const top = step * 4;
  const iw = W - P.l - P.r, ih = H - P.t - P.b;
  const bw = iw / series.length;
  const y = (v) => P.t + ih - (v / top) * ih;
  let g = '';
  for (let i = 0; i <= 4; i++) {
    const v = i * step;
    g += `<line class="grid-l" x1="${P.l}" x2="${W - P.r}" y1="${y(v)}" y2="${y(v)}"/><text class="ax" x="${P.l - 6}" y="${y(v) + 4}" text-anchor="end">${v}</text>`;
  }
  const today = localDate();
  series.forEach((d, i) => {
    const x = P.l + i * bw;
    const h = Math.max(0, ih - (y(d.watch) - P.t));
    const w = Math.min(28, bw - 6);
    const bx = x + (bw - w) / 2;
    const r = Math.min(4, h / 2);
    const path = h > 0 ? `M${bx},${P.t + ih} V${P.t + ih - h + r} Q${bx},${P.t + ih - h} ${bx + r},${P.t + ih - h} H${bx + w - r} Q${bx + w},${P.t + ih - h} ${bx + w},${P.t + ih - h + r} V${P.t + ih} Z` : '';
    const lab = i % 2 === series.length % 2 || d.date === today ? `<text class="ax" x="${x + bw / 2}" y="${H - 6}" text-anchor="middle">${d.date === today ? '今天' : Number(d.date.slice(8))}</text>` : '';
    g += `<g data-i="${i}"><rect class="hit" x="${x}" y="${P.t}" width="${bw}" height="${ih}"/>${path ? `<path class="barm ${d.date === today ? 'today' : ''}" d="${path}"/>` : ''}${lab}</g>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="近14天每天看视频数">${g}</svg>`;
  const tip = $('#tip');
  $$('g[data-i]', el).forEach((n) => {
    n.addEventListener('mousemove', (e) => {
      const d = series[Number(n.dataset.i)];
      tip.innerHTML = `<b>${dayLabel(d.date)}</b><br>看视频 ${d.watch} 个 · ${fmtSec(d.seconds)}<br>点赞 ${d.like} · 评论 ${d.comment} · 分享 ${d.share}`;
      tip.style.left = e.clientX + 'px';
      tip.style.top = e.clientY - 8 + 'px';
      tip.style.position = 'fixed';
      tip.classList.add('show');
    });
    n.addEventListener('mouseleave', () => tip.classList.remove('show'));
  });
}

// ─── 活动记录 ──────────────────────────────────────────────
function tlItem(a, compact) {
  const [ico, name] = KIND[a.kind] || ['•', a.kind];
  const src = SOURCE[a.source || 'panel'] || ['?', ''];
  const vid = /^BV/i.test(a.target || '') ? a.target : '';
  const text = a.detail || a.title || a.target || name;
  return `<li class="${a.ok ? '' : 'bad'}" ${vid ? `data-bvid="${esc(vid)}" style="cursor:pointer"` : ''}>
    <div class="time num">${hm(a.ts)}</div>
    <div class="ico ${esc(a.kind)}">${ico}</div>
    <div class="body"><div class="x">${esc(compact ? text.slice(0, 60) : text)}</div>
      ${a.meta?.thought ? `<div class="thought">💭 ${esc(a.meta.thought)}${a.meta.score ? ` <span class="muted">${'♥'.repeat(a.meta.score)}</span>` : ''}</div>` : ''}
      <div class="m"><span class="chip ${src[1]}">${src[0]}</span>${compact ? '' : `<span>${name}</span>`}${a.error ? `<span class="err">${esc(a.error)}</span>` : ''}</div></div>
  </li>`;
}

async function pageActivity(main) {
  const F = (S.actF ||= { source: '', kind: '', date: '', q: '' });
  main.innerHTML = head('活动记录', '她每一次看、赞、评、发，都记在这里（自动养号 / 面板操作 / QQ 里的她）') +
    `<div class="card">
      <div class="filters">
        <div class="seg" id="srcSeg">${[['', '全部'], ['auto', '自动'], ['panel', '面板'], ['bot', 'QQ里的她']].map(([k, n]) => `<button data-v="${k}" class="${F.source === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <select id="kindSel" style="width:auto">
          <option value="">所有动作</option>
          <option value="watch">看视频</option><option value="like">点赞</option><option value="comment,reply_comment,join">评论 / 回复</option><option value="social,join,reply_like">评论区社交</option>
          <option value="share,coin">分享 / 投币</option><option value="dm_send">私信</option><option value="session_start,session_end">每一轮</option>
          <option value="mind,dig">心里想 / 顺藤摸瓜</option><option value="error,cooldown">出错 / 风控</option>
        </select>
        <input type="date" id="dateIn" value="${esc(F.date)}" style="width:auto">
        <input id="qIn" placeholder="搜标题 / 内容" value="${esc(F.q)}" style="width:200px">
        <span class="spacer"></span><span class="small muted" id="actTotal"></span>
      </div>
      <div id="actList"><div class="empty">加载中…</div></div>
    </div>`;
  $('#kindSel').value = F.kind;
  const load = async () => {
    const qs = new URLSearchParams({ limit: 400, ...Object.fromEntries(Object.entries(F).filter(([, v]) => v)) });
    try {
      const r = await api('/api/actions?' + qs);
      $('#actTotal').textContent = `共 ${r.total} 条`;
      if (!r.list.length) { $('#actList').innerHTML = '<div class="empty"><span class="fish">🫧</span>这里还空空的</div>'; return; }
      let html = '', cur = '';
      for (const a of r.list) {
        const d = localDate(new Date(a.ts));
        if (d !== cur) { if (cur) html += '</ul>'; html += `<div class="tl-day">${dayLabel(d)} · ${d}</div><ul class="tl">`; cur = d; }
        html += tlItem(a);
      }
      $('#actList').innerHTML = html + '</ul>';
    } catch (e) { $('#actList').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $$('#srcSeg button').forEach((b) => (b.onclick = () => { F.source = b.dataset.v; $$('#srcSeg button').forEach((x) => x.classList.toggle('on', x === b)); load(); }));
  $('#kindSel').onchange = (e) => { F.kind = e.target.value; load(); };
  $('#dateIn').onchange = (e) => { F.date = e.target.value; load(); };
  let qt; $('#qIn').oninput = (e) => { clearTimeout(qt); qt = setTimeout(() => { F.q = e.target.value.trim(); load(); }, 300); };
  load();
}

// ─── 自动养号设置 ──────────────────────────────────────────
async function pageAutopilot(main) {
  main.innerHTML = head('自动养号', '她会在你选的时辰里，随机挑个时间去刷B站：真的看视频（留下观看记录）、随缘点赞、分享、评论') + '<div class="empty">加载中…</div>';
  const ap = await api('/api/autopilot');
  if (S.page !== 'autopilot') return;
  const c = structuredClone(ap.config);
  const planBy = Object.fromEntries((ap.plan || []).map((s) => [s.key, s]));
  const num = (path, label, opt = {}) => {
    const v = path.split('.').reduce((o, k) => o[k], c);
    const shown = opt.pct ? Math.round(v * 100) : v;
    return `<div><label class="f">${label}</label><input type="number" data-path="${path}" ${opt.pct ? 'data-pct="1"' : ''} value="${shown}" min="${opt.min ?? 0}" max="${opt.max ?? 9999}" step="${opt.step ?? 1}">${opt.hint ? `<div class="hint">${opt.hint}</div>` : ''}</div>`;
  };
  const sel = (path, label, options, hint) => {
    const v = path.split('.').reduce((o, k) => o[k], c);
    return `<div><label class="f">${label}</label><select data-path="${path}">${options.map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${n}</option>`).join('')}</select>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  };
  const tog = (path, label, hint) => {
    const v = path.split('.').reduce((o, k) => o[k], c);
    return `<div><label class="f">${label}</label><label class="row"><span class="switch"><input type="checkbox" data-path="${path}" ${v ? 'checked' : ''}><span></span></span><span class="small muted">${hint || ''}</span></label></div>`;
  };
  const llmNote = ap.llmReady ? '<span class="chip green">已配置</span>' : '<span class="chip amber">未配置：评论会交给 QQ 里的她</span>';

  main.innerHTML = head('自动养号', '她会在你选的时辰里，随机挑个时间去刷B站：真的看视频（留下观看记录）、随缘点赞、分享、评论',
      `<span class="small muted">总开关</span><span class="switch"><input type="checkbox" data-path="enabled" ${c.enabled ? 'checked' : ''}><span></span></span>`) +
    `<div class="grid g-3">
     <div class="card span-2">
      <div class="cfg-sec">
        <h3>什么时候刷</h3>
        <p>点选时辰（蓝色 = 会去刷）。每个时辰里随机挑一个时间点，还会按概率随机跳过几次，不像打卡机。电脑睡着时错过的就错过了，醒来时辰还没过会补上。</p>
        <div class="dial pick" id="dialPick">${ap.shichen.map((sc) => {
          const s = planBy[sc.key];
          return `<div class="h ${c.windows.includes(sc.key) ? 'sel' : ''}" data-k="${sc.key}" title="${esc(sc.label)}">${sc.key}<small>${pad(sc.start)}–${pad(sc.end)}</small></div>`;
        }).join('')}</div>
        <div class="cfg-grid">${num('windowChance', '每个时辰去刷的概率 %', { pct: 1, max: 100, hint: '85% ≈ 每周偶尔偷懒一两次' })}</div>
      </div>
      <div class="cfg-sec">
        <h3>怎么看视频</h3>
        <p>用网页播放器同款心跳（每 15 秒一次）上报进度，B站历史记录里能看到「看到第几秒」，也算每日观看经验。</p>
        <div class="cfg-grid">
          ${num('session.videosMin', '每轮最少看几个', { min: 1, max: 20 })}
          ${num('session.videosMax', '每轮最多看几个', { min: 1, max: 20 })}
          ${num('session.watchRatioMin', '最少看完 %', { pct: 1, max: 100 })}
          ${num('session.watchRatioMax', '最多看完 %', { pct: 1, max: 100 })}
          ${num('session.maxWatchSec', '单个视频最多看（秒）', { min: 30, max: 3600, hint: '长视频看一段就走' })}
          ${num('session.skipChance', '刷到不感兴趣直接划走 %', { pct: 1, max: 100 })}
          ${num('session.gapMinSec', '视频间隔最短（秒）', { max: 600 })}
          ${num('session.gapMaxSec', '视频间隔最长（秒）', { max: 600 })}
          ${num('session.maxDurationSec', '不看超过多少秒的视频', { min: 60, max: 7200 })}
        </div>
        <div class="field" style="margin-top:14px"><label class="f">她的兴趣（会拿来搜视频，回车添加，点一下删除）</label>
          <div class="tags" id="tags">${c.interests.map((t) => `<span class="chip blue" data-t="${esc(t)}">${esc(t)} ×</span>`).join('')}<input id="tagIn" placeholder="加一个…"></div></div>
        <div class="cfg-grid">
          ${num('session.sourceWeights.feed', '挑视频：首页推荐 权重', { max: 10 })}
          ${num('session.sourceWeights.interest', '兴趣搜索 权重', { max: 10 })}
          ${num('session.sourceWeights.hot', '热门榜 权重', { max: 10 })}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>互动</h3>
        <p>每日上限对所有来源合并计算（自动 + 面板 + QQ 里的她），账号只有一个。</p>
        <div class="cfg-grid">
          ${num('like.chance', '看完后点赞概率 %', { pct: 1, max: 100 })}
          ${num('like.dailyMax', '每天最多点赞', { max: 100 })}
          ${tog('share.daily', '每天分享一次', '+5 经验')}
          ${sel('comment.mode', '评论方式', [['off', '不评论'], ['task', '交给 QQ 里的她写'], ['llm', 'AI 起草（用下面的模型）']], '「交给她」= 投到任务箱，你下次在 QQ 跟她说话时她会去写')}
          ${num('comment.chance', '看完后想评论的概率 %', { pct: 1, max: 100 })}
          ${num('comment.dailyMax', '每天最多评论', { max: 20 })}
          ${tog('comment.review', 'AI 评论先给我审', '强烈建议开着')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>🪟 她的窗</h3>
        <p>给她开一扇窗：此刻外面天黑没黑、太阳几点落的、今晚什么月亮、下没下雨。日照和月相按经纬度现算，天气一小时查一次（Open-Meteo，免 Key）。
        她刷之前想看什么、刷完心情怎么变、睡前反思都会看一眼窗外。不填地点就只知道几点。</p>
        <div class="cfg-grid">
          ${tog('sky.enabled', '让她看窗外')}
          <div><label class="f">住在哪个城市</label><input data-path="sky.place" value="${esc(c.sky.place || '')}" placeholder="比如：深圳" autocomplete="off"><div class="hint">${Number.isFinite(c.sky.lat) ? `已定位：${esc(c.sky.label || c.sky.place)}（${c.sky.lat}, ${c.sky.lon}）` : '保存时会查成经纬度；天气服务只会收到城市名和经纬度'}</div></div>
        </div>
      </div>
      <div class="cfg-sec">
        <h3>🗨️ 评论区社交 ${ap.llmReady ? '' : '<span class="chip amber">要先配模型</span>'}</h3>
        <p>看完视频翻评论区，看到真想接的热评就在楼里回一句；有人回她 / @她，她隔一阵看一眼，结合那串楼前面聊了啥、跟这个人熟不熟、自己现在的心情，<b>自己决定</b>回一句、只点个赞，还是不理。
        同一串楼回够次数就收住。发之前要不要审跟着上面「AI 评论先给我审」走，都计入评论的保险丝。只有<b>自动养号开着</b>时才会自己去看。</p>
        <div class="cfg-grid">
          ${tog('social.enabled', '启用评论区社交')}
          ${tog('social.join', '主动去热评下搭话')}
          ${num('social.joinChance', '看完后去搭话的概率 %', { pct: 1, max: 100, hint: '喜欢的视频更高，1~2 分的不搭' })}
          ${num('social.joinDailyMax', '每天最多搭话', { max: 20 })}
          ${tog('social.reply', '有人回她，自己决定回不回')}
          ${num('social.replyDailyMax', '每天最多回复', { max: 50 })}
          ${num('social.checkMin', '多久看一眼回复（分钟）', { min: 10, max: 600, hint: '会抖动；刷完一轮也会瞄一眼' })}
          ${num('social.threadMax', '同一串楼最多回几次', { min: 1, max: 20 })}
          ${num('social.likeChance', '顺手给对方评论点赞 %', { pct: 1, max: 100 })}
          ${num('social.quietStart', '深夜不回（从几点）', { max: 23 })}
          ${num('social.quietEnd', '深夜不回（到几点）', { max: 23 })}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>⭐ 特别关注</h3>
        <p>名单在右边。TA 发了新视频，她会优先去看（认真看 75%~100%），然后点赞、收藏、投币（受下面的投币开关和锁约束）、评论；发了图文/文字动态就顺手点个赞，再去看看 TA 最近没看过的视频。只有<b>自动养号开着</b>时才会自己去查。</p>
        <div class="cfg-grid">
          ${tog('vip.enabled', '启用特别关注')}
          ${tog('vip.asap', '有更新就尽快去看', '几分钟内；关掉则等下一个时辰顺路看')}
          ${num('vip.quietStart', '深夜不去（从几点）', { max: 23 })}
          ${num('vip.quietEnd', '深夜不去（到几点）', { max: 23 })}
          ${num('vip.checkMin', '多久看一眼动态（分钟）', { min: 10, max: 240, hint: '会随机抖动' })}
          ${num('vip.maxAgeHours', '只追多少小时内发的', { min: 1, max: 720 })}
          ${num('vip.dailyMax', '一天最多追几个视频', { min: 1, max: 30 })}
          ${num('vip.maxWatchSec', '单个视频最多看（秒）', { min: 60, max: 7200 })}
          ${tog('vip.like', '点赞')}
          ${tog('vip.favorite', '收藏', '进默认收藏夹')}
          ${tog('vip.coin', '投币', '优先投给 TA')}
          ${tog('vip.comment', '评论', '按上面的评论方式，计入每日上限')}
          ${tog('vip.likeDynamic', '给 TA 的动态点赞')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>投币</h3>
        <p>每枚 +10 经验，但新号每天只送 1 枚币。<b>接口投币只要失败一次就永久上锁</b>，免得反复失败把号搞成异常。</p>
        ${ap.coinLock ? `<div class="live" style="background:var(--amber-soft);margin-bottom:12px"><div style="flex:1"><b>🔒 投币已上锁</b><div class="small muted">${esc(ap.coinLock.reason || '')} · ${esc(String(ap.coinLock.at || '').slice(0, 16).replace('T', ' '))}</div></div><button class="btn sm" id="unlockCoin">我确认，解锁</button></div>` : ''}
        <div class="cfg-grid">
          ${tog('coin.enabled', '自动投币', ap.coinLock ? '上锁时不会投' : '只投给她点过赞的视频')}
          ${num('coin.dailyMax', '每天最多投几枚', { min: 1, max: 5 })}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>养鱼日记</h3>
        <p>每晚到点她自己写今天的日记（公开动态），从她当天心里想过的话往下写，不用你每天提醒。开着「先给我审」就进待审，你下次在 QQ 说话时她会问你；关掉就直接发。</p>
        <div class="cfg-grid">
          ${sel('diary.mode', '日记方式', [['off', '不写'], ['task', '交给 QQ 里的她写'], ['llm', 'AI 起草']])}
          ${num('diary.hour', '每晚几点以后写', { min: 18, max: 23, hint: '今晚还有没刷完的时辰就等它刷完；23:30 后不等' })}
          ${tog('diary.review', 'AI 日记先给我审', '动态是公开的')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>模型（可选）${llmNote}</h3>
        <p>任意 OpenAI 兼容接口，默认 DeepSeek 官方。Key 只存在本机 <code>panel/data/secrets.json</code>，不会进 git、也不会传回页面。</p>
        <div class="cfg-grid">
          <div><label class="f">接口地址</label><input data-path="llm.baseUrl" value="${esc(c.llm.baseUrl)}"></div>
          <div><label class="f">模型名</label><input data-path="llm.model" list="modelList" value="${esc(c.llm.model)}" autocomplete="off"><datalist id="modelList"></datalist><div class="hint">DeepSeek 官方填 deepseek-chat；本地网关一般是「提供方/模型」</div></div>
          <div><label class="f">API Key</label><input type="password" id="llmKey" placeholder="${ap.hasKey ? '已保存（留空不改）' : 'sk-…'}" autocomplete="off"></div>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="llmModels">列出可用模型</button><button class="btn sm" id="llmTest">测试连通</button><span class="small muted" id="llmMsg"></span></div>
        <div class="cfg-grid" style="margin-top:10px">
          ${num('llm.dailyCalls', '后台每天最多调几次', { max: 5000, hint: '内心、评论区社交、自动评论算在里面；0 = 不限' })}
          ${num('llm.dailyTokens', '后台每天最多用多少 tokens', { max: 50000000, step: 10000, hint: '到了就按老习惯随缘刷，第二天恢复' })}
        </div>
        ${usageLine(ap.llmUsage)}
      </div>
      <div class="cfg-sec">
        <h3>💬 QQ 连接 <span id="qqState"></span></h3>
        <p><b>官方机器人</b>：DSH + dsh-im-connect 插件，稳，但限制多（只能在你说话后一小时内回、不能主动找你，DSH 升级插件跟不上就掉线）。
        <b>她自己的小号</b>：Docker 里跑 NapCat（容器里的 QQ 登小号），面板自己当大脑，能主动找你、发真的语音，不依赖 DSH。用非官方框架，<b>小号有被冻结的风险</b>。装法见 <code>panel/qq/README.md</code>。
        <b>Telegram</b>：你在 @BotFather 建的 bot，官方接口不会被封，能主动找你、发语音条；这台 Mac 要能连上 Telegram（代理开全局 / TUN）。</p>
        <div id="qqLine"></div>
        <div class="cfg-grid">
          <div><label class="f">你的 QQ 号</label><input data-path="qq.ownerQQ" value="${esc(c.qq.ownerQQ || '')}" placeholder="她只跟你说话" autocomplete="off"></div>
          <div><label class="f">NapCat 地址</label><input data-path="qq.wsUrl" value="${esc(c.qq.wsUrl)}" autocomplete="off"><div class="hint">NapCat 里建的「WebSocket 服务器」</div></div>
          <div><label class="f">NapCat token</label><input type="password" id="onebotToken" placeholder="留空不改" autocomplete="off"></div>
          <div><label class="f">Telegram bot token</label><input type="password" id="telegramToken" placeholder="留空不改" autocomplete="off"><div class="hint">@BotFather 给的那串，只存本机 secrets.json</div></div>
          ${tog('qq.reachOut', '白天会主动找你', '隔了很久没听到你说话，她自己想想要不要找你')}
          ${num('qq.reachOutMax', '一天最多主动找几次', { max: 10 })}
          ${num('qq.silentHours', '你多久没说话才找（小时）', { min: 1, max: 24 })}
          ${num('qq.activeStart', '主动找你（从几点）', { max: 23 })}
          ${num('qq.activeEnd', '主动找你（到几点）', { max: 24 })}
          ${num('qq.voiceChance', '平时用语音回你的概率 %', { pct: 1, max: 100, hint: '短的话才会念，太长、带链接的照样打字；0 = 只在她自己想发时才发' })}
        </div>
        <div class="cfg-grid" style="margin-top:6px">
          ${tog('qq.dsh.enabled', '外挂：查资料 / 看图 / 做表情包', '借 DSH：查资料走她专用的 DSH 配置，看图和做表情走 DSH 本地网关')}
          <div><label class="f">看图用的模型</label><input data-path="qq.dsh.visionModel" value="${esc(c.qq.dsh.visionModel)}" autocomplete="off"></div>
          <div><label class="f">做表情用的改图模型（ModelScope）</label><input data-path="qq.dsh.imageModel" value="${esc(String(c.qq.dsh.imageModel).replace(/^modelscope\//, ''))}" autocomplete="off"><div class="hint">ModelScope 上的模型 ID</div></div>
          <div><label class="f">ModelScope 访问令牌</label><input type="password" id="modelscopeToken" placeholder="留空不改" autocomplete="off"><div class="hint">modelscope.cn/my/myaccesstoken 生成；账号要绑阿里云、过实名认证</div></div>
        </div>
        <div class="small muted" id="qqDsh" style="margin-top:4px"></div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="qqTest">发一条测试</button><button class="btn sm" id="qqImport">从 DSH 带记忆过来</button><span class="small muted" id="qqMsg"></span></div>
        <details style="margin-top:10px"><summary class="small">她记得的关于你的事（<span id="qqFactN">0</span> 条；记错了能删）</summary><div id="qqFacts" class="small"></div></details>
      </div>
      <div class="cfg-sec">
        <h3>📮 QQ 提醒 <span id="ntState"></span></h3>
        <p>起草好要你审的东西（今晚的日记、想发的评论、想回的话），她会在 QQ 里主动跟你说。你直接回「可以」她就发，回「改成……」就按你的改，「算了」就丢掉。
        用的是 QQ 官方机器人的<b>主动消息</b>，平台有条数限额；没发出去也没关系，下次你找她聊天时她会先问你。</p>
        <div class="cfg-grid">
          ${tog('notify.enabled', '在 QQ 里提醒我')}
          ${sel('notify.source', '用哪个机器人', [['dsh', '用 DSH 里接的那个'], ['manual', '手动填 AppID / Secret']], '凭证只在本机用，不会传回页面')}
          ${num('notify.dailyMax', '每天最多提醒几次', { min: 1, max: 10 })}
          ${num('notify.quietStart', '免打扰（从几点）', { max: 23 })}
          ${num('notify.quietEnd', '免打扰（到几点）', { max: 23 })}
          ${tog('notify.kinds.diary', '日记')}
          ${tog('notify.kinds.comment', '评论')}
          ${tog('notify.kinds.reply', '回复别人')}
        </div>
        <div class="cfg-grid" id="ntManual">
          <div><label class="f">AppSecret</label><input type="password" id="qqAppSecret" placeholder="留空不改" autocomplete="off"><div class="hint">QQ 开放平台 → 你的机器人 → 开发设置。DSH 不把它存成明文，这里得填一次</div></div>
          <div><label class="f">AppID</label><input id="qqAppId" placeholder="留空 = 用 DSH 的" autocomplete="off"></div>
          <div><label class="f">你的 openid</label><input id="qqOpenId" placeholder="留空 = 用 DSH 的" autocomplete="off"></div>
        </div>
        <div class="row" style="margin-top:10px"><button class="btn sm" id="ntTest">发一条测试</button><span class="small muted" id="ntMsg"></span></div>
      </div>
      <div class="cfg-sec">
        <h3>风控</h3>
        <p>遇到 -352 / -412 / -799 这类风控码，这一轮立刻停，然后歇一段时间。<br>
        点赞、分享、收藏这类动作只要被 B站 拒一次（比如 -403「账号异常」），就<b>单独暂停这个动作</b> 24 小时（连着再被拒：3 天、7 天），视频照样看。</p>
        ${(ap.blocks || []).map((b) => `<div class="live" style="background:var(--amber-soft);margin-bottom:8px"><div style="flex:1"><b>⏸ ${esc(b.name)}暂停到 ${new Date(b.until).toLocaleString('zh-CN', { hour12: false }).slice(5, -3)}</b><div class="small muted">B站 回的是「${esc(b.error)}」· 第 ${b.strikes} 次</div></div><button class="btn sm" data-unblock="${esc(b.kind)}">恢复</button></div>`).join('')}
        <div class="cfg-grid">${num('cooldownMin', '冷却多久（分钟）', { min: 10, max: 1440 })}</div>
      </div>
      <div class="save-bar"><button class="btn primary" id="saveCfg">保存设置</button></div>
     </div>
     <div>
      <div class="card"><div class="card-h"><h2>今天的计划</h2><button class="btn sm" id="replan">重新抽签</button></div>
        ${(ap.plan || []).length ? `<ul class="tl">${ap.plan.map((s) => `<li><div class="time num">${hm(s.at)}</div><div class="ico">${{ done: '✅', skipped: '💤', missed: '🌙', running: '🐟', failed: '⚠️', pending: '⏳' }[s.status] || '•'}</div>
          <div class="body"><div class="x">${esc(s.label)}</div><div class="m">${{ done: '刷完了', skipped: '随机偷懒', missed: '错过了（电脑睡着）', running: '正在刷', failed: '中断', pending: '等着' }[s.status] || s.status}${s.summary ? ' · ' + esc(s.summary) : ''}</div></div></li>`).join('')}</ul>` : '<div class="empty">没有选时辰</div>'}
        <div class="hint">${c.enabled ? '' : '⚠️ 总开关还没开，计划不会执行。'}</div>
      </div>
      <div style="height:16px"></div>
      <div class="card" id="vipCard"><div class="card-h"><h2>⭐ 特别关注</h2></div><div class="empty">加载中…</div></div>
      <div style="height:16px"></div>
      <div class="card" id="socialCard"></div>
      <div style="height:16px"></div>
      <div class="card"><div class="card-h"><h2>为什么这样设计</h2></div>
        <div class="small" style="color:var(--text2)">
          <p style="margin-top:0">· <b>经验上限是死的</b>：登录 5 + 观看 5 + 分享 5 + 投币 ≤ 50。不投币时一天最多 15，刷再多也没用，反而像机器人。</p>
          <p>· <b>Lv6 要 28800 经验</b>，按每天 15 大约 5 年，每天投 1 枚币（25/天）约 3 年。没有捷径，「快速升级」的都是在拿号冒险。</p>
          <p>· <b>节操值 70</b> 是正式会员的常见值。保持它的关键是：不发违规内容、不被举报、不刷屏。</p>
          <p style="margin-bottom:0">· 所有动作都带随机间隔和随机时长，每天总量很小，接近一个普通人下班刷十几分钟B站。</p>
        </div>
      </div>
     </div>
    </div>`;

  $$('#dialPick .h').forEach((h) => (h.onclick = () => {
    const k = h.dataset.k;
    c.windows = c.windows.includes(k) ? c.windows.filter((x) => x !== k) : [...c.windows, k];
    h.classList.toggle('sel');
  }));
  const tags = $('#tags');
  tags.onclick = (e) => { const t = e.target.closest('[data-t]'); if (t) { c.interests = c.interests.filter((x) => x !== t.dataset.t); t.remove(); } };
  $('#tagIn').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    const v = e.target.value.trim();
    if (v && !c.interests.includes(v)) {
      c.interests.push(v);
      e.target.insertAdjacentHTML('beforebegin', `<span class="chip blue" data-t="${esc(v)}">${esc(v)} ×</span>`);
    }
    e.target.value = '';
  };
  const collect = () => {
    for (const el of $$('[data-path]', main)) {
      const keys = el.dataset.path.split('.');
      let o = c;
      for (const k of keys.slice(0, -1)) o = o[k];
      const last = keys[keys.length - 1];
      if (el.type === 'checkbox') o[last] = el.checked;
      else if (el.type === 'number') o[last] = el.dataset.pct ? Number(el.value) / 100 : Number(el.value);
      else o[last] = el.value;
    }
    if (c.session.videosMin > c.session.videosMax) c.session.videosMax = c.session.videosMin;
    if (c.session.watchRatioMin > c.session.watchRatioMax) c.session.watchRatioMax = c.session.watchRatioMin;
    const order = ap.shichen.map((s) => s.key);
    c.windows.sort((a, b) => order.indexOf(a) - order.indexOf(b));
    return c;
  };
  const save = async (extra = {}) => {
    const body = { ...collect(), ...extra };
    if (body.vip) delete body.vip.users; // 名单走单独的接口，别被这个页面里的旧名单覆盖
    const k = $('#llmKey').value.trim();
    if (k) body.llmApiKey = k;
    for (const id of ['qqAppId', 'qqAppSecret', 'qqOpenId', 'onebotToken', 'telegramToken', 'modelscopeToken']) {
      const v = $('#' + id)?.value.trim();
      if (v) body[id] = v;
    }
    await api('/api/autopilot/config', body);
  };
  $('#saveCfg').onclick = (e) => busy(e.target, async () => { await save(); toast('设置已保存'); route(); });
  $('[data-path="enabled"]', main).onchange = (e) => busy(null, async () => { await save({ enabled: e.target.checked }); toast(e.target.checked ? '自动养号已打开' : '已关闭'); route(); });
  $('#replan').onclick = (e) => busy(e.target, async () => { await save(); await api('/api/autopilot/replan', {}); toast('重新抽好了'); route(); });
  // 测试前先保存，测的就是框里现在填的
  $('#llmTest').onclick = (e) => busy(e.target, async () => {
    await save();
    const r = await api('/api/autopilot/llm-test', {});
    $('#llmMsg').textContent = '✓ 连上了，模型回复：' + r.reply;
    toast('模型连上了');
  });
  $('#llmModels').onclick = (e) => busy(e.target, async () => {
    await save();
    const { models } = await api('/api/autopilot/llm-models', {});
    $('#modelList').innerHTML = models.map((m) => `<option value="${esc(m)}">`).join('');
    $('#llmMsg').textContent = models.length ? `有 ${models.length} 个模型，点「模型名」输入框就能选` : '接口没返回模型列表，只能手填';
    const inp = $('[data-path="llm.model"]', main);
    if (models.length && !models.includes(inp.value.trim())) { inp.value = ''; inp.focus(); }
  });
  $$('[data-unblock]', main).forEach((b) => (b.onclick = async () => {
    if (!(await confirmBox('恢复这个动作？', 'B站 刚拒过它。恢复后如果再被拒，会暂停更久。', '恢复'))) return;
    busy(b, async () => { await api('/api/blocks/clear', { kind: b.dataset.unblock }); toast('已恢复'); route(); });
  }));
  renderVipCard($('#vipCard'));
  renderSocialCard($('#socialCard'), ap.social);
  // QQ 提醒
  const ntRefresh = () => api('/api/notify').then((n) => {
    $('#ntState').innerHTML = n.ready ? '<span class="chip green">机器人可用</span>' : `<span class="chip amber">${esc(n.why || '未配置')}</span>`;
    const last = n.log[0];
    $('#ntMsg').textContent = `今天提醒了 ${n.sentToday} 次` +
      (n.direct ? ' · 用小号发，随时能说' : n.windowOpen ? ` · 回复窗口开着（到 ${hm(n.windowUntil)}）` : ' · 你最近一小时没在 QQ 说话，提醒会等你开口再发') +
      (n.pending ? ` · ${n.pending} 条排队中` : '') +
      (last ? ` · 最近一次${last.ok ? '成功' : '失败：' + (last.error || '')}` : '');
  }).catch(() => {});
  ntRefresh();
  $('#ntTest').onclick = (e) => busy(e.target, async () => {
    await save();
    await api('/api/notify/test', {});
    toast('发出去了，看看 QQ');
    ntRefresh();
  });
  // QQ 连接
  const qqRender = (q) => {
    const name = q.mode === 'telegram' ? 'Telegram' : '小号';
    $('#qqState').innerHTML = q.mode === 'official' ? '<span class="chip">官方机器人</span>'
      : q.connected ? `<span class="chip green">${name}在线 ${esc(String(q.selfId || ''))}</span>`
      : `<span class="chip amber">${q.on ? `${name}没连上` : q.mode === 'telegram' ? '还没填 bot token' : '还没填你的 QQ 号'}</span>`;
    $('#qqMsg').textContent = q.mode !== 'official' ? [q.error && !q.connected ? `上次的错：${q.error}` : '', q.lastOwnerAt ? `你上次说话 ${ago(q.lastOwnerAt)}` : ''].filter(Boolean).join(' · ') : '';
    renderQqLine(q);
    const d = q.dsh || {};
    $('#qqDsh').textContent = !d.enabled ? '外挂关着' : !d.cli ? '⚠️ 没找到 DSH 的命令行，查资料用不了' : !d.profile ? `⚠️ DSH 里还没有「她专用」的配置，查资料用不了（见 panel/qq/README.md）` : `外挂就绪：查资料走她专用的 DSH · ${d.hasModelscopeToken ? '做表情包：令牌已填' : '做表情包：还没填 ModelScope 令牌'}${d.stickerOn ? ` · 今天（${d.stickerOn}）做过新表情了` : ''}`;
    $('#qqFactN').textContent = q.facts.length;
    $('#qqFacts').innerHTML = q.facts.length ? q.facts.slice().reverse().map((f) => `<div class="row" style="justify-content:space-between;gap:8px;padding:3px 0"><span><span class="chip">${esc(f.kind)}</span> ${esc(f.text)} <span class="muted">${esc(f.at)}</span></span><button class="btn sm ghost" data-fact="${esc(f.id)}">×</button></div>`).join('') : '<div class="empty">还没记什么</div>';
    for (const b of $$('[data-fact]', main)) b.onclick = () => busy(b, async () => qqRender(await api('/api/qq/fact/delete', { id: b.dataset.fact })));
  };
  // 一键切线路：改配置 + 起停 NapCat 容器 + 重连，一步到位，不用自己开终端跑 docker
  let qqQrTimer = null; // 等二维码的轮询
  const renderQqLine = (q) => {
    clearTimeout(qqQrTimer); // 每次重画都先把上一次的等待掐掉，免得堆一堆定时器
    const box = $('#qqLine');
    if (!box) return;
    const ct = q.container || {};
    const isSmall = q.mode === 'onebot';
    const isTg = q.mode === 'telegram';
    const ctText = !ct.docker ? '<span class="chip amber">没装 docker</span>'
      : !ct.exists ? '<span class="chip">容器还没建过</span>'
      : ct.running ? `<span class="chip green">容器在跑</span> <span class="muted small">${esc(ct.detail || '')}</span>`
      : `<span class="chip amber">容器停着</span> <span class="muted small">${esc(ct.detail || '')}</span>`;
    const act = [];
    if (isTg) {
      act.push(!q.hasTgToken ? '在下面填上 bot token，点「保存设置」。'
        : q.tgOwner ? `认出的你：<b>${esc(q.tgOwner)}</b>（不是你就点「解绑」，再用自己的号给 bot 发一句）。`
        : '在 Telegram 里打开你的 bot 点「Start」：第一个私聊它的人会被认成你。');
    } else if (!isSmall) {
      act.push('切回官方时，容器会自动停掉——留着它会在后台每 2 分钟重登一次、次次失败，账号只会越弄越糟。');
    } else if (!ct.docker) {
      act.push('先装 OrbStack（https://orbstack.dev）或 Docker Desktop，打开一次，再回来点「起容器」。');
    } else {
      act.push('小号加你大号为好友；面板连上后就能主动找你、发真语音。');
    }
    box.innerHTML = `<div class="row wrap" style="gap:8px;align-items:center;margin:10px 0 4px">
        <span class="small muted">现在走：</span><b style="font-size:13px">${isTg ? 'Telegram bot' : isSmall ? '她自己的小号（NapCat）' : '官方机器人（DSH 插件）'}</b>
        <span style="flex:1"></span>${ctText}
      </div>
      <div class="row wrap">
        <button class="btn sm ${isSmall || isTg ? '' : 'primary'}" id="qqToSmall" ${isSmall ? 'disabled' : ''}>换成小号线路</button>
        <button class="btn sm ${isTg ? '' : 'primary'}" id="qqToTg" ${isTg ? 'disabled' : ''}>换成 Telegram</button>
        <button class="btn sm" id="qqToOfficial" ${q.mode === 'official' ? 'disabled' : ''}>换回官方机器人</button>
        ${isTg && q.tgOwner ? '<button class="btn sm ghost" id="qqTgUnbind">解绑</button>' : ''}
        ${ct.docker ? `<button class="btn sm ghost" id="qqCtUp" ${ct.running ? 'disabled' : ''}>${ct.exists ? '起容器' : '建容器'}</button>
        <button class="btn sm ghost" id="qqCtDown" ${ct.running ? '' : 'disabled'}>停容器</button>
        <button class="btn sm ghost" id="qqCtRestart" ${ct.running ? '' : 'disabled'}>重启换张码</button>` : ''}
      </div>
      <div class="small muted" style="margin-top:6px">${act.join('')}</div>
      ${isSmall && q.qr ? `<div class="row wrap" style="margin-top:10px;gap:12px;align-items:flex-start">
        <img src="${q.qr.dataUrl}" alt="登录二维码" style="width:168px;height:168px;border:1px solid var(--line);border-radius:12px;background:#fff;padding:6px">
        <div class="small muted" style="max-width:320px">
          <div style="margin-bottom:4px">用<b>小号</b>的手机 QQ 扫码登录（拿到码约 ${Math.round((Date.now() - q.qr.at) / 1000)} 秒前）。</div>
          <div>也可以打开 <a href="http://127.0.0.1:6099/webui" target="_blank">NapCat WebUI</a>，密钥在 <code>panel/qq/napcat/.env</code> 里。</div>
          <div style="margin-top:4px">码过期就点「重启换张码」。</div>
        </div></div>`
        : isSmall ? `<div class="small muted" style="margin-top:8px" id="qqQrWait">${!ct.docker ? '没装 docker，起不了容器。' : !ct.exists ? '容器还没建过，点「建容器」。' : ct.running ? '容器在跑，正在等它的登录二维码…（快则几秒，第一张可能要等它把 QQ 拉起来）' : '容器停着，先「起容器」再拿码。'}</div>` : ''}`;
    const go = (btn, body, ok) => { if (btn) btn.onclick = (e) => busy(e.target, async () => { const r = await api(body.path, body.body); toast(r.napcatNote ? `切好了 ${r.napcatNote}` : ok); qqRender(r); }); };
    go($('#qqToSmall'), { path: '/api/qq/mode', body: { mode: 'onebot' } }, '切到小号线路了，扫下面的码登小号');
    go($('#qqToOfficial'), { path: '/api/qq/mode', body: { mode: 'official' } }, '切回官方机器人了');
    go($('#qqToTg'), { path: '/api/qq/mode', body: { mode: 'telegram' } }, '切到 Telegram 了');
    go($('#qqTgUnbind'), { path: '/api/qq/tg/unbind', body: {} }, '解绑了，用你的号给 bot 发一句');
    for (const [id, action, ok] of [['qqCtUp', 'up', '容器起来了'], ['qqCtDown', 'down', '容器停了'], ['qqCtRestart', 'restart', '重启了，等几秒出新码']]) {
      const b = $('#' + id);
      if (b) b.onclick = (ev) => busy(ev.target, async () => { const r = await api('/api/qq/napcat', { action }); toast(ok); qqRender(r); });
    }
    // 容器在跑、码还没出来：自己盯着，出了码就把码显示出来（小号第一次拉起来要等它把 QQ 跑起来）
    if (isSmall && ct.running && !q.qr) {
      clearTimeout(qqQrTimer);
      let tries = 0;
      const wait = async () => {
        try {
          if (!$('#qqQrWait') || S.page !== 'autopilot') return; // 页面走了就别再查
          const r = await api('/api/qq');
          if (r.qr) { qqRender(r); return; }
          if (++tries >= 20) { const el = $('#qqQrWait'); if (el) el.textContent = '还没等到二维码。点「重启换张码」，或者打开 WebUI 看看容器里 QQ 的状态。'; return; }
          qqQrTimer = setTimeout(wait, 4000);
        } catch { /* 面板重启或网络抖一下就下次再来 */ }
      };
      qqQrTimer = setTimeout(wait, 4000);
    }
  };
  api('/api/qq').then(qqRender).catch(() => {});
  $('#qqTest').onclick = (e) => busy(e.target, async () => {
    await save();
    await new Promise((r) => setTimeout(r, 1500)); // 刚改设置的话等它连上
    await api('/api/qq/test', {});
    toast('发出去了，去看看');
    qqRender(await api('/api/qq'));
  });
  $('#qqImport').onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/qq/import-dsh', {});
    toast(r.why || `带过来 ${r.added} 条，现在一共记得 ${r.total} 条`);
    qqRender(r);
  });
  const un = $('#unlockCoin');
  if (un) un.onclick = async () => {
    if (!(await confirmBox('解锁投币？', '之前接口投币失败过。解锁后如果再失败会自动重新上锁。\n建议先在浏览器里确认这个号投币正常，再解锁。', '解锁'))) return;
    busy(un, async () => { await api('/api/coin/unlock', {}); toast('已解锁'); route(); });
  };
}

// ─── 扫码登录 ──────────────────────────────────────────────
function renderLoginBanner(acct) {
  let el = $('#loginBanner');
  const out = acct && !acct.loggedIn;
  if (!out) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'loginBanner';
    el.className = 'login-banner';
    document.body.prepend(el);
  }
  el.innerHTML = '⚠️ B站 掉登录了，自动养号和所有操作都停着 <button class="btn sm primary">扫码登录</button>';
  $('button', el).onclick = () => openLogin();
  const f = $('#footLogin');
  if (f) f.onclick = (e) => { e.preventDefault(); openLogin(); };
}

// QQ 接入断了（DSH 升级后插件跟不上、网关没起来）：她在 QQ 里没法告诉你，只能挂在这儿
function renderHealthBanner(h) {
  let el = $('#healthBanner');
  if (!h || h.ok) { el?.remove(); return; }
  if (!el) {
    el = document.createElement('div');
    el.id = 'healthBanner';
    el.className = 'login-banner';
    document.body.prepend(el);
  }
  el.innerHTML = h.problems.map((p) => `<span>⚠️ ${esc(p.text)}<br><span class="small" style="font-weight:400">${esc(p.fix)}</span></span>`).join('')
    + ' <button class="btn sm">修好了，再查一次</button>';
  $('button', el).onclick = (e) => busy(e.target, async () => { renderHealthBanner(await api('/api/health?fresh=1')); });
}

let loginTimer = null;
async function openLogin() {
  openDrawer('扫码登录 B站', '<div class="empty">取二维码…</div>');
  clearTimeout(loginTimer);
  let q;
  try { q = await api('/api/login/qr', {}); } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  $('#drawerBody').innerHTML = `
    <div class="qr-box">
      <div class="qr">${q.svg}</div>
      <div id="qrMsg" class="qr-msg">用手机 <b>B站 App</b> 扫一扫（首页左上角头像旁边 / 「我的」右上角），然后点确认登录</div>
      <div class="hint">要登录的是她的号「在逃肥鱼公主」，别扫成你自己的号。二维码大约 3 分钟过期。</div>
      <button class="btn sm" id="qrNew" style="margin-top:10px">换一张</button>
    </div>`;
  $('#qrNew').onclick = () => openLogin();
  const poll = async () => {
    if (!$('#drawer').classList.contains('show') || !$('#qrMsg')) return; // 抽屉关了就别再查
    let r;
    try { r = await api('/api/login/poll?key=' + encodeURIComponent(q.key)); } catch (e) { r = { status: 'waiting', net: e.message }; }
    const msg = $('#qrMsg');
    if (!msg) return;
    if (r.status === 'ok') {
      msg.innerHTML = '✅ 登录成功！';
      toast('重新登录好了');
      setTimeout(() => { closeDrawer(); route(); }, 900);
      return;
    }
    if (r.status === 'expired' || Date.now() > q.expiresAt + 10_000) {
      msg.innerHTML = '二维码过期了 <button class="btn sm primary" id="qrAgain">再来一张</button>';
      $('#qrAgain').onclick = () => openLogin();
      $('.qr').style.opacity = 0.25;
      return;
    }
    if (r.status === 'scanned') msg.innerHTML = '📱 扫到了，在手机上点「确认登录」';
    if (r.status === 'error') msg.innerHTML = `<span style="color:var(--red)">${esc(r.message)}</span> <button class="btn sm" id="qrAgain">重来</button>`;
    if (r.status === 'error') { $('#qrAgain').onclick = () => openLogin(); return; }
    loginTimer = setTimeout(poll, 2000);
  };
  loginTimer = setTimeout(poll, 2000);
}

// ─── 特别关注名单 ──────────────────────────────────────────
function renderSocialCard(el, s) {
  if (!el || !s) return;
  const when = (t) => (t ? new Date(t).toLocaleString('zh-CN', { hour12: false }).slice(5, -3) : '—');
  el.innerHTML = `<div class="card-h"><h2>🗨️ 评论区的熟人</h2><button class="btn sm" id="socialCheck" ${s.on ? '' : 'disabled'}>现在看一眼回复</button></div>
    <div class="small muted" style="margin-bottom:8px">今天搭话 ${s.today.join} · 回复 ${s.today.reply} · 上次看 ${when(s.lastCheck)} · 下次约 ${when(s.nextCheck)}${s.busy ? ' · 正在看…' : ''}</div>
    ${s.people.length ? `<ul class="vip-list">${s.people.map((p) => `<li><a href="https://space.bilibili.com/${esc(p.uid)}" target="_blank" rel="noopener">${esc(p.name)}</a><span class="small muted">聊过 ${p.n} 次 · ${when(p.last)}</span></li>`).join('')}</ul>` : '<div class="empty">还没跟谁聊过</div>'}`;
  const btn = $('#socialCheck', el);
  if (btn) btn.onclick = (e) => busy(e.target, async () => { const r = await api('/api/social/check', {}); toast(r.note); renderSocialCard(el, r.social); });
}

async function renderVipCard(el, data) {
  if (!el) return;
  let vip;
  let users;
  try {
    [vip, users] = data ? [data, data.users] : await Promise.all([api('/api/vip'), api('/api/vip/users').then((r) => r.users)]);
    users ??= (await api('/api/vip/users')).users;
  } catch (e) { el.innerHTML = `<div class="card-h"><h2>⭐ 特别关注</h2></div><div class="err">${esc(e.message)}</div>`; return; }
  if (!el.isConnected) return;
  const q = vip.queue || [];
  el.innerHTML = `<div class="card-h"><h2>⭐ 特别关注</h2><button class="btn sm" id="vipImport" title="把你在 B站 设的「特别关注」分组导进来">从B站导入</button></div>
    <div class="row" style="margin-bottom:10px"><input id="vipIn" placeholder="UID 或空间链接" style="flex:1;min-width:0"><button class="btn sm primary" id="vipAdd">添加</button></div>
    ${users.length ? `<ul class="vip-list">${users.map((u) => `<li>
        <img src="${esc(img(u.face, '48w_48h'))}" alt="" onerror="this.style.visibility='hidden'">
        <div style="flex:1;min-width:0"><a href="https://space.bilibili.com/${esc(u.uid)}" target="_blank" rel="noopener"><b>${esc(u.name)}</b></a>
          <div class="small muted">${esc(u.uid)} · ${u.following === false ? '<span style="color:var(--amber)">还没关注，动态流里看不到 TA</span>' : u.following ? '已关注' : '关注状态未知'}</div></div>
        ${u.following === false ? `<button class="btn sm" data-follow="${esc(u.uid)}" data-name="${esc(u.name)}">关注</button>` : ''}
        <button class="btn sm ghost" data-rm="${esc(u.uid)}" title="移出特别关注">×</button></li>`).join('')}</ul>` : '<div class="empty small">还没有人。加个 UID，或者从 B站 的特别关注分组导入。</div>'}
    <div class="small muted" style="margin-top:10px">${!vip.autopilotOn ? '⚠️ 自动养号没开，不会自己去查' : vip.lastCheck ? `上次查看 ${ago(vip.lastCheck)}${vip.nextCheck ? ` · 下次约 ${hm(vip.nextCheck)}` : ''}` : '还没查过'} · 今天追了 ${vip.doneToday}/${vip.config.dailyMax}</div>
    ${q.length ? `<div class="vip-q">${q.map((x) => x.type === 'video'
        ? `<div>📺 <a href="#" data-open="${esc(x.bvid)}">${esc(x.title)}</a> <span class="muted">· ${esc(x.name)}${x.why ? ' · ' + esc(x.why) : ''}</span></div>`
        : `<div>👍 <span class="muted">${esc(x.name)} 的动态：</span>${esc(x.text || '（图片）')}</div>`).join('')}
      ${vip.runAt ? `<div class="small muted">打算 ${hm(vip.runAt)} 去看</div>` : ''}</div>` : ''}
    <div class="row" style="margin-top:10px"><button class="btn sm" id="vipCheck">现在查一下</button>${q.length ? '<button class="btn sm primary" id="vipRun">现在就去看</button>' : ''}</div>`;

  const redraw = (r) => renderVipCard(el, r.users ? r : undefined);
  $('#vipAdd', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/vip/add', { uid: $('#vipIn', el).value });
    toast('加进特别关注了');
    redraw(r);
  });
  $('#vipIn', el).onkeydown = (e) => { if (e.key === 'Enter') $('#vipAdd', el).click(); };
  $('#vipImport', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/vip/import', {});
    toast(r.total ? `B站 分组里有 ${r.total} 个，新导入 ${r.imported} 个` : 'B站 的特别关注分组是空的');
    redraw(r);
  });
  $$('[data-rm]', el).forEach((b) => (b.onclick = () => busy(b, async () => redraw(await api('/api/vip/remove', { uid: b.dataset.rm })))));
  $$('[data-follow]', el).forEach((b) => (b.onclick = () => busy(b, async () => {
    await api('/api/vip/follow', { uid: b.dataset.follow, name: b.dataset.name });
    toast('关注了');
    renderVipCard(el);
  })));
  $$('[data-open]', el).forEach((a) => (a.onclick = (e) => { e.preventDefault(); openVideo(a.dataset.open); }));
  $('#vipCheck', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/vip/check', {});
    toast(r.found ? `发现 ${r.found} 条新动态` : '没有新东西');
    renderVipCard(el);
  });
  const run = $('#vipRun', el);
  if (run) run.onclick = () => busy(run, async () => { await api('/api/vip/run', {}); toast('她去看特别关注了，进度在总览里'); });
}

// ─── 刷视频 ────────────────────────────────────────────────
async function pageExplore(main) {
  const tab = (S.exTab ||= 'feed');
  main.innerHTML = head('刷视频', '在这里看到的和她看到的一样；点开视频可以让她去看、点赞、评论') +
    `<div class="card">
      <div class="filters">
        <div class="seg" id="exSeg">${[['feed', '首页推荐'], ['hot', '热门'], ['search', '搜索'], ['history', '观看历史']].map(([k, n]) => `<button data-v="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <span class="spacer"></span>
        <div class="row" id="exSearch" style="display:${tab === 'search' ? 'flex' : 'none'}"><input id="kw" placeholder="搜点什么" value="${esc(S.kw || '')}" style="width:220px"><button class="btn primary" id="kwGo">搜索</button></div>
        <button class="btn" id="exReload">换一批</button>
        <div class="row"><input id="bvIn" placeholder="BV号直达" style="width:150px"><button class="btn" id="bvGo">打开</button></div>
      </div>
      <div id="exOut"><div class="empty">加载中…</div></div>
    </div>`;
  const out = $('#exOut');
  const card = (v, extra = '') => `<div class="vcard" data-bvid="${esc(v.bvid)}">
      <div class="cover"><img src="${esc(img(v.pic, '336w_210h_1c'))}" loading="lazy" alt="" onerror="this.style.visibility='hidden'">
        ${v.duration || v.durationSec ? `<span class="dur">${fmtDur(v.duration || v.durationSec)}</span>` : ''}${extra}</div>
      <div class="tt">${esc(v.title)}</div>
      <div class="mm">${esc(v.owner || v.author || '')}${v.view != null ? ' · ▶ ' + fmtNum(v.view) : ''}</div></div>`;
  const load = async () => {
    out.innerHTML = '<div class="empty">加载中…</div>';
    try {
      if (S.exTab === 'search') {
        if (!S.kw) { out.innerHTML = '<div class="empty">输入关键词搜一搜</div>'; return; }
        const r = await api('/api/search?q=' + encodeURIComponent(S.kw));
        out.innerHTML = r.list.length ? `<div class="vgrid">${r.list.map((v) => card(v)).join('')}</div>` : '<div class="empty">没搜到</div>';
      } else if (S.exTab === 'history') {
        const r = await api('/api/history');
        out.innerHTML = r.list.length ? `<div class="vgrid">${r.list.map((v) => {
          const p = v.progress < 0 ? 100 : v.duration ? Math.min(100, (v.progress / v.duration) * 100) : 0;
          return card({ ...v, view: null, owner: `${v.owner} · ${ago(v.viewAt)} · ${v.progress < 0 ? '看完了' : '看到 ' + fmtSec(v.progress)}` }, `<span class="prog" style="width:${p}%"></span>`);
        }).join('')}</div>` : '<div class="empty">B站历史记录是空的</div>';
      } else {
        const r = await api(S.exTab === 'hot' ? '/api/hot' : '/api/feed');
        out.innerHTML = `<div class="vgrid">${r.list.map((v) => card(v)).join('')}</div>`;
      }
    } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  $$('#exSeg button').forEach((b) => (b.onclick = () => {
    S.exTab = b.dataset.v;
    $$('#exSeg button').forEach((x) => x.classList.toggle('on', x === b));
    $('#exSearch').style.display = S.exTab === 'search' ? 'flex' : 'none';
    load();
  }));
  const doSearch = () => { S.kw = $('#kw').value.trim(); load(); };
  $('#kwGo').onclick = doSearch;
  $('#kw').onkeydown = (e) => e.key === 'Enter' && doSearch();
  $('#exReload').onclick = load;
  const bv = () => { const v = $('#bvIn').value.trim().match(/BV[0-9A-Za-z]{10}/); v ? openVideo(v[0]) : toast('BV 号不对', 'err'); };
  $('#bvGo').onclick = bv;
  $('#bvIn').onkeydown = (e) => e.key === 'Enter' && bv();
  load();
}

// ─── 视频抽屉 ──────────────────────────────────────────────
function openDrawer(title, html) {
  $('#drawerTitle').textContent = title;
  $('#drawerBody').innerHTML = html;
  $('#drawer').classList.add('show');
  $('#drawerMask').classList.add('show');
  $('#drawerBody').scrollTop = 0;
}
function closeDrawer() { $('#drawer').classList.remove('show'); $('#drawerMask').classList.remove('show'); }
$('#drawerMask').onclick = closeDrawer;
$('#drawerClose').onclick = closeDrawer;
document.addEventListener('keydown', (e) => e.key === 'Escape' && closeDrawer());

function cmtHtml(c, ctx) {
  return `<div class="cmt"><img class="av" src="${esc(img(c.face, '68w_68h'))}" alt="" loading="lazy" onerror="this.style.visibility='hidden'">
    <div style="min-width:0"><div class="u">${esc(c.user)} <span class="muted">${c.ctime ? ago(c.ctime) : ''} · 👍 ${fmtNum(c.like)}</span></div>
      <div class="c">${esc(c.text)}</div>
      ${c.subs?.length ? `<div class="subs">${c.subs.map((s) => `<div><b>${esc(s.user)}</b>：${esc(s.text)}</div>`).join('')}${c.subCount > c.subs.length ? `<div class="muted">共 ${c.subCount} 条回复</div>` : ''}</div>` : ''}
      <div class="acts"><button class="btn sm ghost" data-reply="${esc(c.rpid)}" data-user="${esc(c.user)}" data-text="${esc(c.text.slice(0, 200))}">回复</button></div>
      <div class="reply-box" id="rb-${esc(c.rpid)}"></div>
    </div></div>`;
}

/** 通用回复框：AI 起草（可选）+ 发送。onSend(text) 返回 Promise */
function composer(el, { placeholder, context, message, kind = 'comment', onSend }) {
  if (el.innerHTML) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="composer"><textarea placeholder="${esc(placeholder)}"></textarea>
    <div class="row" style="margin-top:8px"><button class="btn sm" data-ai>✨ 让她想一句</button><span class="spacer"></span><button class="btn sm ghost" data-cancel>取消</button><button class="btn sm primary" data-send>发送</button></div></div>`;
  const ta = $('textarea', el);
  ta.focus();
  $('[data-cancel]', el).onclick = () => (el.innerHTML = '');
  $('[data-ai]', el).onclick = (e) => busy(e.target, async () => {
    const r = await api('/api/ai/reply', { context, message, kind });
    ta.value = r.text;
  });
  $('[data-send]', el).onclick = (e) => busy(e.target, async () => {
    const t = ta.value.trim();
    if (!t) throw new Error('写点什么再发');
    await onSend(t);
    el.innerHTML = '';
  });
}

async function openVideo(bvid) {
  openDrawer('视频', '<div class="empty">打开中…</div>');
  let v;
  try { v = (await api('/api/video?bvid=' + encodeURIComponent(bvid))).video; } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const locked = S.ov?.autopilot?.coinLock;
  $('#drawerBody').innerHTML = `
    <div class="vhead"><a href="https://www.bilibili.com/video/${esc(v.bvid)}" target="_blank" rel="noopener"><img src="${esc(img(v.pic, '672w_378h_1c'))}" alt=""></a>
      <h3>${esc(v.title)}</h3>
      <div class="row small" style="gap:8px"><img src="${esc(img(v.ownerFace, '48w_48h'))}" style="width:22px;height:22px;border-radius:50%" alt="" onerror="this.remove()"><b>${esc(v.owner)}</b><span class="muted">${esc(v.tname)} · ${fmtDur(v.duration)} · ${esc(v.bvid)}</span>${v.ownerUid ? '<button class="btn sm ghost" id="vVip" title="TA 一发新视频就优先去看">⭐ 特别关注 TA</button>' : ''}</div>
      <div class="stats" style="margin-top:8px"><span>▶ ${fmtNum(v.stat.view)}</span><span>💬 ${fmtNum(v.stat.reply)}</span><span>❤️ ${fmtNum(v.stat.like)}</span><span>🪙 ${fmtNum(v.stat.coin)}</span><span>⭐ ${fmtNum(v.stat.favorite)}</span><span>↗️ ${fmtNum(v.stat.share)}</span></div>
      ${v.desc ? `<div class="desc">${esc(v.desc)}</div>` : ''}
    </div>
    <div class="row wrap" style="margin-top:14px">
      <button class="btn primary" id="vWatch">📺 让她看这个</button>
      <button class="btn" id="vLike">❤️ 点赞</button>
      <button class="btn" id="vShare">↗️ 分享</button>
      <button class="btn" id="vFav">⭐ 收藏</button>
      <button class="btn" id="vCoin" ${locked ? 'disabled title="投币已上锁"' : ''}>🪙 投币${locked ? '（锁）' : ''}</button>
    </div>
    <div class="cfg-sec" style="margin-top:16px">
      <h3>发条评论</h3>
      ${v.noReply ? '<p>这个视频关闭了评论</p>' : `<textarea id="vCmt" placeholder="写点真实的感想…"></textarea>
      <div class="row" style="margin-top:8px"><button class="btn sm" id="vAi">✨ 让她想一句</button><span class="spacer"></span><button class="btn sm primary" id="vPost">发布评论</button></div>`}
    </div>
    <div class="cfg-sec"><h3>热评 <span class="muted small">${fmtNum(v.stat.reply)} 条</span></h3><div id="vCmts">${(v.comments || []).map((c) => cmtHtml(c)).join('') || '<div class="empty">没有评论</div>'}</div></div>`;

  $('#vWatch').onclick = (e) => busy(e.target, async () => {
    await api('/api/autopilot/run', { bvid: v.bvid });
    toast('她开始看这个视频了，进度在总览里');
    pollLive();
  });
  $('#vLike').onclick = (e) => busy(e.target, async () => { await api('/api/like', { bvid: v.bvid, title: v.title }); toast('点赞了'); });
  $('#vShare').onclick = (e) => busy(e.target, async () => { await api('/api/share', { bvid: v.bvid, title: v.title }); toast('分享了（+5 经验）'); });
  $('#vFav').onclick = (e) => busy(e.target, async () => { const r = await api('/api/favorite', { bvid: v.bvid, title: v.title }); toast(r.already ? '早就收藏过了' : '收藏了'); });
  const vv = $('#vVip');
  if (vv) vv.onclick = () => busy(vv, async () => { await api('/api/vip/add', { uid: v.ownerUid }); toast(`「${v.owner}」加进特别关注了`); });
  $('#vCoin').onclick = async (e) => {
    if (!(await confirmBox('投 1 个币？', '失败一次就会永久锁住投币。确定？', '投'))) return;
    busy(e.target, async () => { await api('/api/coin', { bvid: v.bvid, title: v.title }); toast('投币成功'); });
  };
  if (!v.noReply) {
    $('#vAi').onclick = (e) => busy(e.target, async () => { $('#vCmt').value = (await api('/api/ai/comment', { bvid: v.bvid })).text; });
    $('#vPost').onclick = (e) => busy(e.target, async () => {
      const t = $('#vCmt').value.trim();
      if (!t) throw new Error('写点什么再发');
      await api('/api/comment', { bvid: v.bvid, title: v.title, message: t });
      $('#vCmt').value = '';
      toast('评论发出去了');
    });
  }
  $('#vCmts').onclick = (e) => {
    const b = e.target.closest('[data-reply]');
    if (!b) return;
    composer($('#rb-' + b.dataset.reply), {
      placeholder: '回复 @' + b.dataset.user,
      context: '视频《' + v.title + '》',
      message: b.dataset.text,
      onSend: async (t) => { await api('/api/comment', { bvid: v.bvid, title: v.title, message: t, rootRpid: b.dataset.reply, parentRpid: b.dataset.reply }); toast('回复了'); },
    });
  };
}

// ─── 消息 ──────────────────────────────────────────────────
async function refreshUnread() {
  try {
    const u = await api('/api/inbox/unread');
    S.badges.inbox = (u.reply || 0) + (u.at || 0) + (u.dm || 0);
    renderNav();
    $$('#inSeg button').forEach((b) => {
      const n = u[b.dataset.v] || 0;
      const badge = $('.badge', b);
      if (!n && badge) badge.remove();
      else if (n && badge) badge.textContent = n;
    });
  } catch { /* ignore */ }
}

async function pageInbox(main) {
  const tab = (S.inTab ||= 'reply');
  const u = await api('/api/inbox/unread').catch(() => ({}));
  if (S.page !== 'inbox') return;
  const tabs = [['reply', '回复我的', u.reply], ['at', '@我', u.at], ['like', '收到的赞', u.like], ['dm', '私信', u.dm]];
  main.innerHTML = head('消息', '别人回复她、@她、给她点赞、私信她，都在这；可以直接替她回') +
    `<div class="filters"><div class="seg" id="inSeg">${tabs.map(([k, n, c]) => `<button data-v="${k}" class="${tab === k ? 'on' : ''}">${n}${c ? ` <span class="badge">${c}</span>` : ''}</button>`).join('')}</div>
     <span class="spacer"></span><a class="btn ghost sm" href="https://message.bilibili.com/" target="_blank" rel="noopener">在B站打开 ↗</a></div>
     <div id="inOut"></div>`;
  $$('#inSeg button').forEach((b) => (b.onclick = () => { S.inTab = b.dataset.v; route(); }));
  const out = $('#inOut');
  if (tab === 'dm') return renderDm(out);
  out.innerHTML = '<div class="card"><div class="empty">加载中…</div></div>';
  try {
    const r = await api('/api/inbox/' + tab);
    refreshUnread();
    if (!r.list.length) { out.innerHTML = '<div class="card"><div class="empty"><span class="fish">📭</span>还没有消息</div></div>'; return; }
    if (tab === 'like') {
      out.innerHTML = `<div class="card">${r.list.map((x) => `<div class="cmt"><img class="av" src="${esc(img(x.face, '68w_68h'))}" alt="" onerror="this.style.visibility='hidden'">
        <div><div class="u">${esc(x.users.slice(0, 3).join('、'))}${x.count > 1 ? ` 等 ${x.count} 人` : ''} <span class="muted">赞了她 · ${ago(x.time)}</span></div>
        <div class="q">${esc(x.title || x.desc)}</div></div></div>`).join('')}</div>`;
      return;
    }
    out.innerHTML = `<div class="card">${r.list.map((x, i) => `<div class="cmt"><img class="av" src="${esc(img(x.face, '68w_68h'))}" alt="" onerror="this.style.visibility='hidden'">
      <div style="min-width:0"><div class="u">${esc(x.user)} <span class="muted">${tab === 'at' ? '@了她' : '回复了她'} · ${ago(x.time)}</span></div>
        <div class="c">${esc(x.text)}</div>
        ${x.myText ? `<div class="q">她的原话：${esc(x.myText)}</div>` : ''}
        <div class="q">📺 ${x.uri ? `<a href="${esc(x.uri)}" target="_blank" rel="noopener">${esc(x.title)}</a>` : esc(x.title)}</div>
        <div class="acts"><button class="btn sm" data-i="${i}">回复</button></div>
        <div id="ib-${i}"></div></div></div>`).join('')}</div>`;
    out.onclick = (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      const x = r.list[Number(b.dataset.i)];
      composer($('#ib-' + b.dataset.i), {
        placeholder: '回复 @' + x.user,
        context: `视频/动态《${x.title}》${x.myText ? '；她之前说：' + x.myText : ''}`,
        message: x.text,
        onSend: async (t) => {
          await api('/api/comment', { oid: x.oid, type: x.type, message: t, rootRpid: x.root, parentRpid: x.rpid, title: x.title });
          toast('回复了');
        },
      });
    };
  } catch (e) { out.innerHTML = `<div class="card err">${esc(e.message)}</div>`; }
}

async function renderDm(out) {
  out.innerHTML = `<div class="card dm"><div class="dm-list" id="dmList"><div class="empty">加载中…</div></div>
    <div class="dm-pane"><div class="dm-msgs" id="dmMsgs"><div class="empty">选一个会话</div></div>
      <div class="dm-input"><textarea id="dmIn" placeholder="回复私信…（Enter 发送，Shift+Enter 换行）"></textarea>
        <div style="display:flex;flex-direction:column;gap:6px"><button class="btn sm" id="dmAi">✨</button><button class="btn primary" id="dmSend">发送</button></div></div></div></div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="dmReadAll">全部标为已读</button><span class="spacer"></span></div>
    <div class="hint" style="margin-top:8px">⚠️ 私信是直接对陌生人说话，发出去收不回。广告、引流、奇怪搭讪别回。</div>`;
  let cur = null, sessions = [];
  const openS = async (s) => {
    cur = s;
    $$('.dm-item').forEach((x) => x.classList.toggle('on', x.dataset.id === s.talkerId));
    const box = $('#dmMsgs');
    box.innerHTML = '<div class="empty">加载中…</div>';
    try {
      const r = await api('/api/messages/list?talkerId=' + s.talkerId);
      let last = 0;
      box.innerHTML = r.list.map((m) => {
        const t = (m.ts || 0) * 1000;
        const sep = t - last > 600000 ? `<div class="bubble-time">${new Date(t).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>` : '';
        last = t;
        return `${sep}<div class="bubble ${m.mine ? 'me' : ''}"><div>${esc(m.text)}</div></div>`;
      }).join('') || '<div class="empty">还没有消息</div>';
      box.scrollTop = box.scrollHeight;
      if (s.unread) {
        const seqno = Math.max(0, ...r.list.map((m) => m.seqno || 0));
        await api('/api/messages/read', { talkerId: s.talkerId, seqno }).catch(() => {});
        s.unread = 0;
        $(`.dm-item[data-id="${s.talkerId}"] .badge`)?.remove();
        refreshUnread();
      }
    } catch (e) { box.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  try {
    sessions = (await api('/api/messages/sessions')).list;
    $('#dmList').innerHTML = sessions.length ? sessions.map((s) => `<div class="dm-item" data-id="${esc(s.talkerId)}">
      <img src="${esc(img(s.face, '80w_80h'))}" alt="" onerror="this.style.visibility='hidden'">
      <div style="min-width:0"><div class="n">${esc(s.name || 'UID ' + s.talkerId)}${s.system ? ' <span class="chip">系统</span>' : ''}</div><div class="l">${esc(s.lastMsg)}</div></div>
      <div style="text-align:right"><div class="small muted">${s.time ? ago(s.time) : ''}</div>${s.unread ? `<span class="badge">${s.unread}</span>` : ''}</div></div>`).join('') : '<div class="empty">没有私信</div>';
    $('#dmList').onclick = (e) => { const it = e.target.closest('.dm-item'); if (it) openS(sessions.find((s) => s.talkerId === it.dataset.id)); };
  } catch (e) { $('#dmList').innerHTML = `<div class="err" style="padding:14px">${esc(e.message)}</div>`; }
  $('#dmReadAll').onclick = (e) => busy(e.target, async () => {
    const unread = sessions.filter((s) => s.unread);
    if (!unread.length) return toast('没有未读私信');
    for (const s of unread) {
      await api('/api/messages/read', { talkerId: s.talkerId });
      s.unread = 0;
      $(`.dm-item[data-id="${s.talkerId}"] .badge`)?.remove();
    }
    toast(`${unread.length} 个会话已标为已读`);
    refreshUnread();
  });
  const send = (btn) => busy(btn, async () => {
    if (!cur) throw new Error('先选一个会话');
    const t = $('#dmIn').value.trim();
    if (!t) throw new Error('写点什么');
    await api('/api/messages/send', { uid: cur.talkerId, name: cur.name, text: t });
    $('#dmIn').value = '';
    toast('发出去了');
    openS(cur);
  });
  $('#dmSend').onclick = (e) => send(e.target);
  $('#dmIn').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send($('#dmSend')); } };
  $('#dmAi').onclick = (e) => busy(e.target, async () => {
    if (!cur) throw new Error('先选一个会话');
    const msgs = $$('#dmMsgs .bubble:not(.me) div');
    const last = msgs[msgs.length - 1]?.textContent || '';
    if (!last) throw new Error('对方还没说话');
    $('#dmIn').value = (await api('/api/ai/reply', { message: last, kind: 'dm' })).text;
  });
}

// ─── 待审 · 派活 ───────────────────────────────────────────
async function pageReview(main) {
  main.innerHTML = head('待审 · 派活', 'AI 起草的评论、回复和日记在这里等你点头；派的活面板会直接去做') +
    `<div class="grid g-3"><div class="span-2"><div class="card"><div class="card-h"><h2>待审</h2><span class="small muted">改一改再发，或者直接丢掉</span></div><div id="rvList"><div class="empty">加载中…</div></div></div></div>
     <div><div class="card"><div class="card-h"><h2>派活给她</h2></div>
       <p class="small muted" style="margin-top:0">点一下她就马上去做（真看视频、按你说的点赞/分享/收藏/评论），结果写在下面。评论、回复、日记会先进「待审」。</p>
       <div class="row wrap">${[['browse', '随便刷刷'], ['browse_like', '刷+点赞'], ['comment', '去评论'], ['diary', '写日记'], ['check', '查新消息']].map(([k, n]) => `<button class="btn sm" data-task="${k}">${n}</button>`).join('')}</div>
       <div class="field" style="margin-top:12px"><textarea id="taskNote" placeholder="或者直接说要干嘛…" style="min-height:60px"></textarea>
         <div class="row" style="margin-top:6px"><label class="row small muted" title="不让面板做，进任务箱等你在 QQ 里叫她"><input type="checkbox" id="taskBot"> 交给 QQ 里的她</label><span class="spacer"></span><button class="btn sm primary" id="taskCustom">派出去</button></div>
         <div class="hint">比如：「搜「猫」看两个，喜欢就点赞收藏」「找个天文视频看完分享」「看三个，别评论」</div></div>
       <div id="taskList"></div></div></div></div>`;
  const loadRv = async () => {
    const r = await api('/api/review');
    const pending = r.list.filter((x) => x.status === 'pending');
    const done = r.list.filter((x) => x.status !== 'pending').slice(0, 10);
    S.badges.review = pending.length; renderNav();
    $('#rvList').innerHTML = (pending.length ? pending.map((x) => `<div class="rv" data-id="${esc(x.id)}">
        <div class="row small"><span class="chip ${x.kind === 'diary' ? 'violet' : x.kind === 'reply' ? 'pink' : 'blue'}">${x.kind === 'diary' ? '📔 日记（公开动态）' : x.kind === 'reply' ? '↩️ 回复 @' + esc(x.payload?.user || '') : '💬 评论'}</span>
          ${x.kind === 'reply' ? `<span class="muted" style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">TA 说：${esc(x.payload?.said || '')}</span>` : ''}
          ${x.payload?.bvid ? `<a data-bvid="${esc(x.payload.bvid)}" style="cursor:pointer" class="small">《${esc(x.payload.title)}》</a>` : ''}<span class="spacer"></span><span class="muted">${ago(x.ts)}</span></div>
        <textarea>${esc(x.text)}</textarea>
        <div class="row" style="justify-content:flex-end"><button class="btn sm ghost danger" data-rej>不要了</button><button class="btn sm primary" data-ok>${x.kind === 'diary' ? '发动态' : '发出去'}</button></div></div>`).join('')
      : '<div class="empty"><span class="fish">🫧</span>没有待审的。AI 起草需要在「自动养号」里配置模型</div>') +
      (done.length ? `<div class="tl-day">处理过的</div><ul class="tl">${done.map((x) => `<li><div class="time">${hm(x.updatedAt || x.ts)}</div><div class="ico">${x.status === 'posted' ? '✅' : '🗑️'}</div><div class="body"><div class="x">${esc(x.text.slice(0, 80))}</div><div class="m">${x.status === 'posted' ? '已发' : '丢掉了'}</div></div></li>`).join('')}</ul>` : '');
    $$('.rv').forEach((el) => {
      const id = el.dataset.id;
      $('[data-ok]', el).onclick = async (e) => {
        const isDiary = el.querySelector('.chip.violet');
        if (isDiary && !(await confirmBox('发到B站动态？', '动态是公开的，所有人都能看到。'))) return;
        busy(e.target, async () => { await api('/api/review/approve', { id, text: $('textarea', el).value }); toast('发出去了'); loadRv(); });
      };
      $('[data-rej]', el).onclick = (e) => busy(e.target, async () => { await api('/api/review/reject', { id }); loadRv(); });
    });
  };
  const loadTasks = async () => {
    const r = await api('/api/tasks');
    const st = { pending: ['等她', 'amber'], in_progress: ['在做', 'blue'], done: ['做完', 'green'], failed: ['没做成', 'red'], cancelled: ['取消', ''] };
    $('#taskList').innerHTML = `<div class="tl-day">任务箱</div>` + (r.tasks.length ? `<ul class="tl">${r.tasks.slice(0, 20).map((t) => `<li><div class="time">${hm(t.ts)}</div><div class="ico">📋</div>
      <div class="body"><div class="x">${esc(t.note || t.type)}</div><div class="m"><span class="chip ${st[t.status]?.[1] || ''}">${st[t.status]?.[0] || t.status}</span>${t.source === 'auto' ? '<span class="chip blue">自动派的</span>' : ''}${t.executor === 'bot' && t.source !== 'auto' ? '<span class="chip pink">QQ里的她</span>' : ''} ${t.resultNote ? esc(t.resultNote) : ''}
      ${t.status === 'pending' ? `<button class="btn sm ghost" data-cancel="${esc(t.id)}">取消</button>` : ''}</div></div></li>`).join('')}</ul>` : '<div class="empty">空的</div>');
    $$('[data-cancel]').forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/tasks/cancel', { id: b.dataset.cancel }); loadTasks(); })));
    // 面板在做的活：隔几秒刷新一下进度
    clearTimeout(S.taskTimer);
    if (r.tasks.some((t) => t.status === 'in_progress' && t.executor === 'panel')) S.taskTimer = setTimeout(() => { if (S.page === 'review') loadTasks(); }, 8000);
  };
  const executor = () => ($('#taskBot').checked ? 'bot' : 'panel');
  const afterSend = () => {
    toast(executor() === 'bot' ? '进任务箱了，下次在 QQ 叫她' : '她去做了，结果会写在任务箱里');
    loadTasks();
    if (executor() === 'panel') { pollLive(); setTimeout(loadTasks, 4000); }
  };
  $$('[data-task]').forEach((b) => (b.onclick = () => busy(b, async () => { await api('/api/tasks', { type: b.dataset.task, executor: executor() }); afterSend(); })));
  $('#taskCustom').onclick = (e) => busy(e.target, async () => {
    const note = $('#taskNote').value.trim();
    if (!note) throw new Error('写点内容');
    await api('/api/tasks', { type: 'custom', note, executor: executor() });
    $('#taskNote').value = '';
    afterSend();
  });
  loadRv().catch((e) => ($('#rvList').innerHTML = `<div class="err">${esc(e.message)}</div>`));
  loadTasks();
}

// ─── 养鱼日记 ──────────────────────────────────────────────
async function pageDiary(main) {
  main.innerHTML = head('养鱼日记', '她在B站的小杂谈，发出去是公开动态。只写B站上看到的事，别写私事') + '<div class="empty">加载中…</div>';
  const r = await api('/api/diary');
  if (S.page !== 'diary') return;
  main.innerHTML = head('养鱼日记', '她在B站的小杂谈，发出去是公开动态。只写B站上看到的事，别写私事') +
    `<div class="grid g-3"><div class="card"><div class="card-h"><h2>替她写一条</h2>${r.publishedToday ? '<span class="chip green">今天已发</span>' : ''}</div>
      <textarea id="dyText" style="min-height:180px" placeholder="像发朋友圈那样写，不是写周报…"></textarea>
      <div class="hint">一天一条就够。内容干净，别擦边、别带链接。</div>
      <div class="row" style="margin-top:10px;justify-content:flex-end"><button class="btn primary" id="dyPub">发到B站动态</button></div></div>
     <div class="card span-2"><div class="card-h"><h2>写过的</h2></div>
      ${r.drafts.length ? r.drafts.map((d) => `<div class="rv"><div class="row small"><b>${dayLabel(d.date)}</b><span class="muted">${d.date} ${hm(d.ts)}</span><span class="spacer"></span>
        ${d.dynId ? `<a href="https://t.bilibili.com/${esc(d.dynId)}" target="_blank" rel="noopener" class="chip green">已发布 ↗</a>` : '<span class="chip">草稿</span>'}</div>
        <div style="white-space:pre-wrap;margin-top:8px;color:var(--text2)">${esc(d.draft)}</div></div>`).join('') : '<div class="empty">还没写过</div>'}
     </div></div>`;
  $('#dyPub').onclick = async (e) => {
    const t = $('#dyText').value.trim();
    if (!t) return toast('写点什么', 'err');
    if (!(await confirmBox('发到B站动态？', (r.publishedToday ? '今天已经发过一条了，' : '') + '动态是公开的，所有人都能看到。'))) return;
    busy(e.target, async () => {
      const res = await api('/api/diary/publish', { text: t });
      toast('发出去了');
      if (res.url) window.open(res.url, '_blank', 'noopener');
      route();
    });
  };
}

// ─── 主题 / 启动 ───────────────────────────────────────────
$('#themeBtn').onclick = () => {
  const cur = document.documentElement.dataset.theme || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
};

route();
loadOverview().catch(() => {});
setInterval(() => {
  if (document.hidden) return;
  if (S.page === 'overview' && !$('#drawer').classList.contains('show')) pageOverview($('#main'));
  else loadOverview().catch(() => {});
}, 60000);
// 打开时如果她正在刷，就跟着刷新进度
api('/api/autopilot').then((ap) => ap.live.running && pollLive()).catch(() => {});
