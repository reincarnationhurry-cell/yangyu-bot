/**
 * QQ 提醒：有东西要号主审（今晚的日记、想发的评论、想回的话），就让她在 QQ 里主动说一声。
 *
 * 走的是 QQ 官方机器人的单聊接口（和 DSH 里接的是同一个机器人）：
 *   1. POST https://bots.qq.com/app/getAppAccessToken   { appId, clientSecret } → access_token
 *   2. POST https://api.sgroup.qq.com/v2/users/{openid}/messages   { content, msg_type: 0 }
 * 不带 msg_id 的是「主动消息」，平台对条数有限额（而且会变），所以这里自己再卡一道每日上限，
 * 发不出去也没关系 —— 下次你在 QQ 跟她说话时，她会先翻待审，照样会问你。
 *
 * 凭证来源（面板「自动养号 → QQ 提醒」里选）：
 *   - dsh：运行时读 DSH 的 ~/.dsh/dsh-im-connect/channels.json（不复制、不落盘、不回传页面）
 *   - manual：你在面板里填，存在 data/secrets.json（600 权限）
 */
import { readFileSync, existsSync, writeFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readConfig, readSecrets, localDate, nowIso, logAction, DATA, readPause } from './store.mjs';
import * as llm from './llm.mjs';

const DSH_CHANNELS = join(homedir(), '.dsh', 'dsh-im-connect', 'channels.json');
const STATE = join(DATA, 'notify.json');

function readState() {
  try { return JSON.parse(readFileSync(STATE, 'utf-8')); } catch { return { sent: {}, log: [] }; }
}
function writeState(s) {
  const tmp = STATE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2));
  renameSync(tmp, STATE);
}

function dshChannel() {
  if (!existsSync(DSH_CHANNELS)) return {};
  try {
    const all = JSON.parse(readFileSync(DSH_CHANNELS, 'utf-8')).channels || {};
    const ch = Object.values(all).find((c) => c.platform === 'qq' && c.enabled !== false) || Object.values(all)[0];
    return ch?.config || {};
  } catch { return {}; }
}

// 面板里填的优先；没填的从 DSH 补（DSH 一般只存 AppID 和你的 openid，AppSecret 放在钥匙串里读不到）
function credentials() {
  const cfg = readConfig().notify;
  const s = readSecrets();
  const d = cfg.source === 'manual' ? {} : dshChannel();
  return {
    appId: s.qqAppId || d.appId,
    secret: s.qqAppSecret || d.appSecret,
    // 被动回复借的是 DSH 收到的 msg_id，openid 必须是 DSH 那边的；手填的对不上会被拒（11001）
    openId: dshChannel().ownerOpenId || s.qqOpenId,
    from: cfg.source === 'manual' ? '面板里填的' : 'DSH',
  };
}

let token = null; // { value, until }
async function accessToken(appId, secret) {
  if (token && token.appId === appId && Date.now() < token.until) return token.value;
  const r = await fetch('https://bots.qq.com/app/getAppAccessToken', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appId: String(appId), clientSecret: String(secret) }),
    signal: AbortSignal.timeout(10000),
  }).then((x) => x.json());
  if (!r.access_token) throw new Error(`QQ 机器人拿不到 token：${r.message || r.code || '未知错误'}（检查 AppID / AppSecret）`);
  token = { appId, value: r.access_token, until: Date.now() + (Number(r.expires_in) - 60) * 1000 };
  return token.value;
}

// 实测：不带 msg_id 的单聊「主动消息」会被拒（11001 不支持的调用），平台已经不给这类机器人主动推送了。
// 还能用的是「被动回复」：带上你最近一条消息的 msg_id，在它之后 60 分钟内回复（每条消息最多回几次）。
// DSH 把收到的消息 id 记在 seen.json 里（"qq_渠道:ROBOT1.0_…"），文件修改时间≈你最近一次说话的时间。
const DSH_SEEN = join(homedir(), '.dsh', 'dsh-im-connect', 'seen.json');
const PASSIVE_WINDOW = 55 * 60_000; // 留 5 分钟余量

export function lastOwnerMessage() {
  try {
    const { mtimeMs } = statSync(DSH_SEEN);
    const ids = JSON.parse(readFileSync(DSH_SEEN, 'utf-8')).ids || [];
    const last = String(ids[ids.length - 1] || '');
    const msgId = last.includes(':') ? last.slice(last.indexOf(':') + 1) : last;
    if (!msgId) return null;
    return { msgId, at: mtimeMs, fresh: Date.now() - mtimeMs < PASSIVE_WINDOW };
  } catch { return null; }
}

export class NotInWindow extends Error {}

/** 直接发一条（不看开关和上限），给「测试」按钮和 notifyReview 用 */
async function rawSend(text) {
  const { appId, secret, openId, from } = credentials();
  if (!appId || !secret || !openId) {
    throw new Error(`QQ 机器人凭证不全（${from}）：还缺 ${[!appId && 'AppID', !secret && 'AppSecret', !openId && 'openid'].filter(Boolean).join('、')}`);
  }
  const last = lastOwnerMessage();
  if (!last?.fresh) {
    throw new NotInWindow('你最近一小时没在 QQ 跟她说话，QQ 不让机器人主动开口。先跟她说句话，一小时内就能提醒你');
  }
  const t = await accessToken(appId, secret);
  const res = await fetch(`https://api.sgroup.qq.com/v2/users/${encodeURIComponent(openId)}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `QQBot ${t}` },
    // msg_seq：同一条 msg_id 下的回复序号，重复会被当成重发丢掉，所以随机取一个大点的
    body: JSON.stringify({ content: text, msg_type: 0, msg_id: last.msgId, msg_seq: 100 + Math.floor(Math.random() * 1e6) }),
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.code) {
    const m = j.message || `HTTP ${res.status}`;
    // 主动消息额度用完 / 没有主动消息权限时，平台会拒绝；这不是坏了
    throw new Error(`QQ 拒绝了这条主动消息：${m}${j.code ? `（${j.code}）` : ''}`);
  }
  return { id: j.id || '' };
}

function quiet(cfg) {
  const h = new Date().getHours();
  const { quietStart: a, quietEnd: b } = cfg;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

export function status() {
  const cfg = readConfig().notify;
  const st = readState();
  let ready = false;
  let why = '';
  try {
    const c = credentials();
    ready = !!(c.appId && c.secret && c.openId);
    if (!ready) {
      const miss = [!c.appId && 'AppID', !c.secret && 'AppSecret', !c.openId && 'openid'].filter(Boolean).join('、');
      why = `还缺 ${miss}，在下面填一下`;
    }
  } catch (e) { why = e.message; }
  const last = lastOwnerMessage();
  return {
    config: cfg, ready, why,
    sentToday: st.sent?.[localDate()] || 0,
    pending: (st.pending || []).length,
    windowOpen: !!last?.fresh,
    windowUntil: last ? last.at + PASSIVE_WINDOW : null,
    log: (st.log || []).slice(-8).reverse(),
  };
}

/** 测试用：无视开关和上限 */
export async function sendOwner(text) {
  const r = await rawSend(text);
  const st = readState();
  st.log = [...(st.log || []), { ts: nowIso(), ok: true, text: text.slice(0, 60), test: true }].slice(-30);
  writeState(st);
  return r;
}

/**
 * 有新的待审时调用。受开关、种类、深夜免打扰、每日上限约束；
 * 失败只记一笔，不往外抛 —— 提醒不到，下次聊天时她照样会问。
 */
export async function notifyReview(r) {
  const cfg = readConfig().notify;
  if (!cfg.enabled || !cfg.kinds?.[r.kind]) return { sent: false, why: 'off' };
  if (quiet(cfg)) return { sent: false, why: 'quiet' };
  const st = readState();
  // 号主叫停了：先排着，等他说好了、再开口时一起补上
  if (readPause()) {
    st.pending = [...(st.pending || []).filter((p) => p.review !== r.id), { review: r.id, ts: Date.now() }];
    writeState(st);
    return { sent: false, why: 'paused' };
  }
  const today = localDate();
  if ((st.sent?.[today] || 0) >= cfg.dailyMax) return { sent: false, why: 'cap' };

  const text = composeReviewMessage(r);
  try {
    await rawSend(text);
    markSent(st, [r.id], text);
    writeState(st);
    logAction({ kind: 'notify', source: 'auto', target: r.id, detail: `在 QQ 里叫你审：${text.split('\n')[0]}` });
    return { sent: true };
  } catch (e) {
    if (e instanceof NotInWindow) {
      // 不在回复窗口里：排队，等你下次在 QQ 说话就立刻补上（flushPending）
      st.pending = [...(st.pending || []).filter((p) => p.review !== r.id), { review: r.id, ts: Date.now() }];
      writeState(st);
      return { sent: false, why: 'deferred' };
    }
    st.log = [...(st.log || []), { ts: nowIso(), ok: false, kind: r.kind, review: r.id, error: e.message }].slice(-30);
    writeState(st);
    logAction({ kind: 'notify', source: 'auto', ok: false, target: r.id, error: e.message, detail: 'QQ 提醒没发出去（下次聊天时她会问你）' });
    return { sent: false, why: e.message };
  }
}

/**
 * QQ 里的她交给后台的活做完了：用她的口吻在 QQ 里汇报。
 * 号主刚亲口交代的事，所以不看提醒开关、免打扰和每日上限（也不占这些额度）；
 * 只受 QQ 的回复窗口约束 —— 窗口关了就排队，号主下次说话时 flushPending 补上。
 */
export async function reportTask(task, { ok, note, watched = [] }) {
  let text = null;
  if (llm.llmReady()) {
    text = await llm.draftReport({ request: task.note || task.type, ok, note, watched }).catch(() => null);
  }
  if (!text) text = composeTaskReport(task, { ok, note, watched });
  try {
    await rawSend(text);
    const st = readState();
    st.log = [...(st.log || []), { ts: nowIso(), ok: true, task: task.id, text: text.slice(0, 60) }].slice(-30);
    writeState(st);
    logAction({ kind: 'notify', source: 'auto', target: task.id, detail: `在 QQ 里汇报：${text.slice(0, 60)}` });
    return { sent: true };
  } catch (e) {
    const st = readState();
    if (e instanceof NotInWindow) {
      st.pending = [...(st.pending || []), { task: task.id, text, ts: Date.now() }];
      writeState(st);
      return { sent: false, why: 'deferred' };
    }
    st.log = [...(st.log || []), { ts: nowIso(), ok: false, task: task.id, error: e.message }].slice(-30);
    writeState(st);
    logAction({ kind: 'notify', source: 'auto', ok: false, target: task.id, error: e.message, detail: '活干完了，但 QQ 汇报没发出去' });
    return { sent: false, why: e.message };
  }
}

/**
 * 她刷到特别想给你看的东西，自己忍不住说一句（mind.mjs 决定什么时候想说）。
 * 不排队：过了回复窗口再补发就不是「刚刷到」了；深夜免打扰照样生效。
 */
export async function impulse(text) {
  const cfg = readConfig().notify;
  if (quiet(cfg)) return { sent: false, why: 'quiet' };
  if (readPause()) return { sent: false, why: 'paused' };
  if (!lastOwnerMessage()?.fresh) return { sent: false, why: 'window' };
  try {
    await rawSend(text);
    const st = readState();
    st.log = [...(st.log || []), { ts: nowIso(), ok: true, impulse: true, text: text.slice(0, 60) }].slice(-30);
    writeState(st);
    logAction({ kind: 'notify', source: 'auto', detail: `忍不住跟你说：${text.split('\n')[0]}`, meta: { impulse: true } });
    return { sent: true };
  } catch (e) {
    return { sent: false, why: e.message };
  }
}

function composeTaskReport(task, { ok, note, watched }) {
  const what = (task.note || task.type).slice(0, 30);
  if (!ok) return `「${what}」没做成 qwq：${note}`;
  const pick = watched[0] ? `，最喜欢的是《${watched[0].title}》` : '';
  return `「${what}」搞定啦～${note}${pick}`;
}

function markSent(st, ids, text) {
  const today = localDate();
  st.sent = { ...Object.fromEntries(Object.entries(st.sent || {}).sort().slice(-6)), [today]: (st.sent?.[today] || 0) + 1 };
  st.reminded = [...new Set([...(st.reminded || []), ...ids])].slice(-100);
  st.log = [...(st.log || []), { ts: nowIso(), ok: true, review: ids.join(','), text: text.slice(0, 60) }].slice(-30);
}

/** 这条待审有没有在 QQ 里提醒过（给 review.mjs 显示，省得她再问一遍） */
export function wasReminded(id) {
  return (readState().reminded || []).includes(id);
}

/**
 * 调度器每 30 秒调一次：有排队的提醒 / 汇报，而且你刚在 QQ 说过话（回复窗口开着），就补发。
 * 多条合成一条发，省额度。readReview 由调用方传进来，避免 notify 依赖待审的存储细节。
 */
export async function flushPending(readReview) {
  const st = readState();
  if (!st.pending?.length) return;
  const last = lastOwnerMessage();
  if (!last?.fresh) return;
  // 只在你「排队之后」又说了话才补发 —— 那是新的回复窗口
  const ready = st.pending.filter((p) => last.at > p.ts);
  if (!ready.length) return;

  // 活干完的汇报：是你交代的事，不看提醒开关和上限
  const reports = ready.filter((p) => p.task);
  if (reports.length) {
    const text = reports.map((p) => p.text).join('\n\n');
    st.pending = st.pending.filter((p) => !reports.includes(p));
    try {
      await rawSend(text);
      st.log = [...(st.log || []), { ts: nowIso(), ok: true, task: reports.map((p) => p.task).join(','), text: text.slice(0, 60) }].slice(-30);
      logAction({ kind: 'notify', source: 'auto', target: reports.map((p) => p.task).join(','), detail: `你刚说话，补上之前的汇报：${text.slice(0, 60)}` });
    } catch (e) {
      st.log = [...(st.log || []), { ts: nowIso(), ok: false, error: e.message }].slice(-30);
    }
    writeState(st);
  }

  const reviews = ready.filter((p) => p.review);
  if (!reviews.length || readPause()) return;
  const cfg = readConfig().notify;
  if (!cfg.enabled || quiet(cfg)) return;
  if ((st.sent?.[localDate()] || 0) >= cfg.dailyMax) return;
  const pendingIds = new Set(reviews.map((p) => p.review));
  const items = readReview().filter((r) => pendingIds.has(r.id) && r.status === 'pending' && cfg.kinds?.[r.kind]);
  st.pending = st.pending.filter((p) => !reviews.includes(p));
  if (!items.length) { writeState(st); return; }
  const text = items.length === 1
    ? composeReviewMessage(items[0])
    : `有 ${items.length} 条等你点头：\n\n${items.map((r) => composeReviewMessage(r, { brief: true })).join('\n\n')}\n\n回我「都可以」或者挑着说，比如「#${shortId(items[0].id)} 可以」～`;
  try {
    await rawSend(text);
    markSent(st, items.map((r) => r.id), text);
    writeState(st);
    logAction({ kind: 'notify', source: 'auto', target: items.map((r) => r.id).join(','), detail: `你刚说话，顺手提醒你审 ${items.length} 条` });
  } catch (e) {
    st.log = [...(st.log || []), { ts: nowIso(), ok: false, error: e.message }].slice(-30);
    writeState(st);
  }
}

export function shortId(id) { return String(id).slice(0, 6); }

function composeReviewMessage(r, { brief = false } = {}) {
  const p = r.payload || {};
  const tag = `#${shortId(r.id)}`;
  const tail = brief ? '' : `\n\n回我「可以」就发出去；想改就直接说怎么改，不要就说「算了」～（待审 ${tag}）`;
  const head = brief ? `${tag} ` : '';
  if (r.kind === 'diary') return `${head}📔 今天的养鱼日记写好啦，你看看：\n\n${r.text}${tail}`;
  if (r.kind === 'reply') return `${head}↩️ @${p.user || '有人'} 回复我说：「${(p.said || '').slice(0, 60)}」\n我想这么回：「${r.text}」${tail}`;
  return `${head}💬 刚看完《${p.title || p.bvid || '一个视频'}》，想在评论区说：「${r.text}」${tail}`;
}
