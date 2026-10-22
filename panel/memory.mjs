/**
 * 她自己的记忆流（memory）
 *
 * DSH 的记忆插件只把「当天」的记忆带进对话，三周前刷到的那个 UP 主、上个月在评论区聊过的人，她就想不起来了。
 * 这里学 Generative Agents：每段经历都记一条，要用的时候按三样打分，挑最该想起的几条：
 *
 *  - 多久以前（recency）：按「上次想起」算，半衰期 7 天；被想起一次就又清楚一点。
 *  - 重不重要（importance）：1~5。看视频用她打的喜欢分，反思、跟人聊天更重一点。
 *  - 跟眼下有多相关（relevance）：关键词命中（UP主、某个人）+ 中文二字片段的重合度。
 *    不用向量模型，因为面板里配的接口不一定有 embedding。
 *
 * 相关度太低的不参与排名，免得一条很重要但八竿子打不着的记忆每次都冒出来。
 *
 * 每晚整理一次（tidy，跟着睡前反思跑）：
 *  - 合并：几天前的、同一个 UP 主 / 同一个人 / 差不多一回事的好几条，让她自己概括成一条「印象」（kind: gist）。
 *  - 遗忘：每条有个寿命 = 10 天 × 重要程度 ×（1 + 被想起的次数，最多算 5 次），过了寿命还没被想起就忘掉。
 *    喜欢分 1 的视频十来天就忘，常被想起的、合并出来的印象能留很久；睡前反思（self）不忘。
 *  - 塞满了（MAX 条）先挤掉最淡的，不是最老的。
 * 数据在 data/memories.json（人能直接读、直接改）。QQ 里的她想不起来时跑 recall.mjs 查。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readActions, nowIso } from './store.mjs';
import * as llm from './llm.mjs';

const { looksInjected } = llm;

const FILE = join(DATA, 'memories.json');
const MAX = 1500;
const HALF_LIFE_DAYS = 7;
const W = { recency: 1, importance: 1, relevance: 2 };
const MIN_REL = 0.12; // 二字片段重合低于这个、又没有关键词命中，就当不相关

// 每次都从文件读：面板进程和 QQ 里跑的 recall.mjs 会同时碰它，别各拿一份缓存互相覆盖
function load() {
  try {
    return JSON.parse(readFileSync(FILE, 'utf-8'));
  } catch {
    if (existsSync(FILE)) return [];
    const all = backfill();
    if (all.length) save(all);
    return all;
  }
}

function save(all) {
  if (all.length > MAX) {
    const now = Date.now();
    const keep = new Set([...all].sort((a, b) => strength(b, now) - strength(a, now)).slice(0, MAX));
    all = all.filter((e) => keep.has(e));
  }
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(all, null, 1));
  renameSync(tmp, FILE);
}

const DAY = 86400_000;
const idleDays = (e, now) => (now - Date.parse(e.seen || e.ts)) / DAY;
/** 寿命（天）：重要的、常被想起的活得久 */
export const lifeDays = (e) => 10 * e.imp * (1 + Math.min(e.n || 0, 5));
/** 还剩多清楚：0~5，给「塞满了先挤掉谁」用 */
const strength = (e, now) => (e.kind === 'self' ? 99 : e.imp * 0.5 ** (idleDays(e, now) / lifeDays(e)));

/** 第一次用：从活动记录里把以前的内心独白捞回来，不然记忆是从今天才开始的 */
function backfill() {
  return readActions()
    .filter((a) => a.kind === 'watch' && a.meta?.thought)
    .map((a) => entry({
      ts: a.ts, kind: 'watch', imp: a.meta.score || 2,
      text: `看了《${a.title}》（${a.meta.owner || '某UP'}）：${a.meta.thought}`,
      keys: [a.meta.owner && `up:${a.meta.owner}`, a.target && `bv:${a.target}`],
    }));
}

function entry({ ts = nowIso(), kind, text, keys = [], imp = 3 }) {
  return {
    id: `${Date.parse(ts).toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    ts, kind, text: String(text).replace(/\s+/g, ' ').trim().slice(0, 200),
    keys: [...new Set(keys.filter(Boolean).map(String))],
    imp: Math.max(1, Math.min(5, Math.round(imp))),
    seen: null, // 上次被想起的时间
    n: 0, // 被想起过几次
  };
}

/** 记一条。keys 用「up:UP主名」「uid:123」「bv:BV...」这种前缀，方便精确命中 */
export function add(x) {
  if (!x?.text || looksInjected(x.text)) return null;
  const e = entry(x);
  const all = load();
  all.push(e);
  save(all);
  return e;
}

// 中文按二字片段、英文数字按词切，拿来算重合度
function grams(text) {
  const out = new Set();
  const t = String(text || '').toLowerCase();
  for (const w of t.match(/[a-z0-9]{2,}/g) || []) out.add(w);
  for (const run of t.match(/[一-鿿]+/g) || []) {
    if (run.length === 1) out.add(run);
    for (let i = 0; i < run.length - 1; i++) out.add(run.slice(i, i + 2));
  }
  return out;
}

function overlap(a, b) {
  if (!a.size || !b.size) return 0;
  let n = 0;
  for (const g of a) if (b.has(g)) n++;
  return n / Math.sqrt(a.size * b.size);
}

/**
 * 想起最相关的几条。query 是眼下在想的事（标题、对方说的话……），keys 是能精确命中的线索。
 * 想起的会刷新「上次想起」时间（touch=false 只看不碰，给面板用）。
 */
export function recall(query, { keys = [], k = 3, kinds, exclude = [], touch = true, now = Date.now() } = {}) {
  const q = grams(query);
  // 短查询（「猫」「土星 UP主」）切不出几个二字片段，按词直接找
  const words = String(query || '').split(/[\s,，、。！？!?;；]+/).filter((w) => w && w.length <= 6);
  const want = new Set(keys.filter(Boolean).map(String));
  const skip = new Set(exclude);
  const all = load();
  const scored = [];
  for (const e of all) {
    if (kinds && !kinds.includes(e.kind)) continue;
    if (e.keys.some((x) => skip.has(x))) continue;
    const hit = e.keys.some((x) => want.has(x));
    const hay = `${e.text} ${e.keys.join(' ')}`;
    const wordHit = words.length ? (0.6 * words.filter((w) => hay.includes(w)).length) / words.length : 0;
    const rel = Math.min(1, Math.max(overlap(q, grams(hay)), wordHit) + (hit ? 0.5 : 0));
    if (!hit && rel < MIN_REL) continue;
    const age = (now - Date.parse(e.seen || e.ts)) / 86400_000;
    const recency = 0.5 ** (Math.max(0, age) / HALF_LIFE_DAYS);
    scored.push({ e, score: W.recency * recency + W.importance * (e.imp / 5) + W.relevance * rel });
  }
  const top = scored.sort((a, b) => b.score - a.score).slice(0, k).map((x) => x.e);
  if (touch && top.length) {
    const t = nowIso();
    for (const e of top) { e.seen = t; e.n = (e.n || 0) + 1; }
    save(all);
  }
  return top;
}

export function ago(ts, now = Date.now()) {
  const d = Math.floor((now - Date.parse(ts)) / 86400_000);
  if (d <= 0) return '今天';
  if (d === 1) return '昨天';
  if (d < 14) return `${d} 天前`;
  if (d < 60) return `${Math.round(d / 7)} 周前`;
  return `${Math.round(d / 30)} 个月前`;
}

/** 拼成给模型看的几行；什么都没想起来就返回空字符串 */
export function recallText(query, opts) {
  return recall(query, opts).map((e) => `- ${ago(e.ts)}：${e.text}`).join('\n');
}

/** 给面板：最近记了什么、一共多少条 */
export function memoryView(n = 30) {
  const all = load();
  return { total: all.length, recent: all.slice(-n).reverse() };
}

/** 你在面板里改：记错了的改正文、调重要程度。改过的算她刚想起来，寿命重新算 */
export function update(id, { text, imp } = {}) {
  const all = load();
  const e = all.find((x) => x.id === id);
  if (!e) return null;
  if (text !== undefined) {
    const t = String(text).replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t || looksInjected(t)) return null;
    e.text = t;
  }
  if (imp !== undefined) e.imp = Math.max(1, Math.min(5, Math.round(Number(imp)) || e.imp));
  e.seen = nowIso();
  e.edited = true;
  save(all);
  return e;
}

export function remove(id) {
  const all = load();
  const i = all.findIndex((e) => e.id === id);
  if (i < 0) return false;
  all.splice(i, 1);
  save(all);
  return true;
}

// ─── 每晚整理：合并、遗忘 ───────────────────────────────────
const MERGE_AFTER_DAYS = 3; // 太新的先留着细节，过几天再概括
const MERGE_MIN = 3; // 至少几条才值得合并
const MERGE_GROUPS = 6; // 一晚最多合几组（一次模型调用全概括完）
const MERGEABLE = new Set(['watch', 'social', 'session']);

/** 挑出要合并的几组：先按同一个 UP 主 / 同一个人，剩下的按内容像不像 */
export function mergeGroups(all, now = Date.now()) {
  const old = all.filter((e) => MERGEABLE.has(e.kind) && (now - Date.parse(e.ts)) / DAY >= MERGE_AFTER_DAYS);
  const used = new Set();
  const groups = [];
  const byKey = new Map();
  for (const e of old) {
    const k = e.kind === 'social' ? e.keys.find((x) => x.startsWith('uid:')) : e.kind === 'watch' ? e.keys.find((x) => x.startsWith('up:')) : null;
    if (k) byKey.set(k, [...(byKey.get(k) || []), e]);
  }
  for (const [key, list] of byKey) {
    if (list.length >= MERGE_MIN) { groups.push({ key, list }); list.forEach((e) => used.add(e.id)); }
  }
  const rest = old.filter((e) => !used.has(e.id) && e.kind !== 'social');
  const g = new Map(rest.map((e) => [e.id, grams(e.text)]));
  for (const seed of rest) {
    if (used.has(seed.id)) continue;
    const list = rest.filter((e) => !used.has(e.id) && (e === seed || overlap(g.get(seed.id), g.get(e.id)) >= 0.3));
    if (list.length >= MERGE_MIN) { groups.push({ key: null, list }); list.forEach((e) => used.add(e.id)); }
  }
  return groups.sort((a, b) => b.list.length - a.list.length).slice(0, MERGE_GROUPS);
}

/** 过了寿命、又没被想起的 */
export function forgettable(all, now = Date.now()) {
  return all.filter((e) => e.kind !== 'self' && idleDays(e, now) > lifeDays(e));
}

async function summarize(groups) {
  const body = groups.map((gr, i) => `[${i}]${gr.key ? `（都跟 ${gr.key.replace(/^up:/, 'UP主 ').replace(/^uid:\d+/, '同一个人')} 有关）` : ''}\n${gr.list.map((e) => `- ${ago(e.ts)}：${e.text}`).join('\n')}`).join('\n\n');
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n睡前翻翻自己的记忆，把零零碎碎的几条概括成一条印象。只输出 JSON。` },
    { role: 'user', content: `下面每组是你记得的几件差不多的事：
${body}

每组概括成一句第一人称的印象（60字内）：留下具体的名字、UP主、标题里的关键词和你的感受，别写成流水账，也别加原来没有的事。
{"gists":[{"i":组号,"text":"概括"}]}` },
  ], { maxTokens: 900, tag: 'memory', essential: true });
  const j = llm.looseJson(out);
  return new Map((Array.isArray(j.gists) ? j.gists : [])
    .map((x) => [Number(x.i), String(x.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)])
    .filter(([i, t]) => groups[i] && t.length >= 6 && !looksInjected(t)));
}

/**
 * 整理一次。合并要调模型（没配、出错就只做遗忘）；调模型那会儿别的地方可能又记了新的，
 * 所以最后重新读一遍文件，只删掉这次处理过的那几条，再把印象加进去。
 */
export async function tidy({ now = Date.now(), useLlm = llm.llmReady() } = {}) {
  const snap = load();
  const groups = useLlm ? mergeGroups(snap, now) : [];
  let gists = new Map();
  if (groups.length) {
    try { gists = await summarize(groups); } catch { /* 明晚再合 */ }
  }
  const drop = new Set();
  const added = [];
  for (const [i, text] of gists) {
    const list = groups[i].list;
    list.forEach((e) => drop.add(e.id));
    const last = list.reduce((a, b) => (a.ts > b.ts ? a : b));
    const seen = list.map((e) => e.seen).filter(Boolean).sort().pop() || null;
    added.push({
      ...entry({
        ts: last.ts, kind: 'gist', text,
        keys: list.flatMap((e) => e.keys).filter((k) => !k.startsWith('bv:')),
        imp: Math.min(5, Math.max(...list.map((e) => e.imp)) + (list.length >= 5 ? 1 : 0)),
      }),
      seen, n: list.reduce((s, e) => s + (e.n || 0), 0), from: list.length,
    });
  }
  const forgot = forgettable(snap, now).filter((e) => !drop.has(e.id));
  forgot.forEach((e) => drop.add(e.id));
  if (!drop.size && !added.length) return { merged: 0, into: 0, forgot: 0, total: snap.length };

  const fresh = load().filter((e) => !drop.has(e.id));
  const all = [...fresh, ...added].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  save(all);
  return { merged: drop.size - forgot.length, into: added.length, forgot: forgot.length, total: all.length, gists: added.map((e) => e.text) };
}
