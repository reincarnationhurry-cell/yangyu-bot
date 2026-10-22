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
 * 数据在 data/memories.json（人能直接读、直接改）。QQ 里的她想不起来时跑 recall.mjs 查。
 */
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, readActions, nowIso } from './store.mjs';
import { looksInjected } from './llm.mjs';

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
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(all.slice(-MAX), null, 1));
  renameSync(tmp, FILE);
}

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
    for (const e of top) e.seen = t;
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

export function remove(id) {
  const all = load();
  const i = all.findIndex((e) => e.id === id);
  if (i < 0) return false;
  all.splice(i, 1);
  save(all);
  return true;
}
