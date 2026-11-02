// ─── 直播（「刷视频」页的一个标签）─────────────────────────────
// 她在 B站 看直播：不开浏览器，拉房间信息和弹幕（panel/bililive.mjs）。
// 这里能叫她去看某个主播 / 房间、看她正在看谁和最近的弹幕、设她要不要自己偶尔去看。
// 「陪我看」= 她一直待在直播间，直到你叫她出来（或者下播）；可以让她自己发弹幕。
let liveTabTimer = null;

async function renderLive(out) {
  clearTimeout(liveTabTimer);
  let v;
  try { v = await api('/api/live'); } catch (e) { out.innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
  const w = v.watching;
  const c = v.config || {};
  const left = w ? Math.max(0, Math.round((w.until - Date.now()) / 60000)) : 0;
  out.innerHTML = `
    <div class="live-now">
      ${w ? `<div class="live-cover">${w.cover ? `<img src="${esc(img(w.cover))}" alt="" onerror="this.style.visibility='hidden'">` : ''}<span class="live-dot">● 在看</span></div>
        <div class="live-info"><b>${esc(w.uname || '正在挑房间…')}</b><div>${esc(w.title || '')}</div>
          <div class="small muted">${esc(w.area || '')}${w.roomid ? ` · <a href="https://live.bilibili.com/${esc(w.roomid)}" target="_blank" rel="noopener">房间 ${esc(w.roomid)}</a>` : ''} · ${w.stay ? `陪你看了 ${Math.max(1, Math.round((Date.now() - w.startedAt) / 60000))} 分钟` : `还剩约 ${left} 分钟`}</div>
          ${w.seen ? `<div class="small" style="margin-top:4px">👀 ${esc(w.seen)}</div>` : ''}
          <div class="live-dm">${(w.danmaku || []).map((d) => `<div><span class="muted">${esc(d.user)}：</span>${esc(d.text)}</div>`).join('') || '<span class="muted small">弹幕还没刷出来</span>'}</div>
          ${(w.mine || []).length ? `<div class="small" style="margin-top:6px"><b>她发的弹幕：</b>${w.mine.map((d) => esc(d.text)).join(' / ')}</div>` : ''}
          <div class="row wrap" style="margin-top:8px">
            ${w.stay ? `<label class="row small"><span class="switch"><input type="checkbox" id="liveDmNow" ${w.dmOn ? 'checked' : ''}><span></span></span><span>让她自己发弹幕</span></label>` : ''}
            <button class="btn danger sm" id="liveStop">${w.stay ? '叫她出来' : '让她别看了'}</button>
          </div></div>`
      : `<div class="live-info"><b>她现在没在看直播</b>
          <div class="row" style="margin-top:10px"><input id="liveTarget" placeholder="主播名 / 房间号 / 直播间链接，空着她自己挑"><button class="btn primary" id="liveStay">陪我看</button><button class="btn" id="liveGo">她自己看 ${c.minutes ?? 5} 分钟</button></div>
          <label class="row small" style="margin-top:8px"><span class="switch"><input type="checkbox" id="liveDm" ${c.danmaku ? 'checked' : ''}><span></span></span><span>陪看时让她自己发弹幕（不先给你审，每小时最多 ${c.danmakuPerHour ?? 6} 条）</span></label>
          <div class="hint">「陪我看」她会一直待在直播间，跟你聊天时知道直播里在发生什么，偶尔跟你说一句；你叫她出来、主播下播、或者待满 ${c.stayMaxHours ?? 4} 小时才出来。
            在聊天里说「陪我看 XX 的直播」「出来吧」也一样。</div></div>`}
    </div>
    <div class="live-cfg">
      <label class="row"><span class="switch"><input type="checkbox" id="liveAuto" ${c.enabled ? 'checked' : ''}><span></span></span><span>自动养号时，白天自己偶尔去看一会儿</span></label>
      <label class="row small">一天最多 <input type="number" id="livePerDay" min="0" max="6" value="${c.perDay ?? 1}" style="width:60px"> 场</label>
      <label class="row small">一场看 <input type="number" id="liveMin" min="1" max="30" value="${c.minutes ?? 5}" style="width:60px"> 分钟</label>
      <label class="row"><span class="switch"><input type="checkbox" id="liveChat" ${c.chat !== false ? 'checked' : ''}><span></span></span><span>陪看时偶尔跟我说一句</span></label>
      <label class="row small">陪看最长 <input type="number" id="liveMaxH" min="0.5" max="12" step="0.5" value="${c.stayMaxHours ?? 4}" style="width:60px"> 小时</label>
      <label class="row small">弹幕每小时最多 <input type="number" id="liveDmMax" min="1" max="20" value="${c.danmakuPerHour ?? 6}" style="width:60px"> 条</label>
      <button class="btn sm" id="liveSave">保存</button>
    </div>
    <h3 class="live-h">关注的人在播</h3><div id="liveRooms"><div class="empty">加载中…</div></div>
    <h3 class="live-h">最近看过</h3>
    ${v.recent.length ? `<div class="live-recent">${v.recent.map((r) => `<div><span class="muted small">${esc(ago(r.ts))}</span> ${esc(r.detail)}</div>`).join('')}</div>` : '<div class="empty">还没看过直播</div>'}`;

  const go = async (target, stay = true) => {
    try {
      await api('/api/live/watch', { target, stay, danmaku: !!$('#liveDm')?.checked });
      toast(stay ? '她进直播间陪你看了' : '她去看了');
      setTimeout(() => renderLive(out), 1500);
    } catch (e) { toast(e.message, 'err'); }
  };
  if ($('#liveGo')) {
    $('#liveGo').onclick = () => go($('#liveTarget').value.trim(), false);
    $('#liveStay').onclick = () => go($('#liveTarget').value.trim(), true);
    $('#liveTarget').onkeydown = (e) => e.key === 'Enter' && go($('#liveTarget').value.trim(), true);
  }
  if ($('#liveStop')) $('#liveStop').onclick = async () => { await api('/api/live/stop', {}).catch(() => {}); toast('叫她出来了，她记完印象就走'); setTimeout(() => renderLive(out), 3000); };
  if ($('#liveDmNow')) $('#liveDmNow').onchange = async (e) => { await api('/api/live/danmaku', { on: e.target.checked }).catch(() => {}); toast(e.target.checked ? '她可以发弹幕了' : '她不发弹幕了'); };
  $('#liveSave').onclick = async () => {
    try {
      await api('/api/live/config', {
        enabled: $('#liveAuto').checked, perDay: Number($('#livePerDay').value), minutes: Number($('#liveMin').value),
        chat: $('#liveChat').checked, stayMaxHours: Number($('#liveMaxH').value), danmakuPerHour: Number($('#liveDmMax').value),
        ...($('#liveDm') ? { danmaku: $('#liveDm').checked } : {}),
      });
      toast('存好了');
    } catch (e) { toast(e.message, 'err'); }
  };
  api('/api/live/search').then((r) => {
    const box = $('#liveRooms');
    if (!box) return;
    box.innerHTML = r.list.length ? `<div class="vgrid">${r.list.map((x) => `<div class="vcard live-room" data-room="${esc(x.roomid)}">
        <div class="cover"><img src="${esc(img(x.cover, '336w_210h_1c'))}" loading="lazy" alt="" onerror="this.style.visibility='hidden'"></div>
        <div class="tt">${esc(x.title)}</div><div class="mm">${esc(x.uname)}${x.area ? ' · ' + esc(x.area) : ''}</div></div>`).join('')}</div>`
      : '<div class="empty">关注的人里现在没人在播，可以在上面直接填主播名</div>';
    $$('.live-room', box).forEach((el) => (el.onclick = () => { if (!w) go(el.dataset.room); else toast('她正在看别的，先让她停下', 'err'); }));
  }).catch((e) => { const box = $('#liveRooms'); if (box) box.innerHTML = `<div class="err">${esc(e.message)}</div>`; });
  // 在看的时候刷新一下弹幕；离开这个标签就停
  if (w) liveTabTimer = setTimeout(() => { if (document.body.contains(out) && S.exTab === 'live') renderLive(out); }, 10000);
}
