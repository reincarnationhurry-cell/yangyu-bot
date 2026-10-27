/**
 * QQ 小号接入（面板进程里跑）
 *
 * 配置在 autopilot.json 的 qq 段（面板「自动养号 → QQ 连接」），token 在 secrets.json。
 * mode = onebot 时：连 NapCat → 只理号主（ownerQQ）的私聊 → brain.reply → 发回去。
 * 别人私聊她一律不理（只记一笔），群消息不看。
 *
 * notify.mjs 发提醒、汇报、分享时也走这里（sendOwner）：小号能主动发，不用等号主先开口。
 */
import { OneBot, seg, readMessage, imageSegments, recordSegments } from './onebot.mjs';
import * as brain from './brain.mjs';
import * as voice from './voice.mjs';
import * as dsh from './dsh.mjs';
import * as owner from './owner.mjs';
import * as memory from '../memory.mjs';
import * as llm from '../llm.mjs';
import { readConfig, readSecrets, readState, writeState, logAction, localDate } from '../store.mjs';

let bot = null;
let queue = []; // 号主刚发来、还没回的 [{ text, ts }]
let timer = null;
let busy = false;
let ticker = null;
const strangers = new Set();

export const directOn = (cfg = readConfig().qq) => cfg.mode === 'onebot' && !!cfg.ownerQQ;
export const connected = () => !!bot?.state.connected;

export function start() {
  stop();
  const cfg = readConfig().qq;
  if (!directOn(cfg)) return;
  bot = new OneBot({ url: cfg.wsUrl, token: readSecrets().onebotToken || '' });
  bot.on('ready', (r) => logAction({ kind: 'qq', source: 'auto', detail: `QQ 小号连上了（${r?.nickname || ''} ${r?.user_id || ''}）` }));
  bot.on('close', () => logAction({ kind: 'qq', source: 'auto', ok: false, detail: 'QQ 小号断开了，会自己重连' }));
  bot.on('message', (ev) => onMessage(ev).catch((e) => console.error('[qq]', e)));
  bot.start();
  voice.warmUp().catch(() => {});
  ticker = setInterval(() => tick().catch((e) => console.error('[qq] tick', e.message)), 60_000);
}

export function stop() {
  bot?.stop();
  bot = null;
  clearInterval(ticker);
  ticker = null;
}

export function status() {
  const cfg = readConfig().qq;
  const last = owner.lastFrom('owner');
  return {
    mode: cfg.mode, on: directOn(cfg), connected: connected(), selfId: bot?.state.selfId || null,
    since: bot?.state.since || null, error: bot?.state.error || '', startedAt: bot?.state.startedAt || null,
    lastOwnerAt: last ? Date.parse(last.ts) : null, hasToken: !!readSecrets().onebotToken,
    facts: owner.readFacts(),
    dsh: dsh.status(),
  };
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
  if (/^\/(new|重来|清空)$/.test(text)) {
    owner.resetContext();
    await sendText('好，那我们重新开始聊～');
    return;
  }
  const ts = Date.now();
  owner.logChat({ from: 'owner', text });
  queue.push({ text, ts });
  // 他常常一句话分几条发：等 2.5 秒没新的再一起回
  clearTimeout(timer);
  timer = setTimeout(() => flush().catch((e) => console.error('[qq] flush', e)), 2500);
}

async function flush() {
  if (busy || !queue.length) return;
  busy = true;
  const batch = queue;
  queue = [];
  try {
    bot?.call('set_input_status', { user_id: Number(readConfig().qq.ownerQQ), event_type: 1 }).catch(() => {}); // NapCat：「对方正在输入」
    if (!llm.llmReady()) { await sendText('（面板里还没配模型，她现在没法想事情）'); return; }
    let out;
    try {
      out = await brain.reply(batch.map((b) => b.text).join('\n'), { before: batch[0].ts, model: readConfig().qq.model || undefined });
    } catch (e) {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: '想回你的时候脑子卡了' });
      await sendText('诶，我脑子卡了一下 qwq 你再说一遍？');
      return;
    }
    await deliver(out);
  } finally {
    busy = false;
    if (queue.length) setTimeout(() => flush().catch(() => {}), 300);
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
      bot?.call('set_input_status', { user_id: Number(readConfig().qq.ownerQQ), event_type: 1 }).catch(() => {}); // 听的时候也显示「正在输入」
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
async function deliver(out) {
  // 平时回的话，有一定概率直接念给他听（她自己没想发语音、话也念得出来的时候）
  const said = !out.voice && Math.random() < (readConfig().qq.voiceChance ?? 0) ? voice.speakable(out.text) : null;
  if (said) { out.voice = { text: said, voice: voice.DEFAULT_VOICE }; out.text = ''; }
  if (out.text) await sendText(out.text);
  if (out.research) doResearch(out.research);
  if (out.makeSticker) doSticker(out.makeSticker);
  if (out.sticker) {
    try {
      await bot.sendPrivate(readConfig().qq.ownerQQ, [seg.image(brain.stickerB64(out.sticker))]);
      owner.logChat({ from: 'her', text: out.sticker, kind: 'sticker' });
    } catch (e) { console.error('[qq] 表情包', e.message); }
  }
  if (out.voice) {
    try {
      await bot.sendPrivate(readConfig().qq.ownerQQ, [seg.record(await brain.voiceB64(out.voice.text, out.voice.voice))]);
      owner.logChat({ from: 'her', text: out.voice.text, kind: 'voice' });
    } catch (e) {
      console.error('[qq] 语音', e.message);
      await sendText(out.voice.text); // 语音发不出去就打字说
    }
  }
}

// ─── 外挂：后台做，做完她自己说 ───────────────────────────────
function doResearch(question) {
  logAction({ kind: 'qq', source: 'auto', detail: `🔎 交给 DSH 去查：${question.slice(0, 60)}` });
  dsh.research(question)
    .then(async (r) => {
      logAction({ kind: 'qq', source: 'auto', detail: `🔎 查到了（${Math.round(r.ms / 1000)} 秒，用了 ${[...new Set(r.tools)].join('、') || '没用工具'}）`, meta: { question } });
      const line = await brain.researchReply(question, r.text).catch(() => r.text.slice(0, 400));
      await sendText(line || r.text.slice(0, 400), 'report');
    })
    .catch(async (e) => {
      logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `🔎 没查成：${question.slice(0, 40)}` });
      await sendText('呜，我去查了一圈没查成 qwq 晚点再帮你看看？', 'report').catch(() => {});
    });
}

function doSticker(x) {
  dsh.makeSticker(x)
    .then(async (name) => {
      await bot.sendPrivate(readConfig().qq.ownerQQ, [seg.image(brain.stickerB64(name))]);
      owner.logChat({ from: 'her', text: name, kind: 'sticker' });
      await sendText(`嘿嘿，给自己画了张新表情：${x.zh}`, 'report');
    })
    .catch((e) => logAction({ kind: 'qq', source: 'auto', ok: false, error: e.message, detail: `想给自己做张新表情（${x.zh || ''}），没做成` }));
}

async function sendText(text, kind) {
  if (!bot) throw new Error('QQ 小号没开');
  await bot.sendPrivate(readConfig().qq.ownerQQ, [seg.text(text)]);
  owner.logChat({ from: 'her', text, kind });
}

/** 给 notify.mjs：主动给号主发一句（汇报、提醒、分享） */
export async function sendOwner(text, kind = 'notice') {
  if (!connected()) throw new Error('QQ 小号没连上');
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
    const r = await owner.digestToday({ today, remember: (t) => memory.add({ kind: 'chat', imp: 3, text: `跟号主聊天：${t}` }) }).catch(() => null);
    if (r?.added) logAction({ kind: 'qq', source: 'auto', detail: `🌙 翻了翻今天跟你聊的，多记住了 ${r.added} 件关于你的事` });
    return;
  }

  if (!brain.reachOutDue(now, cfg.qq, st) || busy || queue.length || !llm.llmReady() || Math.random() > 0.5) return;
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

/** 面板「发条测试」 */
export async function test() {
  await sendText('🐟 测试一下：以后我用这个号跟你说话啦');
  return { ok: true };
}
