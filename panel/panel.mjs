#!/usr/bin/env node
/**
 * 蓝色大肥鱼 · B站养鱼管理面板
 *
 * 零依赖本地 Web 服务：
 *  - 托管 public/ 下的单页 UI
 *  - 提供 /api/*：账号与经验、活动记录、自动养号、刷视频、消息中心、待审、日记
 *  - 进程内跑自动养号调度器（autopilot.mjs）
 *
 * 启动：node panel.mjs → http://127.0.0.1:8899
 */
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join, extname, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as bili from './bili.mjs';
import * as llm from './llm.mjs';
import * as auto from './autopilot.mjs';
import {
  FILES, SHICHEN, localDate, logAction, readActions, readTasks, addTask, updateTask,
  readReview, updateReview, readConfig, writeConfig, readSecrets, writeSecrets,
  readState, writeState, readJsonl, todayCounts, nowIso,
} from './store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PUBLIC = join(here, 'public');
const PORT = Number(process.env.PANEL_PORT || 8899);
const HOST = '127.0.0.1';

// ─── B站数据缓存：面板每 30 秒刷新，但别每次都去敲 B站 ──────
// 一个号每 15 秒查一次 nav + 经验 + 未读，本身就很不像真人。
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  return value;
}
const bust = (...keys) => keys.forEach((k) => cache.delete(k));

// ─── 统计 ──────────────────────────────────────────────────
function dailySeries(days = 14) {
  const out = [];
  const byDay = {};
  for (const a of readActions()) {
    if (!a.ok) continue;
    const d = localDate(new Date(a.ts));
    const o = (byDay[d] ||= { watch: 0, like: 0, comment: 0, share: 0, seconds: 0 });
    if (a.kind === 'watch') { o.watch++; o.seconds += Number(a.meta?.played || 0); }
    else if (a.kind === 'like') o.like++;
    else if (a.kind === 'comment' || a.kind === 'reply_comment') o.comment++;
    else if (a.kind === 'share') o.share++;
  }
  for (let i = days - 1; i >= 0; i--) {
    const d = localDate(new Date(Date.now() - i * 86400_000));
    out.push({ date: d, ...(byDay[d] || { watch: 0, like: 0, comment: 0, share: 0, seconds: 0 }) });
  }
  return out;
}

function autopilotView() {
  const cfg = readConfig();
  const state = readState();
  let plan = [];
  try { plan = auto.todayPlan(); } catch { /* ignore */ }
  return {
    config: cfg,
    shichen: SHICHEN,
    plan,
    live: auto.liveStatus(),
    lastRun: state.lastRun || null,
    cooldownUntil: state.cooldownUntil && state.cooldownUntil > Date.now() ? state.cooldownUntil : null,
    llmReady: llm.llmReady(),
    hasKey: !!readSecrets().llmApiKey,
    coinLock: bili.coinLock(),
  };
}

// ─── HTTP 工具 ─────────────────────────────────────────────
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf-8');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.ico': 'image/x-icon', '.json': 'application/json',
};
function serveStatic(res, p) {
  const rel = normalize(p === '/' ? '/index.html' : p).replace(/^(\.\.[/\\])+/, '');
  const file = join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !existsSync(file)) return false;
  res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  res.end(readFileSync(file));
  return true;
}

/**
 * 防跨站：面板只给本机浏览器用。别的网页可以往 127.0.0.1 发请求（CSRF / DNS rebinding），
 * 所以校验 Host，写操作还要求 JSON（跨站发 JSON 会触发 CORS 预检，被浏览器拦下）且 Origin 匹配。
 */
function allowed(req) {
  const host = String(req.headers.host || '');
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  if (req.method === 'GET') return true;
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false;
  return String(req.headers['content-type'] || '').includes('application/json');
}

// ─── 路由 ──────────────────────────────────────────────────
const routes = {
  // 总览：账号、经验、今日、未读、自动养号、近 14 天
  'GET /api/overview': async () => {
    const [account, exp, unread] = await Promise.all([
      cached('account', 120_000, bili.getAccountStatus).catch((e) => ({ error: e.message })),
      cached('exp', 120_000, bili.getExpStatus).catch((e) => ({ error: e.message })),
      cached('unread', 90_000, bili.unreadCounts).catch(() => null),
    ]);
    return {
      account, exp, unread,
      today: todayCounts(),
      series: dailySeries(14),
      tasksPending: readTasks().filter((t) => t.status === 'pending').length,
      reviewPending: readReview().filter((r) => r.status === 'pending').length,
      autopilot: autopilotView(),
    };
  },

  // 活动记录
  'GET /api/actions': async (q) => {
    let list = readActions();
    const kind = q.get('kind'); const source = q.get('source'); const date = q.get('date'); const s = q.get('q');
    if (kind) list = list.filter((a) => kind.split(',').includes(a.kind));
    if (source) list = list.filter((a) => a.source === source || (!a.source && source === 'panel'));
    if (date) list = list.filter((a) => localDate(new Date(a.ts)) === date);
    if (s) list = list.filter((a) => `${a.title} ${a.detail} ${a.target}`.includes(s));
    const limit = Number(q.get('limit') || 200);
    return { total: list.length, list: list.slice(-limit).reverse() };
  },

  // 任务箱
  'GET /api/tasks': async () => ({ tasks: readTasks().slice(0, 80) }),
  'POST /api/tasks': async (_q, b) => {
    const map = {
      browse: '随便刷刷B站，看到有意思的点个赞、写两句感想',
      browse_like: '刷B站，挑喜欢的点赞',
      comment: '挑几个视频留两句真实感想',
      diary: '把今天刷到的写进养鱼日记，晚上发动态',
      check: '看看有没有新评论和私信要回',
    };
    if (!map[b.type] && !b.note) throw new Error('未知任务类型');
    return { ok: true, task: addTask({ type: b.type || 'custom', note: b.note || map[b.type], payload: b.payload }) };
  },
  'POST /api/tasks/cancel': async (_q, b) => { updateTask(b.id, { status: 'cancelled', doneAt: nowIso() }); return { ok: true }; },

  // 自动养号
  'GET /api/autopilot': async () => autopilotView(),
  'POST /api/autopilot/config': async (_q, b) => {
    const { llmApiKey, ...patch } = b;
    if (typeof llmApiKey === 'string') writeSecrets({ llmApiKey: llmApiKey.trim() });
    const before = readConfig();
    const cfg = writeConfig(patch);
    if (JSON.stringify(before.windows) !== JSON.stringify(cfg.windows) || before.windowChance !== cfg.windowChance) auto.replanToday();
    if (before.enabled !== cfg.enabled) logAction({ kind: 'autopilot', detail: cfg.enabled ? '打开了自动养号' : '关掉了自动养号' });
    return autopilotView();
  },
  'POST /api/autopilot/replan': async () => { auto.replanToday(); return autopilotView(); },
  'POST /api/autopilot/run': async (_q, b) => {
    const st = readState();
    if (st.cooldownUntil && st.cooldownUntil > Date.now()) throw new Error('风控冷却中，先在总览里解除冷却');
    if (auto.liveStatus().running) throw new Error('她已经在刷了');
    const videos = b.bvid ? [{ bvid: b.bvid }] : undefined;
    auto.runSession({ reason: b.bvid ? '面板点播' : '面板手动', videos }).then(() => bust('exp', 'account'));
    await new Promise((r) => setTimeout(r, 300));
    return autopilotView();
  },
  'POST /api/autopilot/stop': async () => { auto.stopSession(); return { ok: true }; },
  'POST /api/autopilot/clear-cooldown': async () => {
    const s = readState(); s.cooldownUntil = null; writeState(s);
    logAction({ kind: 'autopilot', detail: '手动解除了风控冷却' });
    return autopilotView();
  },
  'POST /api/autopilot/llm-test': async () => ({ ok: true, reply: await llm.ping() }),
  'POST /api/autopilot/llm-models': async () => ({ models: await llm.listModels() }),
  'POST /api/coin/unlock': async () => {
    bili.unlockCoin();
    logAction({ kind: 'autopilot', detail: '手动解锁了投币' });
    return autopilotView();
  },

  // 经验
  'GET /api/exp': async () => cached('exp', 60_000, bili.getExpStatus),

  // 刷视频
  'GET /api/feed': async () => {
    const list = await bili.feedVideos(12);
    logAction({ kind: 'feed', detail: `刷了刷首页推荐（${list.length} 条）` });
    return { list };
  },
  'GET /api/hot': async () => ({ list: await cached('hot', 300_000, () => bili.hotVideos(30)) }),
  'GET /api/search': async (q) => {
    const kw = q.get('q') || '';
    if (!kw) throw new Error('缺关键词');
    const list = await bili.searchVideo(kw, q.get('order') || 'totalrank');
    logAction({ kind: 'search', target: kw, detail: `搜「${kw}」，${list.length} 条` });
    return { list };
  },
  'GET /api/video': async (q) => {
    const bvid = q.get('bvid');
    if (!bvid) throw new Error('缺 bvid');
    const video = await bili.browseVideo(bvid);
    logAction({ kind: 'view', target: bvid, title: video.title, detail: `打开了《${video.title}》` });
    return { video };
  },
  'GET /api/comments': async (q) => bili.videoComments(q.get('bvid'), q.get('aid'), Number(q.get('page') || 1)),
  'GET /api/history': async () => ({ list: await cached('history', 60_000, () => bili.watchHistory(30)) }),

  'POST /api/like': async (_q, b) => {
    await bili.likeVideo(b.bvid, b.like !== false);
    logAction({ kind: 'like', target: b.bvid, title: b.title, detail: b.like !== false ? `给《${b.title || b.bvid}》点了赞` : '取消赞' });
    return { ok: true };
  },
  'POST /api/share': async (_q, b) => {
    await bili.shareVideo(b.bvid);
    bust('exp');
    logAction({ kind: 'share', target: b.bvid, title: b.title, detail: `分享了《${b.title || b.bvid}》` });
    return { ok: true };
  },
  'POST /api/coin': async (_q, b) => {
    try {
      const r = await bili.coinVideo(b.bvid, 1);
      bust('exp', 'account');
      logAction({ kind: 'coin', target: b.bvid, title: b.title, detail: `给《${b.title || b.bvid}》投了 1 个币` });
      return r;
    } catch (e) {
      logAction({ kind: 'coin', ok: false, target: b.bvid, error: e.message, detail: '投币失败' });
      throw e;
    }
  },
  'POST /api/comment': async (_q, b) => {
    const { bvid, oid, type, message, rootRpid, parentRpid, title } = b;
    if (!message || (!bvid && !oid)) throw new Error('缺视频或内容');
    const r = await bili.postComment({ bvid, oid, type, message, rootRpid, parentRpid });
    logAction({ kind: rootRpid ? 'reply_comment' : 'comment', target: bvid || oid, title, detail: message.slice(0, 120) });
    bust('replyFeed');
    return { ok: true, rpid: r.rpid };
  },

  // 消息中心
  'GET /api/inbox/unread': async () => cached('unread', 30_000, bili.unreadCounts),
  'GET /api/inbox/reply': async () => { const list = await cached('replyFeed', 30_000, bili.replyFeed); bust('unread'); return { list }; },
  'GET /api/inbox/at': async () => { const list = await cached('atFeed', 30_000, bili.atFeed); bust('unread'); return { list }; },
  'GET /api/inbox/like': async () => { const list = await cached('likeFeed', 60_000, bili.likeFeed); bust('unread'); return { list }; },
  'GET /api/messages/sessions': async () => ({ list: await cached('sessions', 20_000, bili.listSessions) }),
  'GET /api/messages/list': async (q) => {
    const talkerId = q.get('talkerId');
    if (!talkerId) throw new Error('缺 talkerId');
    return { list: await bili.listMessages(talkerId) };
  },
  'POST /api/messages/read': async (_q, b) => {
    if (!b.talkerId) throw new Error('缺 talkerId');
    await bili.markSessionRead(b.talkerId, b.seqno);
    bust('sessions', 'unread');
    return { ok: true };
  },
  'POST /api/messages/send': async (_q, b) => {
    if (!b.uid || !b.text) throw new Error('缺 uid 或 text');
    const r = await bili.sendPrivateMessage(b.uid, b.text);
    logAction({ kind: 'dm_send', target: b.uid, title: b.name, detail: b.text.slice(0, 120) });
    bust('sessions');
    return { ok: true, msgKey: r.msgKey };
  },

  // AI 起草回复（只起草，不发）
  'POST /api/ai/reply': async (_q, b) => {
    const text = await llm.draftReply({ context: b.context, message: b.message, kind: b.kind });
    if (!text) throw new Error('她没想好怎么回（或者内容没过安全检查），自己写一句吧');
    return { text };
  },
  'POST /api/ai/comment': async (_q, b) => {
    const video = await bili.browseVideo(b.bvid);
    const text = await llm.draftComment(video);
    if (!text) throw new Error('她觉得这个视频没什么想说的');
    return { text };
  },

  // 待审
  'GET /api/review': async () => ({ list: readReview().slice(0, 60) }),
  'POST /api/review/approve': async (_q, b) => {
    const r = readReview().find((x) => x.id === b.id);
    if (!r || r.status !== 'pending') throw new Error('这条已经处理过了');
    const text = String(b.text ?? r.text).trim();
    if (!text) throw new Error('内容是空的');
    if (r.kind === 'comment') {
      const res = await bili.postComment({ bvid: r.payload.bvid, message: text });
      logAction({ kind: 'comment', source: 'auto', target: r.payload.bvid, title: r.payload.title, detail: text });
      updateReview(r.id, { status: 'posted', text, rpid: res.rpid });
    } else if (r.kind === 'diary') {
      const res = await auto.publishDiary(text, 'auto', { force: true });
      updateReview(r.id, { status: 'posted', text, url: res.url });
    }
    return { ok: true };
  },
  'POST /api/review/reject': async (_q, b) => { updateReview(b.id, { status: 'rejected' }); return { ok: true }; },

  // 日记
  'GET /api/diary': async () => {
    const all = readJsonl(FILES.diary);
    const published = all.filter((e) => e.type === 'published');
    const drafts = all.filter((e) => e.type === 'draft').reverse().slice(0, 30).map((d) => ({
      ...d, dynId: published.find((p) => p.date === d.date && p.ts >= d.ts)?.dynId || null,
    }));
    return { drafts, publishedToday: published.some((p) => p.date === localDate()) };
  },
  'POST /api/diary/publish': async (_q, b) => {
    const text = String(b.text || '').trim();
    if (!text) throw new Error('写点什么再发');
    return auto.publishDiary(text, 'panel', { force: true });
  },
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  const p = url.pathname;
  if (!allowed(req)) return json(res, 403, { error: 'forbidden' });

  if (req.method === 'GET' && !p.startsWith('/api/')) {
    if (serveStatic(res, p)) return;
    return json(res, 404, { error: 'not found' });
  }
  const handler = routes[`${req.method} ${p}`];
  if (!handler) return json(res, 404, { error: 'not found' });
  try {
    const body = req.method === 'POST' ? await readBody(req) : {};
    return json(res, 200, await handler(url.searchParams, body));
  } catch (err) {
    const msg = String(err?.message || err);
    if (req.method === 'POST') logAction({ kind: 'error', ok: false, error: msg, detail: `${p} 失败` });
    return json(res, 500, { error: msg, code: err?.code ?? null });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n🐟 养鱼面板已启动：http://${HOST}:${PORT}\n`);
  auto.startScheduler();
});
