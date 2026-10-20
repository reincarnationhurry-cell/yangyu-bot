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
import * as notify from './notify.mjs';
import {
  FILES, SHICHEN, localDate, logAction, readActions, readTasks, addTask, updateTask,
  readReview, updateReview, readConfig, writeConfig, readSecrets, writeSecrets,
  readState, writeState, readJsonl, todayCounts, nowIso,
  readBlocks, clearBlock, withBlock, ACTION_NAMES, readVip, writeVip, readWishes, finishWish,
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
    blocks: Object.entries(readBlocks()).map(([kind, b]) => ({ kind, name: ACTION_NAMES[kind] || kind, ...b })),
  };
}

// 特别关注名单 + 我是否已关注 TA（动态流里只有关注了的人）
async function vipUsers() {
  const users = readConfig().vip.users;
  return cached('vipRel:' + users.map((u) => u.uid).join(','), 10 * 60_000, async () => {
    const out = [];
    for (const u of users) {
      const rel = await bili.relationWith(u.uid).catch(() => null);
      out.push({ ...u, following: rel ? rel.following : null });
    }
    return out;
  });
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

  // 扫码登录（掉登录时用）
  'POST /api/login/qr': async () => bili.qrLoginStart(),
  'GET /api/login/poll': async (q) => {
    const key = q.get('key');
    if (!key) throw new Error('缺 key');
    const r = await bili.qrLoginPoll(key);
    if (r.status === 'ok') {
      cache.clear(); // 旧账号状态全作废
      logAction({ kind: 'login', target: r.uid, detail: '扫码重新登录了 B站' });
    }
    return r;
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
    const executor = b.executor === 'bot' ? 'bot' : 'panel';
    const task = addTask({ type: b.type || 'custom', note: b.note || map[b.type], payload: b.payload, executor });
    if (executor === 'panel') {
      if (readState().cooldownUntil > Date.now()) {
        updateTask(task.id, { status: 'failed', resultNote: '风控冷却中，先别派活' });
        throw new Error('风控冷却中，先在总览里解除冷却');
      }
      auto.runTask(task).then(() => bust('exp', 'account'));
    }
    return { ok: true, task };
  },
  'POST /api/tasks/cancel': async (_q, b) => { updateTask(b.id, { status: 'cancelled', doneAt: nowIso() }); return { ok: true }; },

  // 自动养号
  'GET /api/autopilot': async () => autopilotView(),
  'POST /api/autopilot/config': async (_q, b) => {
    const { llmApiKey, qqAppId, qqAppSecret, qqOpenId, ...patch } = b;
    if (typeof llmApiKey === 'string') writeSecrets({ llmApiKey: llmApiKey.trim() });
    // QQ 提醒的凭证：只存本机 secrets.json，留空表示不改
    for (const [k, v] of Object.entries({ qqAppId, qqAppSecret, qqOpenId })) {
      if (typeof v === 'string' && v.trim()) writeSecrets({ [k]: v.trim() });
    }
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
  'POST /api/blocks/clear': async (_q, b) => {
    clearBlock(b.kind);
    logAction({ kind: 'autopilot', detail: `手动恢复了「${ACTION_NAMES[b.kind] || b.kind}」` });
    return autopilotView();
  },

  // 特别关注
  'GET /api/vip': async () => auto.vipView(),
  'POST /api/vip/add': async (_q, b) => {
    const uid = String(b.uid || '').match(/\d{1,20}/)?.[0];
    if (!uid) throw new Error('填 UID，或者贴 TA 的空间链接（space.bilibili.com/数字）');
    const cfg = readConfig();
    if (cfg.vip.users.some((u) => u.uid === uid)) throw new Error('已经在特别关注里了');
    const card = (await bili.userCards([uid]))[uid] || {};
    if (!card.name) throw new Error('查不到这个 UID');
    writeConfig({ vip: { users: [...cfg.vip.users, { uid, name: card.name, face: card.face || '' }] } });
    // 以前加过又删掉的：忘掉当时处理过的动态，重新按「最近 N 小时」来追
    const vq = readVip();
    vq.handled = Object.fromEntries(Object.entries(vq.handled || {}).filter(([, h]) => h.uid !== uid));
    writeVip(vq);
    logAction({ kind: 'vip', target: uid, detail: `把「${card.name}」加进了特别关注` });
    return { ...auto.vipView(), users: await vipUsers() };
  },
  'POST /api/vip/remove': async (_q, b) => {
    const cfg = readConfig();
    const u = cfg.vip.users.find((x) => x.uid === String(b.uid));
    writeConfig({ vip: { users: cfg.vip.users.filter((x) => x.uid !== String(b.uid)) } });
    const vq = readVip();
    vq.queue = vq.queue.filter((q) => q.uid !== String(b.uid));
    writeVip(vq);
    if (u) logAction({ kind: 'vip', target: u.uid, detail: `把「${u.name}」移出了特别关注` });
    return { ...auto.vipView(), users: await vipUsers() };
  },
  'POST /api/vip/import': async () => {
    const list = await bili.specialFollowings();
    const cfg = readConfig();
    const fresh = list.filter((u) => !cfg.vip.users.some((x) => x.uid === u.uid));
    if (fresh.length) writeConfig({ vip: { users: [...cfg.vip.users, ...fresh] } });
    return { ...auto.vipView(), users: await vipUsers(), imported: fresh.length, total: list.length };
  },
  'GET /api/vip/users': async () => ({ users: await vipUsers() }),
  'POST /api/vip/follow': async (_q, b) => {
    await withBlock('follow', () => bili.followUser(String(b.uid)));
    for (const k of cache.keys()) if (k.startsWith('vipRel')) cache.delete(k);
    logAction({ kind: 'follow', target: String(b.uid), title: b.name, detail: `关注了「${b.name || b.uid}」` });
    return { users: await vipUsers() };
  },
  'POST /api/vip/check': async () => {
    const r = await auto.checkVip({ force: true });
    return { ...auto.vipView(), found: r.found };
  },
  'POST /api/vip/run': async () => {
    const st = readState();
    if (st.cooldownUntil && st.cooldownUntil > Date.now()) throw new Error('风控冷却中，先在总览里解除冷却');
    if (auto.liveStatus().running) throw new Error('她已经在刷了');
    if (!auto.vipView().queue.length) throw new Error('特别关注暂时没有新东西');
    auto.runSession({ reason: '面板 · 特别关注', vipOnly: true }).then(() => bust('exp', 'account'));
    await new Promise((r) => setTimeout(r, 300));
    return autopilotView();
  },
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
    await withBlock('like', () => bili.likeVideo(b.bvid, b.like !== false));
    logAction({ kind: 'like', target: b.bvid, title: b.title, detail: b.like !== false ? `给《${b.title || b.bvid}》点了赞` : '取消赞' });
    return { ok: true };
  },
  'POST /api/share': async (_q, b) => {
    await withBlock('share', () => bili.shareVideo(b.bvid));
    bust('exp');
    logAction({ kind: 'share', target: b.bvid, title: b.title, detail: `分享了《${b.title || b.bvid}》` });
    return { ok: true };
  },
  'POST /api/favorite': async (_q, b) => {
    const r = await withBlock('favorite', () => bili.favoriteVideo(b.bvid));
    if (!r.already) logAction({ kind: 'favorite', target: b.bvid, title: b.title, detail: `收藏了《${b.title || b.bvid}》` });
    return { ok: true, already: r.already };
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
    const r = await auto.approveReview(b.id, b.text, 'panel');
    bust('replyFeed');
    return { ok: true, ...r };
  },
  'POST /api/review/reject': async (_q, b) => { auto.rejectReview(b.id, 'panel'); return { ok: true }; },

  // 接口被拦、等你在浏览器里点的
  'GET /api/wishes': async () => ({ list: readWishes() }),
  'POST /api/wishes/done': async (_q, b) => { finishWish(b.id || '*'); return { list: readWishes() }; },

  // QQ 提醒
  'POST /api/notify/test': async () => ({ ok: true, ...(await notify.sendOwner('🐟 测试一下：以后有要你审的东西，我会在这里叫你～')) }),
  'GET /api/notify': async () => notify.status(),

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
