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
// 测试时用 YANGYU_DATA 指到临时目录，别碰真数据
export const DATA = process.env.YANGYU_DATA || join(here, 'data');
export const FILES = {
  actions: join(DATA, 'actions.jsonl'),
  tasks: join(DATA, 'tasks.jsonl'),
  review: join(DATA, 'review.jsonl'),
  config: join(DATA, 'autopilot.json'),
  state: join(DATA, 'state.json'),
  secrets: join(DATA, 'secrets.json'),
  blocks: join(DATA, 'blocks.json'),
  vip: join(DATA, 'vip.json'),
  pause: join(DATA, 'pause.json'),
  sky: join(DATA, 'sky.json'),
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
// executor：panel = 面板自己马上去做；bot = 进任务箱，等 QQ 里的她来认领
// report：'qq' = 做完让她在 QQ 里跟号主汇报（QQ 里的她交给后台的活）
export function addTask({ type, payload, note, source = 'panel', executor = 'bot', report }) {
  const task = { id: crypto.randomUUID(), ts: nowIso(), type, payload: payload || {}, note: note || '', status: 'pending', source, executor };
  if (report) task.report = report;
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
  // 她的内心（mind.mjs，需要配模型）：刷之前想想今天想看什么、每个视频留一句内心独白、
  // 顺着喜欢的往下挖、刷完更新心情和兴趣、见闻写进 DSH 记忆、每晚反思一次
  mind: {
    enabled: true,
    digMax: 2, // 一轮最多顺藤摸瓜几次
    memory: true, // 见闻和反思写进 DSH 的工作区记忆，QQ 里的她就知道自己刷了什么
    impulse: true, // 刷到特别想分享的，号主一小时内说过话就主动发一句（每天最多 1 次）
    reflectHour: 22, // 几点以后做当天的反思
    subtitles: true, // 认真看了的视频读一下字幕（CC 或 B站 AI 字幕），独白照着她真看到的内容说
  },
  // 她的窗（sky.mjs）：此刻真的天 —— 日照、月相、天气，喂给她的内心。place 填城市名，保存时查成经纬度
  sky: { enabled: true, place: '', label: '', lat: null, lon: null },
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
  // 她的社交（social.mjs，需要配模型）：看视频时偶尔去热评下面接一句；有人回她，自己决定回不回
  // 发不发先审跟着上面 comment.review 走；发出去的都过评论的保险丝
  social: {
    enabled: true,
    join: true, // 看完视频，翻评论区时想接话就接
    joinChance: 0.3, // 看完（没划走）之后有多大可能去评论区搭话；喜欢的视频会更高
    joinDailyMax: 3,
    reply: true, // 有人回她 / @她，自己决定回不回
    replyDailyMax: 10,
    checkMin: 40, // 多久看一眼「回复我的」（会随机抖动；刷完一轮也会顺手看一眼）
    threadMax: 4, // 同一串楼里她最多回几次，聊太久就收住
    likeChance: 0.5, // 顺手给对方的评论点个赞
    quietStart: 1, // 深夜不回（从几点）
    quietEnd: 8,
  },
  diary: {
    // off / task / llm
    mode: 'task',
    review: true,
    hour: 22, // 每晚几点以后写（今晚还有没刷完的时辰就等它刷完）
  },
  llm: {
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    // 每天后台自己动脑子（内心、社交、自动评论）的上限，0 = 不限；你点的、你派的活不算在里面
    dailyCalls: 300,
    dailyTokens: 600000,
  },
  // 特别关注：TA 发了新视频/动态，就优先去看，并点赞、收藏、（能投就投币）、评论
  vip: {
    enabled: true,
    users: [], // [{ uid, name, face }]
    checkMin: 20, // 多久看一眼关注动态（会随机抖动）
    maxAgeHours: 72, // 只追最近这么久发的
    dailyMax: 6, // 一天最多追几个视频
    asap: true, // 有新视频就尽快去看；false 则等下一个时辰顺路看
    quietStart: 1, // 尽快模式也不在这段时间里跑（点）
    quietEnd: 8,
    maxWatchSec: 1200,
    like: true,
    favorite: true,
    coin: true, // 仍受「投币」总开关和投币锁约束
    comment: true, // 按「评论」的方式（交给她 / AI 起草）来，计入每日上限
    likeDynamic: true, // 图文/文字动态顺手点个赞
  },
  // QQ 怎么接：official = DSH + dsh-im-connect 插件 + QQ 官方机器人（只能在你说话后一小时内回）；
  // onebot = 她自己的 QQ 小号（本机 NapCat），面板自己当大脑，能主动找你。token 在 secrets.json
  // telegram = 号主在 @BotFather 建的 bot（官方接口，不会被封），跟小号一样面板当大脑。token 在 secrets.json 的 telegramToken
  // （这一段还叫 qq：聊天、主动找你、语音这些设置两条线共用）
  qq: {
    mode: 'official',
    wsUrl: 'ws://127.0.0.1:3001', // NapCat 的 OneBot v11 正向 WebSocket
    ownerQQ: '', // 你的 QQ 号：她只跟你说话，别人私聊不理
    tg: { ownerId: '', ownerName: '' }, // Telegram 上的号主：第一个私聊 bot 的人，面板上能解绑
    model: '', // 聊天用的模型，空 = 跟上面「模型」一样
    reachOut: true, // 白天隔了很久没听到你说话，她会自己想想要不要找你
    reachOutMax: 2, // 一天最多主动找几次
    silentHours: 4, // 你多久没说话才算「隔了很久」
    activeStart: 9, // 只在这段时间里主动找（点）
    activeEnd: 22,
    voiceChance: 0.15, // 平时回你的话，有多大概率直接用语音说（太长、带链接的不会）
    // 外挂（qq/dsh.mjs）：查资料交给她专用的 DSH 配置，看图、做表情包走 DSH 本地网关里的模型
    dsh: {
      enabled: true,
      profile: 'yangyu', // ~/.dsh/profiles/yangyu：只留联网搜索，其他工具都关掉
      visionModel: 'openai-codex/gpt-5.6-luna', // 能看图的模型
      imageModel: 'Qwen/Qwen-Image-Edit', // ModelScope 上的改图模型（拿现有表情当底图改表情），令牌在 secrets.json 的 modelscopeToken
    },
  },
  // 有东西要你审时，让她在 QQ 里主动叫你（QQ 官方机器人的单聊主动消息，平台有限额）
  notify: {
    enabled: false,
    source: 'dsh', // dsh：用 DSH 里接的那个 QQ 机器人 / manual：面板里手填
    dailyMax: 3,
    quietStart: 23,
    quietEnd: 8,
    kinds: { diary: true, comment: true, reply: true },
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

// ─── 号主叫停 ──────────────────────────────────────────────
// 号主在 QQ 里说「我打游戏了」「开会呢别吵」，她就把手上的活停了 —— 不是降优先级，是停：
// 不去刷、不看回复、不主动找他。他说「好了」才恢复；没说就照常，不用自作聪明一直让路。
// 忘了说也最多停 PAUSE_MAX_HOURS，免得她一直干坐着。号主亲口派的活不受影响。
export const PAUSE_MAX_HOURS = 24;
export function readPause(now = Date.now()) {
  const p = readJson(FILES.pause, null);
  return p?.until > now ? p : null;
}
export function setPause({ reason = '', hours, source = 'bot' } = {}, now = Date.now()) {
  const h = Number(hours) > 0 ? Math.min(Number(hours), PAUSE_MAX_HOURS) : 0;
  const p = { at: new Date(now).toISOString(), until: now + (h || PAUSE_MAX_HOURS) * 3600_000, reason: String(reason).trim().slice(0, 40), untilResume: !h };
  writeJson(FILES.pause, p);
  logAction({ kind: 'pause', source, detail: `⏸ 号主${p.reason ? `「${p.reason}」` : '叫停了'}，手上的活先停${h ? ` ${h} 小时` : '，等他说好了再动'}` });
  return p;
}
export function clearPause({ source = 'bot' } = {}) {
  const p = readPause();
  writeJson(FILES.pause, {});
  if (p) logAction({ kind: 'pause', source, detail: '▶️ 号主说好了，接着过自己的日子' });
  return p;
}

// ─── 动作熔断 ──────────────────────────────────────────────
// 点赞、分享、收藏这类写接口一旦被 B站 拒绝（比如 -403「账号异常」），
// 就先别碰这个动作：第一次停 24 小时，连着再被拒就停 3 天、7 天。
// 失败越多越像异常账号 —— 跟投币锁一个道理，只是不永久。
export const ACTION_NAMES = {
  like: '点赞', share: '分享', favorite: '收藏', dyn_like: '动态点赞', comment: '评论', follow: '关注', reply_like: '评论点赞',
};
export function readBlocks() {
  const all = readJson(FILES.blocks, {});
  const now = Date.now();
  return Object.fromEntries(Object.entries(all).filter(([, b]) => b.until > now));
}
export function blockedFor(kind) {
  return readBlocks()[kind] || null;
}
export function addBlock(kind, { code, error }) {
  const all = readJson(FILES.blocks, {});
  const prev = all[kind];
  // 上次熔断结束后 48 小时内又被拒，算「连着」
  const strikes = prev && Date.now() - prev.until < 48 * 3600_000 ? (prev.strikes || 1) + 1 : 1;
  const hours = [24, 72, 168][Math.min(strikes, 3) - 1];
  all[kind] = { at: nowIso(), until: Date.now() + hours * 3600_000, code: code ?? null, error: error || '', strikes };
  writeJson(FILES.blocks, all);
  return all[kind];
}
/** 手动触发的写动作（面板按钮、act.mjs）也过同一根保险丝 */
export async function withBlock(kind, fn) {
  const name = ACTION_NAMES[kind] || kind;
  const b = blockedFor(kind);
  if (b) {
    const until = new Date(b.until).toLocaleString('zh-CN', { hour12: false });
    throw new Error(`${name}暂停中（到 ${until}），上次 B站 回的是「${b.error}」。真想试，先去「自动养号」页点「恢复」`);
  }
  try {
    return await fn();
  } catch (e) {
    // 只有 B站 明确拒绝（带错误码）才熔断，网络抖动不算
    if (e?.constructor?.name === 'BiliError') addBlock(kind, { code: e.code, error: e.message });
    throw e;
  }
}
// ─── 「想点没点成」清单 ────────────────────────────────────
// 点赞 / 分享 / 投币被 B站 拦着时，她想点的视频记在这里，你在面板开「她的浏览器」（browser.mjs）顺手点掉。
// 真浏览器里的点击 B站 是认的（投币就是这么验证的）。
const WISH_FILE = join(DATA, 'wishes.json');
export function readWishes() {
  const all = readJson(WISH_FILE, []);
  const cut = Date.now() - 3 * 86400_000; // 三天前的就算了
  return all.filter((w) => !w.done && Date.parse(w.ts) >= cut);
}
export function addWish({ kind, bvid, title, owner }) {
  if (!bvid) return;
  const all = readJson(WISH_FILE, []).filter((w) => Date.parse(w.ts) >= Date.now() - 7 * 86400_000);
  if (all.some((w) => w.bvid === bvid && w.kind === kind && !w.done)) return;
  all.push({ id: crypto.randomUUID(), ts: nowIso(), kind, bvid, title: title || '', owner: owner || '', done: false });
  writeJson(WISH_FILE, all.slice(-60));
}
export function finishWish(id) {
  const all = readJson(WISH_FILE, []);
  for (const w of all) if (w.id === id || id === '*') w.done = true;
  writeJson(WISH_FILE, all);
}
export function clearBlock(kind) {
  const all = readJson(FILES.blocks, {});
  if (all[kind]) { all[kind].until = 0; writeJson(FILES.blocks, all); }
}

// ─── 特别关注的运行状态（队列、已处理的动态）────────────────
export function readVip() {
  return readJson(FILES.vip, { lastCheck: 0, nextCheck: 0, runAt: null, queue: [], handled: {}, done: {} });
}
export function writeVip(v) { writeJson(FILES.vip, v); }
