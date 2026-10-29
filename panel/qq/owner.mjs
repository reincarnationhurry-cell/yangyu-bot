/**
 * 关于号主的事 + 跟号主的聊天记录
 *
 * 以前这些全靠 DSH 的记忆插件。换成小号以后面板自己当大脑，所以自己记：
 *
 *  - 号主的事（data/owner.json）：称呼、偏好、计划、口头禅、近况这类「三个月后大概还成立」的事，
 *    一条一句话。每次聊天都整份带上（够短）；她聊着聊着用 remember 工具记，每晚再从当天聊天里补一遍。
 *    记错了号主一纠正就改。
 *  - 聊天记录（data/qq-chat.jsonl）：她和号主说过的每句话（含她主动说的、后台汇报），给下一轮当上下文。
 *  - 从 DSH 带过来（importDsh）：一次性把 DSH 记忆里关于号主的事提炼进来，只读，不动 DSH 的文件；
 *    开发排查、工程笔记这类不是号主的事，不带。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { DATA, ROOT, nowIso, localDate, readJsonl, appendJsonl, logAction } from '../store.mjs';
import * as llm from '../llm.mjs';

const FACTS = join(DATA, 'owner.json');
export const CHAT = join(DATA, 'qq-chat.jsonl');
export const KINDS = ['称呼', '身份', '偏好', '作息', '计划', '口头禅', '近况', '规矩', '其他'];
const MAX_FACTS = 80;

// ─── 号主的事 ──────────────────────────────────────────────
export function readFacts() {
  try { return JSON.parse(readFileSync(FACTS, 'utf-8')).facts || []; } catch { return []; }
}
function writeFacts(facts) {
  const tmp = FACTS + '.tmp';
  writeFileSync(tmp, JSON.stringify({ facts: facts.slice(-MAX_FACTS) }, null, 2));
  renameSync(tmp, FACTS);
}
const norm = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 120);
const shortId = () => crypto.randomUUID().slice(0, 6);

/** 记一条；差不多的已经有了就不重复记（同一类、字面上大半一样） */
export function addFact({ text, kind = '其他', source = 'chat' }) {
  const t = norm(text);
  if (t.length < 3 || llm.looksInjected(t)) return null;
  const facts = readFacts();
  const k = KINDS.includes(kind) ? kind : '其他';
  const dup = facts.find((f) => f.text === t || (f.kind === k && overlap(f.text, t) > 0.8));
  if (dup) return { ...dup, existed: true };
  const f = { id: shortId(), kind: k, text: t, at: localDate(), source };
  writeFacts([...facts, f]);
  return f;
}

export function updateFact(id, text) {
  const facts = readFacts();
  const f = facts.find((x) => x.id === String(id).replace(/^#/, ''));
  if (!f) return null;
  if (!norm(text)) { writeFacts(facts.filter((x) => x !== f)); return { ...f, removed: true }; }
  f.text = norm(text);
  f.at = localDate();
  writeFacts(facts);
  return f;
}

export function removeFact(id) { return updateFact(id, ''); }

/** 两句话字面上有多像（两字片段的重合比例） */
export function overlap(a, b) {
  const grams = (s) => { const g = new Set(); for (let i = 0; i < s.length - 1; i++) g.add(s.slice(i, i + 2)); return g; };
  const A = grams(String(a)); const B = grams(String(b));
  if (!A.size || !B.size) return 0;
  let n = 0;
  for (const x of A) if (B.has(x)) n++;
  return n / Math.min(A.size, B.size);
}

export function factsText(facts = readFacts()) {
  if (!facts.length) return '（还不太了解他，聊着聊着记）';
  return facts.map((f) => `- #${f.id}［${f.kind}］${f.text}`).join('\n');
}

// ─── 聊天记录 ──────────────────────────────────────────────
// from: owner / her；kind: text（默认）/ sticker / voice / proactive（她主动找的）/ report（后台汇报）/ notice（提醒）
export function logChat({ from, text, kind }) {
  const e = { ts: nowIso(), from, text: String(text || '').slice(0, 2000) };
  if (kind && kind !== 'text') e.kind = kind;
  appendJsonl(CHAT, e);
  return e;
}

export function readChat() { return readJsonl(CHAT); }

/** 最近的对话（/new 之后的、3 天内的、最多 n 条） */
export function recentChat(n = 24, now = Date.now()) {
  const all = readChat();
  const cut = now - 3 * 86400_000;
  let start = 0;
  for (let i = all.length - 1; i >= 0; i--) if (all[i].kind === 'reset') { start = i + 1; break; }
  return all.slice(start).filter((e) => e.kind !== 'reset' && Date.parse(e.ts) >= cut).slice(-n);
}

export function lastFrom(who) {
  const all = readChat();
  for (let i = all.length - 1; i >= 0; i--) if (all[i].from === who && all[i].kind !== 'reset') return all[i];
  return null;
}

export function resetContext() { appendJsonl(CHAT, { ts: nowIso(), from: 'owner', kind: 'reset', text: '' }); }

// ─── 每晚：从今天的聊天里补记 ───────────────────────────────
export async function digestToday({ today = localDate(), remember } = {}) {
  const lines = readChat().filter((e) => e.kind !== 'reset' && localDate(new Date(e.ts)) === today)
    .map((e) => `${e.from === 'owner' ? '他' : '我'}：${e.text}`);
  if (lines.length < 2) return null;
  const out = await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n整理一下今天跟号主（最熟的那个人）聊了什么。只输出 JSON。` },
    { role: 'user', content: `已经记着的他的事：\n${factsText()}\n\n今天的聊天：\n${lines.slice(-80).join('\n').slice(-6000)}

输出：
{"facts":[{"kind":"${KINDS.join('/')}","text":"关于他的、以后还用得上的事，一句话，第三人称（比如「他在做国学视频」）"}],
"fix":[{"id":"上面已记着的某条的 id（不带#）","text":"改成什么；这条不对了就空字符串"}],
"memory":"第一人称一两句：今天跟他聊了什么、我什么感觉（60字内）",
"feel":今天聊天心里起伏多大，0平平常常到3特别（吵架了、被他感动了、一起笑疯了）}
只记新的、确实成立的；随口的玩笑、一次性的闲聊、密码身份证银行卡这类不记。没有就给空数组。` },
  ], { maxTokens: 700, tag: 'qq', essential: true });
  const j = llm.looseJson(out);
  const added = (Array.isArray(j.facts) ? j.facts : []).map((f) => addFact({ text: f.text, kind: f.kind, source: 'nightly' })).filter((f) => f && !f.existed);
  for (const x of Array.isArray(j.fix) ? j.fix : []) if (x?.id) updateFact(x.id, x.text);
  const memo = norm(j.memory);
  if (memo && remember) remember(memo, (Number(j.feel) || 0) / 3);
  return { added: added.length, memory: memo };
}

// ─── 从 DSH 带过来 ─────────────────────────────────────────
const DSH_MEM = join(homedir(), '.dsh', 'memory');
const DSH_WS = join(DSH_MEM, 'workspaces', `--${ROOT.replace(/\//g, '-')}--`);
// 一看就是工程排查的行：不是号主的事
const DEV = /(根因|插件|npm|peerDep|gateway|网关|\.json|\.mjs|\.md\b|~\/|\/Users\/|launchd|commit|报错|排查|升级到|rc\.\d|DSH|cookie|SESSDATA|配置文件|bilibili-mcp)/i;

/** 读 DSH 里能找到的记忆原文（只读），去掉明显的工程笔记 */
export function dshSources({ days = 14 } = {}) {
  const parts = [];
  const read = (f) => { try { return readFileSync(f, 'utf-8'); } catch { return ''; } };
  const push = (label, text) => {
    const keep = text.split('\n').filter((l) => l.trim() && !DEV.test(l)).join('\n').trim();
    if (keep) parts.push(`【${label}】\n${keep}`);
  };
  push('全局记忆', read(join(DSH_MEM, 'MEMORY.md')));
  if (existsSync(DSH_WS)) {
    push('这个工作区的记忆', read(join(DSH_WS, 'MEMORY.md')));
    const daily = readdirSync(DSH_WS).filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f)).sort().slice(-days);
    for (const f of daily) push(`日志 ${f.slice(0, 10)}`, read(join(DSH_WS, f)));
    const refl = join(DSH_WS, 'reflections');
    if (existsSync(refl)) for (const f of readdirSync(refl).filter((x) => x.endsWith('.md')).sort().slice(-days)) push(`反思 ${f.slice(0, 10)}`, read(join(refl, f)));
  }
  return parts;
}

export async function importDsh() {
  const parts = dshSources();
  if (!parts.length) return { added: 0, why: '没找到 DSH 的记忆文件' };
  // 太长就分几段让模型看（每段 ~6000 字）
  const chunks = [];
  let cur = '';
  for (const p of parts) {
    if ((cur + p).length > 6000 && cur) { chunks.push(cur); cur = ''; }
    cur += `${p.slice(0, 6000)}\n\n`;
  }
  if (cur) chunks.push(cur);
  let added = 0;
  for (const c of chunks) {
    const out = await llm.chat([
      { role: 'system', content: '你在帮「蓝色大肥鱼」（一个 AI 伙伴）整理她对号主（她最熟的那个人）的了解。只输出 JSON。' },
      { role: 'user', content: `下面是以前的记忆笔记，里面混着号主的事、她自己刷 B站 的经历、还有一些工程笔记。
只挑**关于号主本人**、以后聊天还用得上的事（称呼、身份、在做什么、偏好、作息、计划、口头禅、近况、他定的规矩），每条一句话、第三人称。
她自己刷 B站 的经历、工程/排查/配置的东西、密码身份证这类都不要。

${c}

输出：{"facts":[{"kind":"${KINDS.join('/')}","text":"……"}]}` },
    ], { maxTokens: 1500, tag: 'qq', essential: true, temperature: 0.3 });
    const j = llm.looseJson(out);
    for (const f of Array.isArray(j.facts) ? j.facts : []) { const r = addFact({ text: f.text, kind: f.kind, source: 'dsh' }); if (r && !r.existed) added++; }
  }
  logAction({ kind: 'qq', source: 'panel', detail: `从 DSH 的记忆里带过来 ${added} 条关于你的事` });
  return { added, total: readFacts().length };
}
