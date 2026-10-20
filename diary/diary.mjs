#!/usr/bin/env node
/**
 * 养鱼日记（B站浏览记录 + 自动发动态）
 *
 * 用途：记录「蓝色大肥鱼」在 B站刷了什么、看了什么、有什么想法，
 *      并在晚上把当天日记合成一条 B站动态发出去。
 *
 * 设计要点：
 *  - 记忆只记「她自己的B站见闻」，不记与号主的私人对话/工作内容（这是硬约束）。
 *  - 数据落地在工作区，纯 JSONL + Markdown，人可直接读。
 *  - 发动态需要 B站 cookie（bilibili-mcp/login/cookie.json），未登录就只记录不发。
 *
 * 用法：
 *   node diary.mjs add --type search --keyword "周易" --summary "搜了什么、看到啥"
 *   node diary.mjs add --type watch  --bvid BV1xx  --title "标题" --thought "感想"
 *   node diary.mjs add --type like   --bvid BV1xx  --title "标题"
 *   node diary.mjs add --type comment --bvid BV1xx --title "标题" --text "我发的评论"
 *   node diary.mjs today                 # 看今天记了什么
 *   node diary.mjs compose               # 只生成动态文案，不发布（预览）
 *   node diary.mjs publish               # 生成并发布到 B站动态
 *   node diary.mjs publish --dry-run     # 同上但不真的发
 *   node diary.mjs stats                 # 最近 7 天概览
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(here, 'data');
const ENTRIES = join(DATA_DIR, 'entries.jsonl');
// cookie 由 bilibili-mcp 扫码登录写入，位置在 ../bilibili-mcp/login/cookie.json
const COOKIE_FILE = process.env.BILIBILI_COOKIE_FILE
  || join(here, '..', 'bilibili-mcp', 'login', 'cookie.json');

// ─── 小工具 ────────────────────────────────────────────────
function ts(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
function nowIso() { return new Date().toISOString(); }
function ensureDir() { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); }

function parseArgs(argv) {
  const [cmd, ...rest] = argv;
  const flags = {};
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = rest[i + 1];
      if (next === undefined || next.startsWith('--')) flags[key] = true;
      else { flags[key] = next; i++; }
    }
  }
  return { cmd, flags };
}

function readEntries() {
  if (!existsSync(ENTRIES)) return [];
  return readFileSync(ENTRIES, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

const TYPE_LABEL = {
  search: '搜了',
  watch: '看了',
  like: '点了赞',
  comment: '评论了',
  danmaku: '发了弹幕',
  hot: '逛了热门',
  thought: '碎碎念',
  draft: '日记正文',
};

// ─── add：记一条 ───────────────────────────────────────────
function cmdAdd(flags) {
  ensureDir();
  const type = flags.type;
  if (!type || !TYPE_LABEL[type]) {
    console.error(`✗ --type 必须是：${Object.keys(TYPE_LABEL).join(' / ')}`);
    process.exit(1);
  }
  const entry = {
    ts: nowIso(),
    date: ts(),
    type,
    bvid: flags.bvid || null,
    title: flags.title || null,
    keyword: flags.keyword || null,
    summary: flags.summary || null,
    thought: flags.thought || null,
    text: flags.text || null,
  };
  // 至少要有内容，避免空记录
  if (!entry.title && !entry.keyword && !entry.summary && !entry.thought && !entry.text) {
    console.error('✗ 什么都没有记（至少给 --title / --keyword / --summary / --thought / --text 之一）');
    process.exit(1);
  }
  appendFileSync(ENTRIES, JSON.stringify(entry) + '\n', 'utf-8');
  console.log(`✓ 已记一条 [${TYPE_LABEL[type]}] ${entry.title || entry.keyword || entry.summary || entry.text}`);
}

// ─── today：看今天 ─────────────────────────────────────────
function cmdToday() {
  const today = ts();
  const list = readEntries().filter((e) => e.date === today);
  if (list.length === 0) {
    console.log(`今天（${today}）还没记什么。`);
    return;
  }
  console.log(`📅 ${today} 共 ${list.length} 条：\n`);
  for (const e of list) {
    const t = new Date(e.ts).toTimeString().slice(0, 5);
    const head = `${t} [${TYPE_LABEL[e.type]}]`;
    const body = e.title || e.keyword || e.summary || e.text || '';
    console.log(`${head} ${body}`);
    if (e.thought) console.log(`      💭 ${e.thought}`);
    if (e.text && e.text !== body) console.log(`      ✍️ ${e.text}`);
  }
}

// ─── write：直接写整篇日记（推荐） ────────────────────────
// 这是最自然的方式：想说什么就说什么，不用套分类字段。
// 写的内容就是最终要发出去的正文，不再经过任何模板加工。
function cmdWrite(args) {
  ensureDir();
  const text = args.join(' ').trim();
  if (!text) {
    console.error('✗ 没内容。用法：node diary.mjs write "今天刷到什么、想说什么"');
    process.exit(1);
  }
  const entry = {
    ts: nowIso(),
    date: ts(),
    type: 'draft',
    draft: text,
  };
  appendFileSync(ENTRIES, JSON.stringify(entry) + '\n', 'utf-8');
  console.log(`✓ 已写下今天的日记（${text.length} 字）`);
  console.log('  再跑 node diary.mjs publish 就能发出去。');
}

// ─── compose：取今天要发的正文 ─────────────────────────────
// 设计立场：**正文由她自己写完**，代码不做模板拼装。
// 早期版本按 type 字段拼「今天翻了X / 看完了:Y / 顺手点了N个赞」，
// 结果是每条日记长得一样，像填表，不像人话。已废弃。
//
// 现在只做两件事：
//   1. 如果她写过 draft（--type draft），用她的原文
//   2. 否则把当天她记的碎片（thought/text）按时间顺序接起来做兜底
function cmdCompose(flags) {
  const day = flags.date || ts();
  const list = readEntries().filter((e) => e.date === day && e.type !== 'published');
  if (list.length === 0) {
    console.error(`✗ ${day} 没有记录。先写点什么：`);
    console.error(`  node diary.mjs write "今天刷到一个视频，讲的是……"`
    );
    console.error(`  或 node diary.mjs add --type thought --thought "……"`);
    process.exit(1);
  }

  // 1) 优先用她自己写好的整篇 draft
  const drafts = list.filter((e) => e.type === 'draft' && e.draft);
  if (drafts.length > 0) {
    return drafts[drafts.length - 1].draft.trim();
  }

  // 2) 兜底：把她记的碎片按顺序接起来（不再加任何固定句式）
  const pieces = [];
  for (const e of list) {
    const t = e.thought || e.text || e.draft;
    if (t && !pieces.includes(t)) pieces.push(t.trim());
  }
  if (pieces.length === 0) {
    console.error(`✗ ${day} 记的都是动作（点赞/观看之类），没有可当正文的文字。`);
    console.error('  用 write 或 add --type thought 补一句真实的感想再发。');
    process.exit(1);
  }
  return pieces.join('\n\n');
}

// ─── publish：发到 B站动态 ────────────────────────────────
async function cmdPublish(flags) {
  const day = flags.date || ts();

  // [防重复] 同一天已经发过就别再发，除非显式 --force
  const all = readEntries();
  const already = all.find((e) => e.type === 'published' && e.date === day);
  if (already && !flags.force) {
    console.error(`✗ ${day} 的养鱼日记已经发过了（动态 ${already.dynId}）。`);
    console.error('  确实要再发一条，加 --force。');
    process.exit(2);
  }

  const text = cmdCompose(flags);
  console.log('───── 动态内容预览 ─────');
  console.log(text);
  console.log('────────────────────────');

  if (flags['dry-run']) {
    console.log('\n(dry-run：没有真的发布)');
    return;
  }

  if (!existsSync(COOKIE_FILE)) {
    console.error('\n✗ 没有登录凭证，无法发布。先扫码登录 B站。');
    process.exit(1);
  }
  const ck = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));
  if (!ck.sessdata || !ck.bili_jct) {
    console.error('\n✗ cookie 不完整（缺 sessdata 或 bili_jct）。');
    process.exit(1);
  }

  // B站动态接口：正文必须是 application/json，csrf 放 URL 参数
  const payload = {
    dyn_req: {
      content: { contents: [{ raw_text: text, type: 1, biz_id: '' }] },
      meta: { app_meta: { from: 'create.dynamic.web', mobi_app: 'web' } },
      scene: 1,
    },
  };

  const url = `https://api.bilibili.com/x/dynamic/feed/create/dyn?csrf=${encodeURIComponent(ck.bili_jct)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Referer: 'https://t.bilibili.com/',
      Origin: 'https://t.bilibili.com',
      'Content-Type': 'application/json',
      Cookie: `SESSDATA=${ck.sessdata}; bili_jct=${ck.bili_jct}`,
    },
    body: JSON.stringify(payload),
  });
  const json = await res.json().catch(() => ({}));

  if (json.code === 0) {
    const dynId = json.data?.dyn_id_str || json.data?.dyn_id;
    console.log(`\n✅ 已发布到B站动态：https://t.bilibili.com/${dynId}`);
    // 记一笔"已发布"，避免重复发
    ensureDir();
    appendFileSync(
      ENTRIES,
      JSON.stringify({ ts: nowIso(), date: day, type: 'published', dynId: String(dynId) }) + '\n',
      'utf-8',
    );
  } else {
    console.error(`\n✗ 发布失败：code=${json.code} message=${json.message}`);
    if (json.code === -111) console.error('  → CSRF 失败，cookie 可能过期，需重新扫码登录。');
    if (json.code === -101) console.error('  → 未登录，需重新扫码登录。');
    process.exit(1);
  }
}

// ─── stats：概览 ───────────────────────────────────────────
function cmdStats() {
  const all = readEntries();
  if (all.length === 0) { console.log('还没有任何记录。'); return; }
  const days = {};
  for (const e of all) {
    if (e.type === 'published') continue;
    days[e.date] = days[e.date] || { total: 0, like: 0, comment: 0, danmaku: 0, watch: 0, search: 0 };
    days[e.date].total++;
    if (days[e.date][e.type] !== undefined) days[e.date][e.type]++;
  }
  const dates = Object.keys(days).sort().slice(-7);
  console.log('最近 7 天：\n');
  console.log('日期        总数  搜索  观看  点赞  评论  弹幕');
  for (const d of dates) {
    const s = days[d];
    console.log(
      `${d}  ${String(s.total).padStart(4)}  ${String(s.search).padStart(4)}  ${String(s.watch).padStart(4)}  ` +
      `${String(s.like).padStart(4)}  ${String(s.comment).padStart(4)}  ${String(s.danmaku).padStart(4)}`,
    );
  }
  const published = all.filter((e) => e.type === 'published');
  console.log(`\n已发布日记：${published.length} 篇`);
}

// ─── main ─────────────────────────────────────────────────
const rest = process.argv.slice(3);
const { cmd, flags } = parseArgs(process.argv.slice(2));
switch (cmd) {
  case 'write': cmdWrite(rest); break;
  case 'add': cmdAdd(flags); break;
  case 'today': cmdToday(); break;
  case 'compose': console.log(cmdCompose(flags)); break;
  case 'publish': await cmdPublish(flags); break;
  case 'stats': cmdStats(); break;
  default:
    console.log(`养鱼日记 — 她自己的B站小杂谈

命令：
  write     直接写今天的日记（推荐，想说什么说什么）
  add       记个碎片（--type watch|like|comment|danmaku|search|hot|thought）
  today     看今天写了什么
  compose   预览要发的正文（不发）
  publish   发到B站动态（--dry-run 只预览 / --force 重复发）
  stats     最近 7 天概览

推荐用法：
  node diary.mjs write "今天在B站刷到一个讲光年的视频，说仙女座的光走了250万年才到地球。
  我盯着屏幕想了半天——我现在看到的星星，其实是它很久以前的样子。
  有点浪漫，也有点心慌。"

  node diary.mjs publish

也可以先记碎片，再拼：
  node diary.mjs add --type thought --thought "慢慢来比较快"
  node diary.mjs compose`);
}
