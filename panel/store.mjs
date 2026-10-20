/**
 * 本地持久化：动作日志 / 任务箱 / 待审队列 / 配置 / 运行状态
 *
 * 面板、自动养号和 task.mjs 共用这一份，全部是人能直接读的 JSON / JSONL。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const ROOT = join(here, '..');
export const DATA = join(here, 'data');
export const FILES = {
  actions: join(DATA, 'actions.jsonl'),
  tasks: join(DATA, 'tasks.jsonl'),
  review: join(DATA, 'review.jsonl'),
  config: join(DATA, 'autopilot.json'),
  state: join(DATA, 'state.json'),
  secrets: join(DATA, 'secrets.json'),
  diary: join(ROOT, 'diary', 'data', 'entries.jsonl'),
};

mkdirSync(DATA, { recursive: true });

// ─── 基础 ──────────────────────────────────────────────────
export function nowIso() { return new Date().toISOString(); }

/** 本地日期 YYYY-MM-DD（别用 toISOString().slice，那是 UTC，东八区早上 8 点前会算成前一天） */
export function localDate(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function readJsonl(file) {
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}
export function appendJsonl(file, obj) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(obj) + '\n', 'utf-8');
}
function readJson(file, fallback) {
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf-8')); } catch { return fallback; }
}
/** 先写临时文件再 rename，断电也不会留下半个 JSON */
function writeJson(file, obj, mode) {
  const tmp = file + '.tmp';
  writeFileSync(tmp, JSON.stringify(obj, null, 2), mode ? { mode } : undefined);
  renameSync(tmp, file);
}

// ─── 动作日志 ──────────────────────────────────────────────
// source: panel（你在面板点的）/ auto（自动养号）/ bot（QQ 机器人）
export function logAction({ kind, target, title, detail, ok = true, error, source = 'panel', meta }) {
  const a = {
    ts: nowIso(),
    kind,
    source,
    target: target || '',
    title: title || '',
    detail: detail || '',
    ok: !!ok,
    error: error || '',
  };
  if (meta) a.meta = meta;
  appendJsonl(FILES.actions, a);
  return a;
}

export function readActions() { return readJsonl(FILES.actions); }

/** 今天（本地时间）各类动作计数，用于每日上限。所有来源合并计算 —— 账号只有一个 */
export function todayCounts(date = localDate()) {
  const c = {};
  for (const a of readActions()) {
    if (!a.ok || localDate(new Date(a.ts)) !== date) continue;
    c[a.kind] = (c[a.kind] || 0) + 1;
  }
  return c;
}

// ─── 任务箱（同 id 以合并后的最后状态为准）────────────────
export function readTasks() {
  const map = new Map();
  for (const t of readJsonl(FILES.tasks)) map.set(t.id, { ...(map.get(t.id) || {}), ...t });
  return [...map.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}
export function addTask({ type, payload, note, source = 'panel' }) {
  const task = { id: crypto.randomUUID(), ts: nowIso(), type, payload: payload || {}, note: note || '', status: 'pending', source };
  appendJsonl(FILES.tasks, task);
  logAction({ kind: 'task', target: type, detail: note || JSON.stringify(payload || {}), source });
  return task;
}
export function updateTask(id, patch) { appendJsonl(FILES.tasks, { id, ...patch }); }

// ─── 待审队列：AI 起草的评论 / 日记，等你点头再发 ─────────
export function readReview() {
  const map = new Map();
  for (const r of readJsonl(FILES.review)) map.set(r.id, { ...(map.get(r.id) || {}), ...r });
  return [...map.values()].sort((a, b) => (a.ts < b.ts ? 1 : -1));
}
export function addReview({ kind, text, payload }) {
  const r = { id: crypto.randomUUID(), ts: nowIso(), kind, text, payload: payload || {}, status: 'pending' };
  appendJsonl(FILES.review, r);
  return r;
}
export function updateReview(id, patch) { appendJsonl(FILES.review, { id, ...patch, updatedAt: nowIso() }); }

// ─── 自动养号配置 ──────────────────────────────────────────
export const SHICHEN = [
  { key: '子', start: 23, end: 1, label: '子时 23–01' },
  { key: '丑', start: 1, end: 3, label: '丑时 01–03' },
  { key: '寅', start: 3, end: 5, label: '寅时 03–05' },
  { key: '卯', start: 5, end: 7, label: '卯时 05–07' },
  { key: '辰', start: 7, end: 9, label: '辰时 07–09' },
  { key: '巳', start: 9, end: 11, label: '巳时 09–11' },
  { key: '午', start: 11, end: 13, label: '午时 11–13' },
  { key: '未', start: 13, end: 15, label: '未时 13–15' },
  { key: '申', start: 15, end: 17, label: '申时 15–17' },
  { key: '酉', start: 17, end: 19, label: '酉时 17–19' },
  { key: '戌', start: 19, end: 21, label: '戌时 19–21' },
  { key: '亥', start: 21, end: 23, label: '亥时 21–23' },
];

export const DEFAULT_CONFIG = {
  enabled: false,
  // 在哪几个时辰里刷；每个时辰内随机挑一个时间点
  windows: ['辰', '午', '酉', '亥'],
  // 每个时辰「真的去刷」的概率 —— 真人不会每天准点打卡
  windowChance: 0.85,
  session: {
    videosMin: 2,
    videosMax: 5,
    // 看多少：时长的 45%~95%，单个视频最多看 maxWatchSec 秒
    watchRatioMin: 0.45,
    watchRatioMax: 0.95,
    maxWatchSec: 480,
    // 一部分视频看几秒就划走，真人都这样
    skipChance: 0.15,
    // 视频之间停多久（秒）
    gapMinSec: 6,
    gapMaxSec: 40,
    // 挑视频：首页推荐 / 兴趣搜索 / 热门 的比例
    sourceWeights: { feed: 6, interest: 3, hot: 1 },
    maxDurationSec: 1500,
  },
  interests: ['天文', '猫', '周易', '美食', '纪录片', '治愈'],
  like: { chance: 0.35, dailyMax: 15 },
  share: { daily: true },
  coin: { enabled: false, dailyMax: 1 },
  comment: {
    // off：不评论 / task：交给 QQ 里的她自己写 / llm：本地调模型起草
    mode: 'task',
    chance: 0.12,
    dailyMax: 3,
    // true：AI 起草的评论进「待审」，你点头才发
    review: true,
  },
  diary: {
    // off / task / llm
    mode: 'task',
    review: true,
    window: '亥',
  },
  llm: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
  },
  // 碰到风控码后歇多久（分钟）
  cooldownMin: 120,
};

function deepMerge(base, over) {
  if (Array.isArray(base) || typeof base !== 'object' || base === null) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over || {})) out[k] = deepMerge(base[k], over[k]);
  return out;
}

export function readConfig() {
  return deepMerge(DEFAULT_CONFIG, readJson(FILES.config, {}));
}
export function writeConfig(patch) {
  const next = deepMerge(readConfig(), patch);
  writeJson(FILES.config, next);
  return next;
}

// ─── 密钥（只存本地，不进 git，不回传给页面）──────────────
export function readSecrets() {
  const s = readJson(FILES.secrets, {});
  if (process.env.LLM_API_KEY) s.llmApiKey = process.env.LLM_API_KEY;
  return s;
}
export function writeSecrets(patch) {
  const next = { ...readJson(FILES.secrets, {}), ...patch };
  writeJson(FILES.secrets, next, 0o600);
}

// ─── 运行状态（今日计划、冷却、已看过的视频）──────────────
export function readState() {
  return readJson(FILES.state, { plans: {}, cooldownUntil: null, seen: {}, lastRun: null });
}
export function writeState(s) { writeJson(FILES.state, s); }
