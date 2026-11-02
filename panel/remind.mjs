/**
 * 提醒：号主说「明早 8 点叫我」「每天晚上 11 点催我睡觉」，她记下来，到点自己来说
 *
 * 时间由她（模型）从号主的话里算成「YYYY-MM-DD HH:mm」本地时间，这里只管存、到点、重复。
 * 到点了 qq/index.mjs 每分钟来拿（due），用她的口吻说一句，发到 QQ / Telegram；都没连就留在面板聊天框里。
 * 面板停着错过了的：晚了 6 小时以内照样提醒（说一声迟到了），再晚就算错过，只记一笔。
 * 叫停（打游戏、开会）不拦提醒：这是号主自己要的。
 */
import { join } from 'node:path';
import { DATA, readJson, writeJson, nowIso, logAction } from './store.mjs';

const FILE = join(DATA, 'reminders.json');
export const REPEATS = ['none', 'daily', 'weekdays', 'weekly'];
const REPEAT_ZH = { none: '', daily: '每天', weekdays: '工作日', weekly: '每周' };
const LATE_OK = 6 * 3600_000;
const MAX_ACTIVE = 30;

export const readReminders = () => readJson(FILE, []);
const save = (list) => writeJson(FILE, list);
const p2 = (n) => String(n).padStart(2, '0');
const WEEK = '日一二三四五六';

/** 「2026-11-03 08:00」/「2026-11-03T08:00」→ 本地时间的毫秒；认不出来是 NaN */
export function parseWhen(s) {
  const m = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/.exec(String(s || '').trim());
  if (!m) return NaN;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  return d.getMonth() === +m[2] - 1 ? d.getTime() : NaN;
}

/** 给她看的现在时间（工具说明里用，好让她把「明早」「周五」算成具体日期） */
export function nowText(now = new Date()) {
  return `${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())} 周${WEEK[now.getDay()]} ${p2(now.getHours())}:${p2(now.getMinutes())}`;
}

export function whenText(at, repeat = 'none') {
  const d = new Date(at);
  const t = `${p2(d.getHours())}:${p2(d.getMinutes())}`;
  if (repeat === 'daily') return `每天 ${t}`;
  if (repeat === 'weekdays') return `工作日 ${t}`;
  if (repeat === 'weekly') return `每周${WEEK[d.getDay()]} ${t}`;
  return `${d.getMonth() + 1}月${d.getDate()}日 周${WEEK[d.getDay()]} ${t}`;
}

/** 下一次：重复的往后推，工作日跳过周末 */
export function nextAt(at, repeat) {
  const d = new Date(at);
  if (repeat === 'weekly') d.setDate(d.getDate() + 7);
  else d.setDate(d.getDate() + 1);
  if (repeat === 'weekdays') while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export function addReminder({ when, text, repeat = 'none', source = 'bot' }, now = Date.now()) {
  const at = parseWhen(when);
  const what = String(text || '').trim().slice(0, 120);
  if (!what) throw new Error('提醒什么呢？');
  if (!Number.isFinite(at)) throw new Error(`时间要写成 YYYY-MM-DD HH:mm，「${when}」认不出来`);
  const rep = REPEATS.includes(repeat) ? repeat : 'none';
  let first = at;
  if (first <= now) {
    if (rep === 'none') throw new Error(`${whenText(at)} 已经过去了`);
    while (first <= now) first = nextAt(first, rep);
  }
  const list = readReminders();
  if (list.filter((r) => !r.done).length >= MAX_ACTIVE) throw new Error(`提醒已经有 ${MAX_ACTIVE} 个了，先删掉几个`);
  const dup = list.find((r) => !r.done && r.at === first && r.text === what);
  if (dup) return { ...dup, existed: true };
  const r = { id: Math.random().toString(36).slice(2, 8), at: first, text: what, repeat: rep, createdAt: nowIso(), source };
  save([...list, r]);
  logAction({ kind: 'remind', source, target: r.id, detail: `⏰ 记了个提醒：${whenText(first, rep)} ${what}` });
  return r;
}

export function cancelReminder(id, source = 'bot') {
  const list = readReminders();
  const r = list.find((x) => !x.done && x.id === String(id || '').replace(/^#/, ''));
  if (!r) return null;
  r.done = 'cancelled';
  save(list);
  logAction({ kind: 'remind', source, target: r.id, detail: `⏰ 取消了提醒：${r.text}` });
  return r;
}

/** 还没到 / 还在重复的，按时间排 */
export const upcoming = () => readReminders().filter((r) => !r.done).sort((a, b) => a.at - b.at);

/**
 * 到点的拿出来（同时把它们挪到下一次 / 标成做完），返回 [{ ...r, late }]。
 * 晚太久的单次提醒算错过，不发；重复的跳到下一个还没过去的时间。
 */
export function takeDue(now = Date.now()) {
  const list = readReminders();
  const out = [];
  let changed = false;
  for (const r of list) {
    if (r.done || r.at > now) continue;
    changed = true;
    const late = now - r.at;
    if (late <= LATE_OK) out.push({ ...r, late });
    else logAction({ kind: 'remind', source: 'auto', ok: false, target: r.id, detail: `⏰ 错过了提醒（面板那会儿没开）：${r.text}` });
    if (r.repeat === 'none') { r.done = 'fired'; r.firedAt = nowIso(); continue; }
    let next = nextAt(r.at, r.repeat);
    while (next <= now) next = nextAt(next, r.repeat);
    r.at = next;
  }
  if (changed) save(list.filter((r) => !r.done || Date.parse(r.firedAt || r.createdAt) > now - 7 * 86400_000)); // 做完的留一周再清
  return out;
}

/** 给她看的清单 */
export function listText(list = upcoming()) {
  return list.map((r) => `#${r.id} ${whenText(r.at, r.repeat)} ${r.text}`).join('\n');
}

export { REPEAT_ZH };
