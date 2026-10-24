/**
 * OneBot v11 客户端（连 QQ 小号）
 *
 * 小号登在 Docker 里的 QQ 上（panel/qq/napcat），NapCat 把它变成一个 OneBot v11 服务（正向 WebSocket，默认 ws://127.0.0.1:3001）。
 * 图片、语音都用 base64 发：容器看不到本机的文件路径。
 * 这里连上去：收私聊消息，发文字 / 图片 / 语音。断了就自己重连（3 秒起，最多隔 1 分钟）。
 *
 * 不依赖 DSH，也不依赖任何 npm 包：Node ≥ 22 自带 WebSocket。
 */
import { EventEmitter } from 'node:events';

export class OneBot extends EventEmitter {
  constructor({ url, token = '', WebSocketImpl = globalThis.WebSocket } = {}) {
    super();
    this.url = url;
    this.token = token;
    this.WS = WebSocketImpl;
    this.ws = null;
    this.pending = new Map(); // echo → { resolve, reject, timer }
    this.seq = 0;
    this.backoff = 3000;
    this.stopped = true;
    this.state = { connected: false, selfId: null, since: null, lastEventAt: null, error: '', startedAt: null };
  }

  start() {
    if (!this.stopped) return;
    if (!this.WS) throw new Error('这个 Node 没有内置 WebSocket（要 Node ≥ 22）');
    this.stopped = false;
    this.state.startedAt = Date.now();
    this.#connect();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    try { this.ws?.close(); } catch { /* 已经关了 */ }
    this.ws = null;
    this.state.connected = false;
  }

  #connect() {
    if (this.stopped) return;
    const u = new URL(this.url);
    if (this.token) u.searchParams.set('access_token', this.token);
    let ws;
    try { ws = new this.WS(u.toString()); } catch (e) { this.#fail(e); return; }
    this.ws = ws;
    ws.onopen = () => {
      this.backoff = 3000;
      Object.assign(this.state, { connected: true, since: Date.now(), error: '' });
      this.emit('open');
      this.call('get_login_info').then((r) => { this.state.selfId = r?.user_id ?? null; this.emit('ready', r); }).catch(() => {});
    };
    ws.onmessage = (ev) => {
      let j;
      try { j = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf-8')); } catch { return; }
      this.state.lastEventAt = Date.now();
      if (j.echo !== undefined && this.pending.has(j.echo)) {
        const p = this.pending.get(j.echo);
        this.pending.delete(j.echo);
        clearTimeout(p.timer);
        if (j.status === 'failed' || (j.retcode && j.retcode !== 0)) p.reject(new Error(j.message || j.wording || `OneBot 报错 ${j.retcode}`));
        else p.resolve(j.data);
        return;
      }
      if (j.self_id) this.state.selfId = j.self_id;
      if (j.post_type === 'message') this.emit('message', j);
      else if (j.post_type === 'meta_event') this.emit('meta', j);
      else if (j.post_type) this.emit('event', j);
    };
    ws.onerror = (ev) => { this.state.error = ev?.message || ev?.error?.message || '连接出错'; };
    ws.onclose = () => {
      const was = this.state.connected;
      this.state.connected = false;
      for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(new Error('连接断了')); }
      this.pending.clear();
      if (was) this.emit('close');
      this.#schedule();
    };
  }

  #fail(e) {
    this.state.error = e.message;
    this.#schedule();
  }

  #schedule() {
    if (this.stopped) return;
    clearTimeout(this.retry);
    this.retry = setTimeout(() => this.#connect(), this.backoff);
    this.backoff = Math.min(this.backoff * 2, 60_000);
  }

  /** 调一个 OneBot 动作，等它回话 */
  call(action, params = {}, timeoutMs = 15000) {
    if (!this.state.connected || !this.ws) return Promise.reject(new Error('QQ 小号没连上'));
    const echo = `yy${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(echo); reject(new Error(`${action} 超时`)); }, timeoutMs);
      this.pending.set(echo, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ action, params, echo }));
    });
  }

  sendPrivate(userId, message) {
    return this.call('send_private_msg', { user_id: Number(userId), message });
  }
}

/** 消息里的图片段（市场表情 mface 不算，那个有文字说明） */
export function imageSegments(ev) {
  if (!Array.isArray(ev.message)) {
    return [...String(ev.message || '').matchAll(/\[CQ:image,([^\]]*)\]/g)].map((m) => {
      const kv = Object.fromEntries(m[1].split(',').map((x) => [x.slice(0, x.indexOf('=')), x.slice(x.indexOf('=') + 1).replace(/&amp;/g, '&').replace(/&#44;/g, ',')]));
      return { url: kv.url, file: kv.file };
    });
  }
  return ev.message.filter((s) => s.type === 'image' && !(s.data?.summary && s.data.summary !== '[图片]')).map((s) => ({ url: s.data?.url, file: s.data?.file }));
}

// ─── 消息段 ────────────────────────────────────────────────
export const seg = {
  text: (text) => ({ type: 'text', data: { text } }),
  image: (b64) => ({ type: 'image', data: { file: `base64://${b64}` } }),
  record: (b64) => ({ type: 'record', data: { file: `base64://${b64}` } }),
};

/**
 * 收到的消息 → 一句给她看的文字。她看不了图、听不了语音，就如实写成 [图片] [语音]，别让她装作看见了。
 * message 可能是消息段数组，也可能是 CQ 码字符串（看 NapCat 的消息格式设置）。
 */
export function readMessage(ev) {
  const m = ev.message;
  if (typeof m === 'string') {
    return m.replace(/\[CQ:image[^\]]*\]/g, '[图片]').replace(/\[CQ:record[^\]]*\]/g, '[语音]').replace(/\[CQ:face[^\]]*\]/g, '[表情]')
      .replace(/\[CQ:[^\]]*\]/g, '').replace(/&#91;/g, '[').replace(/&#93;/g, ']').replace(/&amp;/g, '&').trim();
  }
  if (!Array.isArray(m)) return String(ev.raw_message || '').trim();
  return m.map((s) => {
    if (s.type === 'text') return s.data?.text || '';
    if (s.type === 'image') return s.data?.summary && s.data.summary !== '[图片]' ? `[表情包${s.data.summary}]` : '[图片]';
    if (s.type === 'mface') return `[表情包${s.data?.summary || ''}]`;
    if (s.type === 'record') return '[语音]';
    if (s.type === 'video') return '[视频]';
    if (s.type === 'face') return '[表情]';
    if (s.type === 'file') return `[文件 ${s.data?.name || ''}]`;
    if (s.type === 'json') return '[卡片]';
    return '';
  }).join('').trim();
}
