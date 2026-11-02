// ─── 聊天框：坐在电脑前直接跟她说，不用掏手机 ─────────────────
// 跟 QQ 里是同一个她、同一份聊天记录：QQ 上说的这里也看得到（标着「QQ」），这里说的她回在这里。
// 打开时每 2.5 秒拉一次新消息；收起来时 20 秒拉一次，只为了在按钮上点个小红点。
(() => {
  const $c = (s) => document.querySelector(s);
  const escc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const two = (n) => String(n).padStart(2, '0');
  const when = (ts) => {
    const d = new Date(ts);
    const t = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return d.toDateString() === new Date().toDateString() ? t : `${d.getMonth() + 1}/${d.getDate()} ${t}`;
  };
  const TAG = { proactive: '她主动找你', report: '后台汇报', notice: '提醒' };
  const seenKey = 'chatSeen';
  let open = false;
  let last = '';
  let list = [];
  let timer = null;
  let sending = false;

  document.body.insertAdjacentHTML('beforeend', `
    <button class="chat-fab" id="chatFab" title="跟她聊天" aria-label="跟她聊天">🐟<i id="chatDot"></i></button>
    <section class="chat-box" id="chatBox" aria-hidden="true">
      <header><b>肥鱼</b><span id="chatSub" class="small muted"></span><span class="spacer"></span><button class="btn ghost sm" id="chatClose">收起</button></header>
      <div class="chat-list" id="chatList"><div class="empty">加载中…</div></div>
      <div class="chat-typing" id="chatTyping">她正在输入…</div>
      <footer><textarea id="chatIn" rows="1" placeholder="跟她说点什么…" title="Enter 发送，Shift+Enter 换行"></textarea><button class="btn primary" id="chatSend">发送</button></footer>
    </section>`);

  const bubble = (e) => {
    const me = e.from === 'owner';
    let body;
    if (e.kind === 'sticker') body = `<img class="chat-sticker" src="/api/chat/sticker?f=${encodeURIComponent(e.text)}" alt="${escc(e.text)}" title="${escc(e.text)}">`;
    else if (e.kind === 'voice') body = `${e.file ? `<audio controls preload="none" src="/api/chat/voice?f=${encodeURIComponent(e.file)}"></audio>` : '🔊 '}<div class="chat-said">${escc(e.text)}</div>`;
    else body = escc(e.text).replace(/\n/g, '<br>');
    const meta = [when(e.ts), e.via === 'qq' ? 'QQ' : '', TAG[e.kind] || ''].filter(Boolean).join(' · ');
    return `<div class="chat-msg ${me ? 'me' : 'her'}"><div class="chat-b">${body}</div><div class="chat-meta">${meta}</div></div>`;
  };

  function render() {
    const box = $c('#chatList');
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
    box.innerHTML = list.length ? list.map(bubble).join('') : '<div class="empty">还没聊过，跟她打个招呼吧</div>';
    if (atBottom || sending) box.scrollTop = box.scrollHeight;
  }

  async function pull() {
    try {
      const r = await fetch('/api/chat' + (last ? `?after=${encodeURIComponent(last)}` : '')).then((x) => x.json());
      if (r.list?.length) {
        list = (last ? [...list, ...r.list] : r.list).slice(-200);
        last = list[list.length - 1].ts;
        if (open) render();
      } else if (open && !last) render();
      $c('#chatTyping').classList.toggle('show', !!r.typing);
      $c('#chatSub').textContent = r.llm === false ? '面板里还没配模型' : r.typing ? '正在输入…' : '';
      const lastHer = [...list].reverse().find((e) => e.from === 'her');
      let seen = '';
      try { seen = localStorage.getItem(seenKey) || ''; } catch {}
      if (open && lastHer) { try { localStorage.setItem(seenKey, lastHer.ts); } catch {} }
      $c('#chatDot').classList.toggle('show', !open && !!lastHer && lastHer.ts > seen);
    } catch { /* 面板重启的那几秒拉不到，下次再拉 */ }
    schedule();
  }
  const schedule = () => { clearTimeout(timer); timer = setTimeout(pull, open ? 2500 : 20000); };

  function toggle(v) {
    open = v;
    $c('#chatBox').classList.toggle('show', open);
    $c('#chatBox').setAttribute('aria-hidden', String(!open));
    if (open) { render(); $c('#chatList').scrollTop = 1e9; $c('#chatIn').focus(); }
    pull();
  }

  async function send() {
    const inp = $c('#chatIn');
    const text = inp.value.trim();
    if (!text || sending) return;
    sending = true;
    $c('#chatSend').disabled = true;
    try {
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || 'HTTP ' + r.status);
      inp.value = '';
      inp.style.height = '';
      await pull();
    } catch (e) {
      (window.toast || alert)(`没发出去：${e.message}`, 'err');
    } finally {
      sending = false;
      $c('#chatSend').disabled = false;
      inp.focus();
    }
  }

  $c('#chatFab').onclick = () => toggle(!open);
  $c('#chatClose').onclick = () => toggle(false);
  $c('#chatSend').onclick = send;
  $c('#chatIn').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
    if (e.key === 'Escape') toggle(false);
  });
  $c('#chatIn').addEventListener('input', (e) => { e.target.style.height = ''; e.target.style.height = Math.min(120, e.target.scrollHeight) + 'px'; });
  pull();
})();
