// ─── 逛逛（贴吧 / 抖音）─────────────────────────────────────
// 她在 B站 之外还会去两个地方串门：贴吧看帖子、抖音刷视频。
// 这两个能力跑在一个独立的 Chrome 里（panel/web.mjs），和 B站 那个号完全隔离，
// 登录态各存各的，不会互相挤掉线。未登录也能用（贴吧能看帖子、抖音能看热点榜），
// 登录之后才能回帖 / 评论 / 点赞。

// app.js 里的 num/sel/tog 是 pageAutopilot 内部的局部函数，这里用不了，
// 所以照同样的 data-path 约定在本地再定义一份 —— 好处是保存逻辑能共用一套。
function webFieldGetters(cfg) {
  // cfg 已经是 web 这一段了，data-path 却从 web. 开头：不去掉的话读的是 web.web.*，
  // 表单显示的、保存的都是那份没人用的副本，真正生效的设置怎么改都不变
  const get = (path) => path.replace(/^web\./, '').split('.').reduce((o, k) => (o == null ? undefined : o[k]), cfg);
  const num = (path, label, opt = {}) => {
    const v = get(path);
    const shown = opt.pct ? Math.round(Number(v || 0) * 100) : v;
    return `<div><label class="f">${label}</label><input type="number" data-path="${path}" ${opt.pct ? 'data-pct="1"' : ''} value="${shown ?? 0}" min="${opt.min ?? 0}" max="${opt.max ?? 9999}" step="${opt.step ?? 1}">${opt.hint ? `<div class="hint">${opt.hint}</div>` : ''}</div>`;
  };
  const sel = (path, label, options, hint) => {
    const v = get(path);
    return `<div><label class="f">${label}</label><select data-path="${path}">${options.map(([k, n]) => `<option value="${k}" ${k === v ? 'selected' : ''}>${n}</option>`).join('')}</select>${hint ? `<div class="hint">${hint}</div>` : ''}</div>`;
  };
  const tog = (path, label, hint) => {
    const v = get(path);
    return `<div><label class="f">${label}</label><label class="row"><span class="switch"><input type="checkbox" data-path="${path}" ${v ? 'checked' : ''}><span></span></span><span class="small muted">${hint || ''}</span></label></div>`;
  };
  return { num, sel, tog };
}

let webQrTimer = null; // 扫码登录的轮询

async function pageWeb(main) {
  const tab = (S.webTab ||= 'tieba');
  S.webForum = S.webForum || '猫';
  main.innerHTML = head('逛逛', '她在 B站 之外去的两个地方：贴吧看帖、抖音刷视频') + '<div class="empty">加载中…</div>';
  let w;
  try { w = await api('/api/web'); } catch (e) { main.innerHTML = head('逛逛') + `<div class="card err">${esc(e.message)}</div>`; return; }
  if (S.page !== 'web') return;
  const c = w.config;
  const b = w.browser || {};
  const login = S.webLogin || (S.webLogin = await api('/api/web/login').catch(() => ({})));
  const { num, sel, tog } = webFieldGetters(c);

  main.innerHTML = head('逛逛', '她在 B站 之外去的两个地方：贴吧看帖、抖音刷视频') + `
    <div class="grid g-3">
      <div class="card">
        <div class="card-h"><h2>今天去了没</h2><span class="small muted">${b.running ? '浏览器开着' : '浏览器没开'}</span></div>
        <div class="tl-day">贴吧</div>
        <div class="row" style="justify-content:space-between"><span>去了 <b>${w.today.tieba.visited}</b> / ${w.today.tieba.want} 次</span><span class="small muted">回帖 ${w.today.tieba.replied} 条</span></div>
        <div class="tl-day">抖音</div>
        <div class="row" style="justify-content:space-between"><span>去了 <b>${w.today.douyin.visited}</b> / ${w.today.douyin.want} 次</span><span class="small muted">评论 ${w.today.douyin.commented} 条</span></div>
        ${w.live.running ? `<div class="live" style="margin-top:10px"><span class="pulse"></span><div style="flex:1"><b>她正在 ${w.live.site === 'tieba' ? '逛贴吧' : '刷抖音'}</b><div class="small muted">${esc(w.live.step || '')}</div></div><button class="btn sm" id="webStop">叫停</button></div>` : ''}
        ${w.paused ? '<div class="hint" style="color:var(--amber)">⏸ 号主叫停中，这段时间她不会自己出门</div>' : ''}
        <div class="row wrap" style="margin-top:12px">
          <button class="btn sm primary" data-goweb="tieba">现在去逛贴吧</button>
          <button class="btn sm primary" data-goweb="douyin">现在刷抖音</button>
          <button class="btn sm ghost" data-goweb="auto">随便哪个</button>
        </div>
        <div class="hint" style="margin-top:8px">手动点的不受「每天几次」限制，也不会占用当天的额度。</div>
      </div>

      <div class="card span-2">
        <div class="card-h"><h2>登录</h2><span class="small muted">两个站点的登录态各自存在她的浏览器里</span></div>
        <div class="row wrap" style="gap:10px">
          ${['tieba', 'douyin'].map((s) => {
            const name = s === 'tieba' ? '贴吧' : '抖音';
            const st = login[s] || {};
            return `<div class="live" style="flex:1;min-width:220px;background:var(--bg2)">
              <div style="flex:1"><b>${name}</b> <span class="chip ${st.ok ? 'green' : 'amber'}">${st.ok ? '已登录' : '未登录'}</span>
              <div class="small muted">${st.ok ? '能回帖 / 评论 / 点赞' : (st.why || '只能看，不能说话')}</div></div>
              <button class="btn sm" data-qr="${s}">扫码登录</button></div>`;
          }).join('')}
        </div>
        <div class="hint">第一次用要扫一次码：点「扫码登录」，二维码会直接显示在这里，用手机扫就行。她的浏览器在后台跑，不会弹窗口，登录态和你平时的浏览器互不影响。
        贴吧能看的和能回的不是一个量级 —— 不登录只能看帖子。</div>
        <div class="row" style="margin-top:10px"><button class="btn sm ghost" id="webKill">把浏览器关掉</button><span class="small muted" id="webKillMsg">${b.running ? `开着呢（端口 ${b.port}）` : '没开'}</span></div>
      </div>
    </div>

    <div style="height:16px"></div>
    <div class="card">
      <div class="card-h"><h2>设置</h2></div>
      <div class="cfg-sec">
        <h3>总开关</h3>
        <p>关掉之后她只在 B站 待着，不往这两个地方跑。开关跟着「自动养号」的总开关一起生效。</p>
        <div class="cfg-grid">
          ${tog('web.enabled', '让她自己去逛贴吧和抖音', '一次不多，一天几次，跟 B站 的作息互相独立')}
          ${num('web.visitsPerDay.tieba', '贴吧一天去几次', { max: 12 })}
          ${num('web.visitsPerDay.douyin', '抖音一天去几次', { max: 12 })}
          ${num('web.quietStart', '夜里不去（从几点）', { max: 23 })}
          ${num('web.quietEnd', '夜里不去（到几点）', { max: 23 })}
          ${tog('web.showWindow', '显示浏览器窗口', '默认关着：她在后台逛，不会弹窗口打扰你。想看她在干嘛、或者扫码后要在网页上再验证一步时再打开')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>贴吧</h3>
        <div class="cfg-grid">
          ${tog('web.tieba.enabled', '逛贴吧')}
          <div><label class="f">逛哪些吧</label><input data-path="web.tieba.forums" value="${esc((c.tieba.forums || []).join('，'))}" placeholder="猫，天文"><div class="hint">用中文逗号或英文逗号隔开。填吧名就行，不用带「吧」字</div></div>
          ${num('web.tieba.threadsMin', '一轮最少看几个帖子', { max: 10 })}
          ${num('web.tieba.threadsMax', '一轮最多看几个帖子', { max: 12 })}
          ${num('web.tieba.readMinSec', '一个帖子至少看几秒', { max: 300 })}
          ${num('web.tieba.readMaxSec', '一个帖子最多看几秒', { max: 600 })}
          ${sel('web.tieba.reply.mode', '回帖', [['off', '不回，只看'], ['task', '交给她在 QQ 里回'], ['llm', 'AI 起草']])}
          ${num('web.tieba.reply.chance', '一个帖子回的概率 %', { pct: 1, max: 100 })}
          ${num('web.tieba.reply.dailyMax', '一天最多回几条', { max: 30 })}
          ${num('web.tieba.followDailyMax', '一天最多关注几个吧', { max: 10 })}
          ${tog('web.tieba.reply.review', 'AI 回帖先给我审', '贴吧回帖是公开的；关掉就是她自己直接发')}
        </div>
      </div>
      <div class="cfg-sec">
        <h3>抖音</h3>
        <div class="cfg-grid">
          ${tog('web.douyin.enabled', '刷抖音')}
          ${num('web.douyin.videosMin', '一轮最少看几条', { max: 10 })}
          ${num('web.douyin.videosMax', '一轮最多看几条', { max: 12 })}
          ${num('web.douyin.watchMinSec', '一条至少看几秒', { max: 300 })}
          ${num('web.douyin.watchMaxSec', '一条最多看几秒', { max: 600 })}
          ${num('web.douyin.likeChance', '点赞概率 %', { pct: 1, max: 100 })}
          ${num('web.douyin.likeDailyMax', '一天最多点几个赞', { max: 50, hint: '点赞从来不用审，靠这个兜住' })}
          ${sel('web.douyin.comments.mode', '评论', [['off', '不评论'], ['task', '交给她在 QQ 里评论'], ['llm', 'AI 起草']])}
          ${num('web.douyin.comments.chance', '一条视频评论的概率 %', { pct: 1, max: 100 })}
          ${num('web.douyin.comments.dailyMax', '一天最多评论几条', { max: 30 })}
          ${tog('web.douyin.comments.review', 'AI 评论先给我审', '抖音评论是公开的；关掉就是她自己直接发')}
        </div>
        <div class="hint">没登录抖音时只能拿到热点榜（也够她刷了）；登录后才有推荐流和搜索。</div>
      </div>
      <div class="save-bar"><button class="btn primary" id="saveWeb">保存设置</button></div>
    </div>

    <div style="height:16px"></div>
    <div class="card">
      <div class="card-h"><h2>先看一眼</h2><span class="small muted">不写任何东西，只是把她会看到的列表拉出来</span></div>
      <div class="seg" id="webSeg">
        <button data-v="tieba" class="${tab === 'tieba' ? 'on' : ''}">贴吧</button>
        <button data-v="douyin" class="${tab === 'douyin' ? 'on' : ''}">抖音</button>
      </div>
      ${tab === 'tieba' ? `<div class="row" style="margin:10px 0"><input id="webForumIn" value="${esc(S.webForum)}" placeholder="吧名，比如 猫" style="max-width:180px"><button class="btn sm primary" id="webForumGo">看看这个吧</button><button class="btn sm ghost" id="webForumSearch">搜一下吧名</button></div>` : ''}
      <div id="webList"><div class="empty">点上面的按钮拉一下</div></div>
    </div>`;

  // 设置存取
  const collect = () => {
    const patch = {};
    for (const el of $$('[data-path]', main)) {
      const keys = el.dataset.path.split('.');
      let o = patch;
      for (const k of keys.slice(0, -1)) o = o[k] ?? (o[k] = {});
      const last = keys[keys.length - 1];
      if (el.type === 'checkbox') o[last] = el.checked;
      else if (el.type === 'number') o[last] = el.dataset.pct ? Number(el.value) / 100 : Number(el.value);
      else if (last === 'forums') o[last] = String(el.value).split(/[,，\s]+/).map((x) => x.trim()).filter(Boolean);
      else o[last] = el.value;
    }
    return patch;
  };
  $('#saveWeb').onclick = (e) => busy(e.target, async () => {
    await api('/api/web/config', collect()); // collect() 按 data-path 建，自己就带着 web 这一层
    toast('设置已保存');
    S.webLogin = null;
    route();
  });
  // 总开关单独一个，改了立刻生效（跟自动养号那一页的做法一致）
  const master = $('[data-path="web.enabled"]', main);
  if (master) master.onchange = (e) => busy(null, async () => {
    await api('/api/web/config', { web: { enabled: e.target.checked } });
    toast(e.target.checked ? '她会自己去逛了' : '她不出门了');
  });

  $$('[data-goweb]').forEach((btn) => (btn.onclick = (ev) => busy(ev.target, async () => {
    await api('/api/web/run', { site: btn.dataset.goweb });
    toast('叫她去门口了，浏览器起来了就开始（第一次开浏览器要十几秒）');
    setTimeout(() => { if (S.page === 'web') route(); }, 2500);
    setTimeout(() => { if (S.page === 'web') route(); }, 12000);
  })));
  const stopBtn = $('#webStop');
  if (stopBtn) stopBtn.onclick = (e) => busy(e.target, async () => { await api('/api/web/stop', {}); toast('叫停了'); route(); });

  $$('[data-qr]').forEach((btn) => (btn.onclick = (e) => busy(e.target, async () => {
    const site = btn.dataset.qr;
    toast(site === 'tieba' ? '正在开贴吧登录页…' : '正在开抖音登录页…');
    const r = await api('/api/web/login/qr', { site });
    openDrawer(site === 'tieba' ? '扫码登录贴吧' : '扫码登录抖音', `<div class="qr-box">
      <img class="webqr" src="data:image/png;base64,${r.png}" alt="登录二维码" style="width:260px;max-width:100%;border-radius:12px;background:#fff;padding:8px">
      <div id="webQrMsg" class="qr-msg">用手机${site === 'tieba' ? '贴吧 App' : '抖音 App'}扫这个码，然后在手机上点确认</div>
      <div class="hint">要登录的是她的号，别扫成你自己的。</div>
      <button class="btn sm" id="qrAgain" style="margin-top:10px">换一张</button></div>`);
    $('#qrAgain').onclick = () => { S.webLogin = null; btn.click(); };
    // 扫完码要一直问后台「登上了没」，不然手机上成功了这边也没反应
    clearTimeout(webQrTimer);
    const poll = async () => {
      const msg = $('#webQrMsg');
      if (!$('#drawer').classList.contains('show') || !msg) return; // 抽屉关了就别再查
      let p;
      try { p = await api('/api/web/login/poll?site=' + site); } catch (err) { p = { status: 'waiting' }; }
      if (p.status === 'ok') {
        msg.innerHTML = '✅ 登录成功！';
        toast(site === 'tieba' ? '贴吧登上了' : '抖音登上了');
        S.webLogin = null;
        setTimeout(() => { closeDrawer(); route(); }, 900);
        return;
      }
      if (p.status === 'expired' || Date.now() > r.expiresAt) {
        msg.innerHTML = '二维码过期了，点「换一张」再扫';
        $('.webqr').style.opacity = 0.25;
        return;
      }
      if (p.status === 'scanned') msg.innerHTML = '📱 扫到了，在手机上点「确认登录」';
      if (p.status === 'verify') msg.innerHTML = '🔐 还要在网页上再验证一步（比如填短信验证码）：先在上面设置里打开「显示浏览器窗口」并保存，再点「换一张」重扫，到弹出的窗口里按提示完成';
      webQrTimer = setTimeout(poll, 2000);
    };
    webQrTimer = setTimeout(poll, 2000);
  })));
  const kill = $('#webKill');
  if (kill) kill.onclick = (e) => busy(e.target, async () => { await api('/api/web/browser/close', {}); $('#webKillMsg').textContent = '已关掉'; toast('浏览器关了'); });

  // 先看一眼
  $$('#webSeg button').forEach((b2) => (b2.onclick = () => { S.webTab = b2.dataset.v; route(); }));
  const out = $('#webList');
  const loadList = async () => {
    out.innerHTML = '<div class="empty">拉取中…（要开浏览器，第一次慢一点）</div>';
    try {
      if (tab === 'tieba') {
        const r = await api('/api/web/browse?site=tieba&forum=' + encodeURIComponent(S.webForum));
        out.innerHTML = r.list.length ? `<ul class="tl">${r.list.map((t) => `<li style="cursor:pointer" data-thread="${esc(t.tid)}">
          <div class="time">${t.replyCount ?? ''}</div><div class="ico">💬</div>
          <div class="body"><div class="x">${t.isTop ? '<span class="chip">置顶</span> ' : ''}${esc(t.title)}</div>
          <div class="m">${esc(t.author || '')}${t.replyCount ? ` · ${t.replyCount} 条回复` : ''}</div></div></li>`).join('')}</ul>`
          : '<div class="empty">这个吧没拉到帖子，名字对不对？</div>';
        $$('[data-thread]', out).forEach((li) => (li.onclick = () => openTiebaThread(li.dataset.thread)));
      } else {
        const r = await api('/api/web/browse?site=douyin');
        out.innerHTML = r.list.length ? `<ul class="tl">${r.list.map((v) => `<li style="cursor:pointer" data-dyv="${esc(v.vid)}">
          <div class="time">${esc(v.duration || '')}</div><div class="ico">▶</div>
          <div class="body"><div class="x">${esc(v.title)}</div><div class="m">${v.likeCount != null ? '❤️ ' + esc(String(v.likeCount)) : ''}${v.author ? ' · @' + esc(v.author) : ''}${v.publishTime ? ' · ' + esc(v.publishTime) : ''}</div></div></li>`).join('')}</ul>`
          : '<div class="empty">没拿到视频</div>';
        $$('[data-dyv]', out).forEach((li) => (li.onclick = () => openDouyinVideo(li.dataset.dyv, r.list.find((x) => x.vid === li.dataset.dyv))));
      }
    } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; }
  };
  const fg = $('#webForumGo');
  if (fg) fg.onclick = () => { S.webForum = $('#webForumIn').value.trim() || '猫'; loadList(); };
  // 搜吧：不确定吧名到底叫什么的时候先搜一下（贴吧的吧名挺多讲究，比如「猫」不是「猫咪」）
  const fs2 = $('#webForumSearch');
  if (fs2) fs2.onclick = () => busy(fs2, async () => {
    const kw = $('#webForumIn').value.trim();
    if (!kw) throw new Error('先写个关键词');
    out.innerHTML = '<div class="empty">搜吧中…</div>';
    const r = await api('/api/web/forums?q=' + encodeURIComponent(kw));
    out.innerHTML = r.list.length ? `<ul class="tl">${r.list.map((f) => `<li style="cursor:pointer" data-forum="${esc(f.name)}">
      <div class="time">${f.memberCount ? fmtNum(f.memberCount) : ''}</div><div class="ico">🏛️</div>
      <div class="body"><div class="x">${esc(f.name)}吧</div><div class="m">${esc(f.desc || '')}${f.threadCount ? ` · ${fmtNum(f.threadCount)} 贴` : ''}</div></div></li>`).join('')}</ul>`
      : '<div class="empty">没搜到，换个词试试</div>';
    $$('[data-forum]', out).forEach((li) => (li.onclick = () => {
      S.webForum = li.dataset.forum;
      $('#webForumIn').value = S.webForum;
      loadList();
    }));
  });
  loadList();
}

async function openTiebaThread(tid) {
  openDrawer('帖子', '<div class="empty">打开中…</div>');
  try {
    const d = await api('/api/web/thread?tid=' + encodeURIComponent(tid));
    $('#drawerTitle').textContent = d.title || '帖子';
    $('#drawerBody').innerHTML = `
      <div class="vhead"><h3>${esc(d.title || '')}</h3>
        <div class="row small" style="gap:8px"><b>${esc(d.author || '')}</b><span class="muted">${esc(d.forumName || '')}${d.replyCount ? ` · ${d.replyCount} 条回复` : ''}</span></div>
        ${d.content ? `<div class="desc" style="white-space:pre-wrap">${esc(d.content)}</div>` : ''}</div>
      <div class="cfg-sec"><h3>楼层 <span class="muted small">${(d.floors || []).length} 条</span></h3>
        ${(d.floors || []).length ? (d.floors || []).map((f) => `<div class="cmt"><div style="min-width:0">
          <div class="u">${esc(f.author || '')} <span class="muted">${esc(f.time || '')}${f.floor ? ' · ' + esc(String(f.floor)) + ' 楼' : ''}</span></div>
          <div class="c" style="white-space:pre-wrap">${esc(f.text || '')}</div></div></div>`).join('') : '<div class="empty">没读到楼层</div>'}
      </div>
      <div class="hint">这里只是看。要让她回帖，去「设置 → 贴吧 → 回帖」调成「交给她」或「AI 起草」。</div>`;
  } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

async function openDouyinVideo(vid, meta = {}) {
  openDrawer('抖音', '<div class="empty">打开中…</div>');
  try {
    const r = await api('/api/web/video?vid=' + encodeURIComponent(vid));
    const d = r.detail || meta;
    $('#drawerBody').innerHTML = `
      <div class="vhead"><h3>${esc(d.title || meta.title || '')}</h3>
        <div class="row small" style="gap:8px">${d.author ? `<b>@${esc(d.author)}</b>` : ''}<span class="muted">${esc(d.publishTime || '')}${d.likeCount ? ` · ❤️ ${esc(d.likeCount)}` : ''}${d.commentCount ? ` · 💬 ${esc(d.commentCount)}` : ''}</span></div>
        ${d.desc ? `<div class="desc" style="white-space:pre-wrap">${esc(String(d.desc).slice(0, 600))}</div>` : ''}
        <div class="row" style="margin-top:8px"><a class="btn sm ghost" href="https://www.douyin.com/video/${esc(vid)}" target="_blank" rel="noopener">在抖音打开 ↗</a></div></div>
      <div class="cfg-sec"><h3>评论 <span class="muted small">${(r.comments || []).length} 条</span></h3>
        ${r.loginWall ? '<div class="hint" style="color:var(--amber);margin-bottom:8px">⚠️ 抖音没登录只放得出前几条评论，登录后能看到全部</div>' : ''}
        ${(r.comments || []).length ? r.comments.map((x) => `<div class="cmt"><div style="min-width:0">
          <div class="u">${esc(x.author || '')} <span class="muted">${esc(x.time || '')}${x.likeCount ? ` · 👍 ${esc(String(x.likeCount))}` : ''}${x.replyCount ? ` · ${esc(String(x.replyCount))} 条回复` : ''}</span></div>
          <div class="c" style="white-space:pre-wrap">${esc(x.text || '')}</div></div></div>`).join('') : '<div class="empty">没读到评论</div>'}
      </div>`;
  } catch (e) { $('#drawerBody').innerHTML = `<div class="err">${esc(e.message)}</div>`; }
}

// ─── 主题 / 启动 ───────────────────────────────────────────
