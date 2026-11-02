/**
 * QQ 小号接入（面板进程里跑）
 *
 * 配置在 autopilot.json 的 qq 段（面板「自动养号 → QQ 连接」），token 在 secrets.json。
 * mode = onebot 时：连 NapCat → 只理号主（ownerQQ）的私聊 → brain.reply → 发回去。
 * mode = telegram 时：连号主建的 Telegram bot，号主是第一个私聊 bot 的人（qq.tg.ownerId），其余一样。
 * 别人私聊她一律不理（只记一笔），群消息不看。
 *
 * notify.mjs 发提醒、汇报、分享时也走这里（sendOwner）：小号能主动发，不用等号主先开口。
 * 号主让她定的提醒（remind.mjs）到点也从这里发；QQ / Telegram 都没连就留在面板聊天框里。
 *
 * 面板里也有个聊天框（panelSay / chatView）：号主坐在电脑前就不用掏手机。跟 QQ 用的是同一个大脑、
 * 同一份聊天记录（面板那几句带 via: 'panel'），所以两边接着聊不会断片；只是她回的话留在面板里，不发到 QQ。
 */
import { OneBot, seg, readMessage, imageSegments, recordSegments } from './onebot.mjs';
import { Telegram, readTgMessage, photoIds, voiceIds, whoIs } from './telegram.mjs';
import * as brain from './brain.mjs';
import * as voice from './voice.mjs';
import * as dsh from './dsh.mjs';
import * as owner from './owner.mjs';
import * as remind from '../remind.mjs';
import * as memory from '../memory.mjs';
import * as llm from '../llm.mjs';
import * as napcat from './napcat.mjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readConfig, writeConfig, readSecrets, readState, writeState, logAction, localDate } from '../store.mjs';

let bot = null; // QQ 小号（OneBot）
let tg = null; // Telegram bot；两个同时只开一个
// 号主刚发来、还没回的 [{ text, ts }]，按从哪条线来的分开排（回的时候也回到那条线上）
const queues = { qq: [], panel: [] };
const timers = {};
let busy = false;
let busyVia = null; // 正在想哪条线的回复：面板据此显示「正在输入」
let ticker = null;
const strangers = new Set();

export const MODES = ['official', 'onebot', 'telegram'];
export const directOn = (cfg = readConfig().qq) => (cfg.mode === 'onebot' && !!cfg.ownerQQ) || (cfg.mode === 'telegram' && !!readSecrets().telegramToken);
const link = () => bot || tg;
export const connected = () => !!link()?.state.connected;
/** 号主在当前这条线上的 id：QQ 号，或 Telegram 的 chat id（没绑过是空） */
const ownerId = () => (tg ? readConfig().qq.tg.ownerId : readConfig().qq.ownerQQ);

export function start() {
  stop();
  const cfg = readConfig().qq;
  if (!directOn(cfg)) return;
  if (cfg.mode === 'telegram') {
    tg = new Telegram({ token: readSecrets().telegramToken });
    tg.on('ready', (me) => logAction({ kind: 'qq', source: 'auto', detail: `Telegram 连上了（@${me?.username || ''}）` }));
    tg.on('close', () => logAction({ kind: 'qq', source: 'auto', ok: false, detail: 'Telegram 断开了，会自己重连' }));
    tg.on('message', (m) => onTgMessage(m).catch((e) => console.error('[tg]', e)));
    tg.start();
  } else {
    bot = new OneBot({ url: cfg.wsUrl, token: readSecrets().onebotToken || '' });
    bot.on('ready', (r) => logAction({ kind: 'qq', source: 'auto', detail: `QQ 小号连上了（${r?.nickname || ''} ${r?.user_id || ''}）` }));
    bot.on('close', () => logAction({ kind: 'qq', source: 'auto', ok: false, detail: 'QQ 小号断开了，会自己重连' }));
    bot.on('message', (ev) => onMessage(ev).catch((e) => console.error('[qq]', e)));
    bot.start();
  }
  voice.warmUp().catch(() => {});
  ticker = setInterval(() => tick().catch((e) => console.error('[qq] tick', e.message)), 60_000);
}

export function stop() {
  bot?.stop();
  bot = null;
  tg?.stop();
  tg = null;
  clearInterval(ticker);
  ticker = null;
}

export function status() {
  const cfg = readConfig().qq;
  const last = owner.lastFrom('owner');
  const s = link()?.state;
  return {
    mode: cfg.mode, on: directOn(cfg), connected: connected(), selfId: s?.selfId || null,
    since: s?.since || null, error: s?.error || '', startedAt: s?.startedAt || null,
    lastOwnerAt: last ? Date.parse(last.ts) : null, hasToken: !!readSecrets().onebotToken,
    hasTgToken: !!readSecrets().telegramToken, tgOwner: cfg.tg.ownerId ? cfg.tg.ownerName || cfg.tg.ownerId : '',
    facts: owner.readFacts(),
    dsh: dsh.status(),
  };
}

/** 面板要的那份：状态 + 容器 + 二维码（拿不到码就算了，别让整个接口挂掉） */
export async function panelStatus({ nap = napcat } = {}) {
  const st = status();
  const [container, code] = await Promise.all([
    nap.status().catch(() => ({ docker: false, exists: false, running: false })),
    nap.qr().catch(() => null),
  ]);
  return { ...st, container, qr: code };
}

/**
 * 一键切线路：改配置 + 起停 NapCat 容器 + 重连。面板「QQ 连接」顶部那两个按钮走这里。
 *
 * mode: 'onebot'（她自己的小号）| 'official'（官方机器人）| 'telegram'（Telegram bot）
 * startNapcat: 切到小号时要不要顺带把容器拉起来（默认要）
 * nap: 容器模块（测试时换掉，不真调 docker）
 *
 * 为什么切线路要管容器：切走（官方 / Telegram）却留着容器，它会在后台每 2 分钟重登一次、次次失败，
 * 账号只会越弄越糟；切到小号却不拉容器，面板连不上，号主还得自己开终端跑 docker compose。
 */
export async function setMode(mode, { startNapcat = true, nap = napcat } = {}) {
  if (!MODES.includes(mode)) throw new Error(`不认识的线路：${mode}`);
  const cfg = readConfig().qq;
  if (cfg.mode === mode) return { ...status(), changed: false };

  let napcatNote = '';
  if (mode !== 'onebot') {
    // 先停容器再改配置：万一停失败，配置还是小号，不至于两个都不通
    const r = await nap.down().catch((e) => { napcatNote = `（容器没停成：${e.message}）`; return null; });
    if (r && !r.skipped) napcatNote = '（顺手停了 NapCat 容器）';
    writeConfig({ qq: { mode } });
    start();
  } else {
    // 切小号：先把容器拉起来再连，省得客户端白等一轮
    writeConfig({ qq: { mode } });
    if (startNapcat) {
      await nap.up();
      napcatNote = '（容器已拉起，扫码见下面）';
    }
    start();
  }
  logAction({
    kind: 'qq',
    detail: `${{ onebot: '一键切成小号线路', official: '一键切回官方机器人', telegram: '一键切到 Telegram' }[mode]}${napcatNote}`,
  });
  return { ...status(), changed: true, napcatNote };
}

// ─── 收 ────────────────────────────────────────────────────
async function onMessage(ev) {
  const cfg = readConfig().qq;
  if (ev.message_type !== 'private') return;
  if (String(ev.user_id) !== String(cfg.ownerQQ)) {
    // 陌生人：不理，一天只记一次
    const key = `${localDate()}:${ev.user_id}`;
    if (!strangers.has(key)) { strangers.add(key); logAction({ kind: 'qq', source: 'auto', detail: `有人（${ev.user_id}）私聊小号，没理` }); }
    return;
  }
  let text = readMessage(ev);
  if (!text) return;
  // 图片先让 DSH 网关里能看图的模型看一眼，把「[图片]」换成她看到的样子
  if (text.includes('[图片]') && readConfig().qq.dsh.enabled) text = await seeImages(ev, text);
  // 语音在本机听写成文字，把「[语音]」换成他说的话
  if (text.includes('[语音]') && voice.canHear()) text = await hearVoices(ev, text);
  await take(text);
}

async function onTgMessage(msg) {
  if (msg.chat?.type !== 'private') return;
  const cfg = readConfig().qq;
  const from = String(msg.from?.id || '');
  if (!cfg.tg.ownerId) {
    // 还没认过号主：第一个私聊 bot 的人就是（面板上写着绑的是谁，不对就解绑重来）
    writeConfig({ qq: { tg: { ownerId: from, ownerName: whoIs(msg.from) } } });
    logAction({ kind: 'qq', source: 'auto', detail: `Telegram 上认出你了：${whoIs(msg.from)}` });
  } else if (from !== cfg.tg.ownerId) {
    const key = `${localDate()}:tg${from}`;
    if (!strangers.has(key)) { strangers.add(key); logAction({ kind: 'qq', source: 'auto', detail: `有人（Telegram ${whoIs(msg.from)}）私聊她，没理` }); }
    return;
  }
  let text = readTgMessage(msg);
  if (!text) return;
  if (text === '/start') text = '（刚在 Telegram 上找到你，跟你打了个招呼）';
  if (text.includes('[图片]') && readConfig().qq.dsh.enabled) {
    const hint = text.replace(/\[图片\]/g, '').trim();
    for (const id of photoIds(msg)) {
      const desc = await tg.download(id).then((b) => dsh.describeImage(b, { hint })).catch((e) => { console.error('[tg] 看图', e.message); return ''; });
      text = text.replace('[图片]', desc ? `[图片：${desc}]` : '[图片（没看清）]');
    }
  }
  if (text.includes('[语音]') && voice.canHear()) {
    for (const id of voiceIds(msg)) {
      typing();
      const said = await tg.download(id).then((b) => voice.transcribe(b, 'ogg')).catch((e) => { console.error('[tg] 听语音', e.message); return ''; });
      text = text.replace('[语音]', said ? `[语音：${said}]` : '[语音（没听清）]');
    }
  }
  await take(text);
}

/** 号主的一句话（已经看过图、听过语音）→ 排队等着一起回 */
async function take(text, via = 'qq') {
  const ch = CH[via];
  if (/^\/(new|重来|清空)$/.test(text)) {
    owner.resetContext();
    await ch.text('好，那我们重新开始聊～');
    return;
  }
  const ts = Date.now();
  owner.logChat({ from: 'owner', text, via });
  queues[via].push({ text, ts });
  // 他常常一句话分几条发：等一会儿没新的再一起回（面板上打字快，等短一点）
  clearTimeout(timers[via]);
  timers[via] = setTimeout(() => flush(via).catch((e) => console.error('[qq] flush', e)), via === 'panel' ? 1500 : 2500);
}

async function flush(via) {
  if (!queues[via].length) return;
  if (busy) { setTimeout(() => flush(via).catch(() => {}), 500); return; } // 另一条线正在回：等它说完再想这边
  const ch = CH[via];
  busy = true;
  busyVia = via;
  const batch = queues[via];
  queues[via] = [];
  try {
    ch.typing();
    if (!llm.llmReady()) { await ch.text('（面板里还没配模型，她现在没法想事情）'); return; }
    let out;
    try {
      out = await brain.reply(batch.map((b) => b.text).join('\n'), { before: batch[0].ts, model: readConfig().qq.model || undefined });
    } catch (e) {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: '想回你的时候脑子卡了' });
      await ch.text('诶，我脑子卡了一下 qwq 你再说一遍？');
      return;
    }
    await deliver(out, ch);
  } finally {
    busy = false;
    busyVia = null;
    for (const v of Object.keys(queues)) if (queues[v].length) setTimeout(() => flush(v).catch(() => {}), 300);
  }
}

/** 消息里的图：先用 OneBot 给的地址下载，下不来再问 NapCat 要；看不了的就留着 [图片] */
async function seeImages(ev, text) {
  const hint = text.replace(/\[图片\]/g, '').trim();
  for (const img of imageSegments(ev).slice(0, 3)) {
    let desc = '';
    try {
      const buf = await fetchImage(img);
      if (buf) desc = await dsh.describeImage(buf, { hint });
    } catch (e) { console.error('[qq] 看图', e.message); }
    text = text.replace('[图片]', desc ? `[图片：${desc}]` : '[图片（没看清）]');
  }
  return text;
}

/** 消息里的语音：问 NapCat 要 mp3，本机听写；听不了的就留着 [语音] */
async function hearVoices(ev, text) {
  for (const rec of recordSegments(ev).slice(0, 3)) {
    let said = '';
    try {
      typing(); // 听的时候也显示「正在输入」
      const r = await bot?.call('get_record', { file: rec.file, out_format: 'mp3' });
      if (r?.base64) said = await voice.transcribe(Buffer.from(r.base64, 'base64'));
    } catch (e) { console.error('[qq] 听语音', e.message); }
    text = text.replace('[语音]', said ? `[语音：${said}]` : '[语音（没听清）]');
  }
  return text;
}

async function fetchImage({ url, file }) {
  const get = async (u) => {
    const r = await fetch(u, { signal: AbortSignal.timeout(20000) });
    const b = Buffer.from(await r.arrayBuffer());
    return r.ok && dsh.isImage(b) ? b : null;
  };
  if (url) { const b = await get(url).catch(() => null); if (b) return b; }
  const r = await bot?.call('get_image', { file }).catch(() => null);
  if (r?.base64) return Buffer.from(r.base64, 'base64');
  if (r?.url) return get(r.url).catch(() => null);
  return null;
}

// ─── 发 ────────────────────────────────────────────────────
async function deliver(out, ch) {
  // 平时回的话，有一定概率直接念给他听（她自己没想发语音、话也念得出来的时候）
  const said = !out.voice && Math.random() < (readConfig().qq.voiceChance ?? 0) ? voice.speakable(out.text) : null;
  if (said) { out.voice = { text: said, voice: voice.DEFAULT_VOICE }; out.text = ''; }
  if (out.text) await ch.text(out.text);
  if (out.research) doResearch(out.research, ch);
  if (out.makeSticker) doSticker(out.makeSticker, ch);
  if (out.sticker) {
    try { await ch.sticker(out.sticker); } catch (e) { console.error('[qq] 表情包', e.message); }
  }
  if (out.voice) {
    try {
      await ch.voice(await brain.voiceB64(out.voice.text, out.voice.voice), out.voice.text);
    } catch (e) {
      console.error('[qq] 语音', e.message);
      await ch.text(out.voice.text); // 语音发不出去就打字说
    }
  }
}

// ─── 外挂：后台做，做完她自己说 ───────────────────────────────
function doResearch(question, ch) {
  logAction({ kind: 'qq', source: 'auto', detail: `🔎 交给 DSH 去查：${question.slice(0, 60)}` });
  dsh.research(question)
    .then(async (r) => {
      logAction({ kind: 'qq', source: 'auto', detail: `🔎 查到了（${Math.round(r.ms / 1000)} 秒，用了 ${[...new Set(r.tools)].join('、') || '没用工具'}）`, meta: { question } });
      const line = await brain.researchReply(question, r.text).catch(() => r.text.slice(0, 400));
      await ch.text(line || r.text.slice(0, 400), 'report');
    })
    .catch(async (e) => {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `🔎 没查成：${question.slice(0, 40)}` });
      await ch.text('呜，我去查了一圈没查成 qwq 晚点再帮你看看？', 'report').catch(() => {});
    });
}

function doSticker(x, ch) {
  dsh.makeSticker(x)
    .then(async (name) => {
      await ch.sticker(name);
      await ch.text(`嘿嘿，给自己画了张新表情：${x.zh}`, 'report');
    })
    .catch((e) => logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `想给自己做张新表情（${x.zh || ''}），没做成` }));
}

// 下面这几个是两条线唯一不一样的地方：QQ 发消息段，Telegram 调各自的方法
function to() {
  if (!link()) throw new Error('QQ 小号 / Telegram 都没开');
  const id = ownerId();
  if (!id) throw new Error(tg ? '还不知道 Telegram 上哪个是你：先给 bot 发一句话' : '还没填你的 QQ 号');
  return id;
}

/** 「对方正在输入…」，发不出去也无所谓 */
function typing() {
  const id = ownerId();
  if (!id) return;
  if (tg) tg.typing(id).catch(() => {});
  else bot?.call('set_input_status', { user_id: Number(id), event_type: 1 }).catch(() => {}); // NapCat 才有
}

async function sendText(text, kind) {
  const id = to();
  if (tg) await tg.sendText(id, text);
  else await bot.sendPrivate(id, [seg.text(text)]);
  owner.logChat({ from: 'her', text, kind });
}

async function sendSticker(name) {
  const id = to();
  const b64 = brain.stickerB64(name);
  if (tg) await tg.sendPhoto(id, Buffer.from(b64, 'base64'), `${name}.png`);
  else await bot.sendPrivate(id, [seg.image(b64)]);
  owner.logChat({ from: 'her', text: name, kind: 'sticker' });
}

/** mp3 的 base64 → 语音（Telegram 要转成 ogg opus 才是语音条） */
async function sendVoice(b64, text) {
  const id = to();
  if (tg) await tg.sendVoice(id, voice.toOgg(Buffer.from(b64, 'base64')));
  else await bot.sendPrivate(id, [seg.record(b64)]);
  owner.logChat({ from: 'her', text, kind: 'voice' });
}

// ─── 面板聊天框 ─────────────────────────────────────────────
// 她回的话只写进聊天记录（via: 'panel'），面板自己来拉；语音存成 mp3 放 data/chat-voice/
export const VOICE_DIR = join(DATA, 'chat-voice');
const panelSay = (extra) => owner.logChat({ from: 'her', via: 'panel', ...extra });
const PANEL = {
  async text(text, kind) { panelSay({ text, kind }); },
  async sticker(name) { panelSay({ text: name, kind: 'sticker' }); },
  async voice(b64, text) {
    mkdirSync(VOICE_DIR, { recursive: true });
    const file = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}.mp3`;
    writeFileSync(join(VOICE_DIR, file), Buffer.from(b64, 'base64'));
    panelSay({ text, kind: 'voice', file });
  },
  typing() {}, // 面板看 busyVia
};
const CH = { qq: { text: sendText, sticker: sendSticker, voice: sendVoice, typing }, panel: PANEL };

/** 号主在面板聊天框里说了一句 */
export async function panelChat(text) {
  const t = String(text || '').trim().slice(0, 2000);
  if (!t) throw new Error('说点什么呀');
  await take(t, 'panel');
  return { ok: true };
}

/** 面板聊天框要的：最近的聊天（两条线都有，after 之后的），她是不是正在想面板这边的回复 */
export function chatView(after = '') {
  const list = after ? owner.readChat().filter((e) => e.ts > after && e.kind !== 'reset') : owner.recentChat(60);
  return {
    list: list.slice(-100).map(({ ts, from, text, kind, via, file }) => ({ ts, from, text, kind: kind || 'text', via: via || 'qq', file })),
    typing: busyVia === 'panel' || queues.panel.length > 0,
    llm: llm.llmReady(),
  };
}

/** 面板「解绑」：Telegram 上绑错人了，清掉，下一个私聊 bot 的人重新认 */
export function unbindTg() {
  writeConfig({ qq: { tg: { ownerId: '', ownerName: '' } } });
  logAction({ kind: 'qq', detail: '解绑了 Telegram 上的号主，下一个私聊 bot 的人会被认成你' });
  return status();
}

/** 给 notify.mjs：主动给号主发一句（汇报、提醒、分享） */
export async function sendOwner(text, kind = 'notice') {
  if (!connected()) throw new Error(tg ? 'Telegram 没连上' : 'QQ 小号没连上');
  await sendText(text, kind);
  return { id: '' };
}

// ─── 每分钟：主动找他、每晚整理聊天 ───────────────────────────
async function tick(now = Date.now()) {
  if (!connected()) return;
  const cfg = readConfig();
  const st = readState();
  const today = localDate(new Date(now));

  // 每晚整理一次今天的聊天：补记他的事，写一句进她自己的记忆
  if (new Date(now).getHours() >= cfg.mind.reflectHour && st.qqDigestOn !== today && llm.llmReady()) {
    writeState({ ...st, qqDigestOn: today });
    const r = await owner.digestToday({ today, remember: (t, emo) => memory.add({ kind: 'chat', imp: 3, emo, text: `跟号主聊天：${t}` }) }).catch(() => null);
    if (r?.added) logAction({ kind: 'qq', source: 'auto', detail: `🌙 翻了翻今天跟你聊的，多记住了 ${r.added} 件关于你的事` });
    return;
  }

  if (!brain.reachOutDue(now, cfg.qq, st) || busy || queues.qq.length || queues.panel.length || !llm.llmReady() || Math.random() > 0.5) return;
  const s2 = readState();
  const prev = s2.reachOut?.date === today ? s2.reachOut : { date: today, n: 0 };
  writeState({ ...s2, reachOut: { ...prev, triedAt: now } });
  const line = await brain.reachOutLine(now).catch(() => null);
  if (!line) return;
  await sendText(line, 'proactive');
  const s3 = readState();
  writeState({ ...s3, reachOut: { ...prev, n: prev.n + 1, triedAt: now } });
  logAction({ kind: 'notify', source: 'auto', detail: `主动找你：${line.slice(0, 60)}`, meta: { proactive: true } });
}

// ─── 到点提醒：不管连没连 QQ 都在跑（没连就说在面板里）─────────────
let remindTimer = null;
export function startReminders() {
  clearInterval(remindTimer);
  remindTimer = setInterval(() => fireReminders().catch((e) => console.error('[remind]', e.message)), 30_000);
  remindTimer.unref?.();
}

export async function fireReminders(now = Date.now()) {
  const due = remind.takeDue(now);
  for (const r of due) {
    const where = await tellOwner(await brain.remindLine(r), 'remind');
    logAction({ kind: 'remind', source: 'auto', target: r.id, detail: `⏰ 到点提醒了你（${where}）：${r.text}` });
  }
  return due.length;
}

/** 跟号主说一句：QQ / Telegram 连着就发那边，没连或发失败就留在面板聊天框。返回发到哪了 */
export async function tellOwner(text, kind) {
  try {
    if (connected()) { await sendText(text, kind); return tg ? 'Telegram' : 'QQ'; }
  } catch (e) { console.error('[qq] 说一句', e.message); }
  await PANEL.text(text, kind);
  return '面板';
}

/** 面板「发条测试」 */
export async function test() {
  await sendText(tg ? '🐟 测试一下：以后我在 Telegram 上跟你说话啦' : '🐟 测试一下：以后我用这个号跟你说话啦');
  return { ok: true };
}
