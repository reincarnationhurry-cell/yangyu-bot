/**
 * 极简 CDP 客户端（自带 WebSocket，不依赖全局 WebSocket 的 Origin 行为）
 *
 * 为什么不用 Node 内置的 WebSocket：Node 26 的 undici WebSocket **不发 Origin 头**，
 * 而 Chrome 156 起对 DevTools 的 WebSocket 做 Origin 校验，握手后立刻 1006 断开（只连得上、发不出命令）。
 * 实测：带 `Origin: http://127.0.0.1:<port>` 的原始握手能正常收 Browser.getVersion。
 * 这里自己实现客户端握手 + 帧编解码，Origin 用本机同源，稳定可用。
 *
 * 只支持我们需要的：文本帧、分片、ping/pong、关闭。够 CDP 用。
 */
import { createHash, randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import http from 'node:http';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export class CdpConnection extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buf = Buffer.alloc(0);
    this.seq = 0;
    this.pending = new Map();
    this.closed = false;
    socket.on('data', (d) => this._onData(d));
    socket.on('close', () => this._closed('socket closed'));
    socket.on('error', (e) => this._closed(e.message));
  }

  _closed(why) {
    if (this.closed) return;
    this.closed = true;
    for (const p of this.pending.values()) p.reject(new Error(`CDP 连接断了：${why}`));
    this.pending.clear();
    this.emit('close', why);
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 2) {
      const b0 = this.buf[0];
      const b1 = this.buf[1];
      const fin = (b0 & 0x80) !== 0;
      const opcode = b0 & 0x0f;
      let len = b1 & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const masked = (b1 & 0x80) !== 0;
      const maskLen = masked ? 4 : 0;
      if (this.buf.length < off + maskLen + len) return;
      let payload = this.buf.subarray(off + maskLen, off + maskLen + len);
      if (masked) {
        const mask = this.buf.subarray(off, off + 4);
        payload = Buffer.from(payload.map((v, i) => v ^ mask[i % 4]));
      }
      this.buf = this.buf.subarray(off + maskLen + len);
      if (opcode === 0x9) { this._frame(0xa, payload); continue; } // ping → pong
      if (opcode === 0xa) continue; // pong
      if (opcode === 0x8) { this._frame(0x8, Buffer.alloc(0)); this.socket.end(); continue; }
      if (opcode === 0x1 || opcode === 0x0) {
        this._frag = fin ? payload : Buffer.concat([this._frag || Buffer.alloc(0), payload]);
        if (!fin) continue;
        const text = this._frag.toString('utf8');
        this._frag = null;
        this._onMessage(text);
      }
    }
  }

  _onMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    if (m.id && this.pending.has(m.id)) {
      const p = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
    } else {
      this.emit('event', m);
    }
  }

  _frame(opcode, payload) {
    const mask = randomBytes(4);
    const len = payload.length;
    let head;
    if (len < 126) head = Buffer.from([0x80 | opcode, 0x80 | len]);
    else if (len < 65536) { head = Buffer.alloc(4); head[0] = 0x80 | opcode; head[1] = 0x80 | 126; head.writeUInt16BE(len, 2); }
    else {
      head = Buffer.alloc(10); head[0] = 0x80 | opcode; head[1] = 0x80 | 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    const masked = Buffer.from(payload.map((b, i) => b ^ mask[i % 4]));
    this.socket.write(Buffer.concat([head, mask, masked]));
  }

  /**
   * 发一条命令。默认 30 秒没回音就算失败 —— Chrome 卡死时，没有超时的 Promise 会永远挂着，
   * 上层的「她正在逛」也就永远下不来，只能重启面板。
   */
  send(method, params = {}, sessionId, { timeoutMs = 30_000 } = {}) {
    if (this.closed) return Promise.reject(new Error('CDP 连接已关闭'));
    const id = ++this.seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const t = timeoutMs > 0 ? setTimeout(() => {
        if (!this.pending.delete(id)) return;
        reject(new Error(`浏览器 ${timeoutMs / 1000} 秒没回应（${method}）`));
      }, timeoutMs) : null;
      t?.unref?.();
      const done = (fn) => (v) => { if (t) clearTimeout(t); fn(v); };
      this.pending.set(id, { resolve: done(resolve), reject: done(reject) });
      this._frame(0x1, Buffer.from(JSON.stringify(msg)));
    });
  }

  /** 等一个 CDP 事件（Page.loadEventFired 之类）。给了 sessionId 就只认那个标签页发来的 */
  waitEvent(method, timeoutMs = 15000, sessionId) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.off('event', on); reject(new Error(`等 ${method} 超时`)); }, timeoutMs);
      const on = (m) => {
        if (m.method !== method) return;
        if (sessionId && m.sessionId !== sessionId) return;
        clearTimeout(t); this.off('event', on); resolve(m.params);
      };
      this.on('event', on);
    });
  }

  close() {
    try { this._frame(0x8, Buffer.alloc(0)); } catch { /* already gone */ }
    try { this.socket.end(); } catch { /* already gone */ }
    this._closed('closed by us');
  }
}

/** 连一个 ws:// URL，带本机同源 Origin（Chrome 156 起必需） */
export function connectWs(wsUrl, { origin, timeoutMs = 8000 } = {}) {
  const u = new URL(wsUrl);
  const key = randomBytes(16).toString('base64');
  const wantOrigin = origin ?? `http://${u.hostname}:${u.port}`;
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: u.hostname, port: u.port, path: u.pathname + u.search,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': key, Origin: wantOrigin,
      },
      timeout: timeoutMs,
    });
    const t = setTimeout(() => { req.destroy(); reject(new Error('连浏览器的调试端口超时')); }, timeoutMs);
    req.on('upgrade', (res, socket) => {
      clearTimeout(t);
      const expect = createHash('sha1').update(key + GUID).digest('base64');
      if (res.headers['sec-websocket-accept'] !== expect) {
        socket.destroy();
        return reject(new Error('浏览器的调试端口握手校验失败'));
      }
      resolve(new CdpConnection(socket));
    });
    req.on('response', (res) => {
      clearTimeout(t);
      reject(new Error(`浏览器的调试端口拒绝了连接（${res.statusCode}）`));
      res.resume();
    });
    req.on('error', (e) => { clearTimeout(t); reject(new Error(`连不上浏览器的调试端口：${e.message}`)); });
    req.end();
  });
}
