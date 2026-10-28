/**
 * Telegram Bot API 客户端（QQ 小号被踢以后的另一条线）
 *
 * 号主在 @BotFather 建的 bot，token 在 secrets.json 的 telegramToken。官方开放的接口，不会被封。
 * 收：长轮询 getUpdates（不用公网地址、不用 webhook）。断了就自己重试（3 秒起，最多隔 1 分钟）。
 * 发：文字 / 图片 / 语音条（ogg opus，Telegram 上显示成真的语音条）。
 *
 * 要能连上 api.telegram.org：本机开着全局 / TUN 模式的代理就行。
 * 不依赖任何 npm 包：Node 自带 fetch、FormData、Blob。
 */
import { EventEmitter } from 'node:events';

const API = 'https://api.telegram.org';

export class Telegram extends EventEmitter {
  constructor({ token, fetchImpl = globalThis.fetch, pollSec = 50 } = {}) {
    super();
    this.token = token;
    this.fetch = fetchImpl;
    this.pollSec = pollSec;
    this.offset = 0;
    this.backoff = 3000;
    this.stopped = true;
    this.abort = null;
    this.state = { connected: false, selfId: null, since: null, lastEventAt: null, error: '', startedAt: null };
  }

  start() {
    if (!this.stopped) return;
    if (!this.token) throw new Error('还没填 Telegram bot 的 token');
    this.stopped = false;
    this.state.startedAt = Date.now();
    this.#loop();
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.retry);
    this.abort?.abort();
    this.abort = null;
    this.state.connected = false;
  }

  async #loop() {
    try {
      const me = await this.call('getMe');
      // 设过 webhook 的话 getUpdates 会一直 409，先清掉
      await this.call('deleteWebhook').catch(() => {});
      this.state.selfId = me.username ? `@${me.username}` : String(me.id);
      Object.assign(this.state, { connected: true, since: Date.now(), error: '' });
      this.backoff = 3000;
      this.emit('ready', me);
      while (!this.stopped) {
        const ups = await this.call('getUpdates', { offset: this.offset, timeout: this.pollSec, allowed_updates: ['message'] }, (this.pollSec + 15) * 1000);
        this.state.lastEventAt = Date.now();
        for (const u of ups) {
          this.offset = u.update_id + 1;
          if (u.message) this.emit('message', u.message);
        }
      }
    } catch (e) {
      if (this.stopped) return;
      const was = this.state.connected;
      Object.assign(this.state, { connected: false, error: e.message });
      if (was) this.emit('close');
      clearTimeout(this.retry);
      this.retry = setTimeout(() => this.#loop(), this.backoff);
      this.backoff = Math.min(this.backoff * 2, 60_000);
    }
  }

  /** 调一个 Bot API 方法。body 是普通对象就发 JSON，是 FormData 就原样发（传文件） */
  async call(method, body = {}, timeoutMs = 20000) {
    const ctl = new AbortController();
    if (method === 'getUpdates') this.abort = ctl;
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const form = body instanceof FormData;
      const r = await this.fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: form ? undefined : { 'Content-Type': 'application/json' },
        body: form ? body : JSON.stringify(body),
        signal: ctl.signal,
      });
      const j = await r.json().catch(() => ({}));
      if (!j.ok) throw new Error(r.status === 401 ? 'token 不对（Telegram 说未授权）' : `${method}：${j.description || `HTTP ${r.status}`}`);
      return j.result;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error(`${method} 超时`);
      // fetch 连不上时真正的原因在 cause 里（多半是没开代理）
      if (e.cause?.code) throw new Error(`连不上 Telegram（${e.cause.code}），代理开着吗`);
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  sendText(chatId, text) { return this.call('sendMessage', { chat_id: chatId, text }); }

  /** 「正在输入…」「正在录音…」，五秒后自己消失 */
  typing(chatId, action = 'typing') { return this.call('sendChatAction', { chat_id: chatId, action }); }

  sendPhoto(chatId, buf, name = 'sticker.png') { return this.#upload('sendPhoto', chatId, 'photo', buf, name, 'image/png'); }

  /** ogg opus 才显示成语音条 */
  sendVoice(chatId, ogg) { return this.#upload('sendVoice', chatId, 'voice', ogg, 'voice.ogg', 'audio/ogg', 60000); }

  #upload(method, chatId, field, buf, name, type, timeoutMs = 30000) {
    const f = new FormData();
    f.set('chat_id', String(chatId));
    f.set(field, new Blob([buf], { type }), name);
    return this.call(method, f, timeoutMs);
  }

  /** 收到的图片 / 语音：file_id → 文件内容 */
  async download(fileId) {
    const { file_path: p } = await this.call('getFile', { file_id: fileId });
    const r = await this.fetch(`${API}/file/bot${this.token}/${p}`, { signal: AbortSignal.timeout(30000) });
    if (!r.ok) throw new Error(`下载文件 HTTP ${r.status}`);
    return Buffer.from(await r.arrayBuffer());
  }
}

/** 消息里的图：photo 取最大那张；当文件发来的图也算 */
export function photoIds(msg) {
  if (Array.isArray(msg.photo) && msg.photo.length) return [msg.photo.at(-1).file_id];
  if (msg.document?.mime_type?.startsWith('image/')) return [msg.document.file_id];
  return [];
}

/** 消息里的语音（语音条或音频文件） */
export const voiceIds = (msg) => [msg.voice?.file_id || msg.audio?.file_id].filter(Boolean);

/**
 * 收到的消息 → 一句给她看的文字。跟 onebot.readMessage 一样：图和语音先如实写成 [图片] [语音]，看过、听过了再换成内容。
 */
export function readTgMessage(msg) {
  const parts = [];
  if (photoIds(msg).length) parts.push('[图片]');
  if (voiceIds(msg).length) parts.push('[语音]');
  if (msg.sticker) parts.push(`[表情包${msg.sticker.emoji || ''}]`);
  if (msg.video || msg.video_note || msg.animation) parts.push('[视频]');
  if (msg.document && !photoIds(msg).length) parts.push(`[文件 ${msg.document.file_name || ''}]`);
  const text = msg.text || msg.caption || '';
  return (parts.join('') + text).trim();
}

/** 发消息的人叫什么（面板里给号主核对「绑的是不是我」） */
export const whoIs = (from = {}) => [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ` @${from.username}` : '');
