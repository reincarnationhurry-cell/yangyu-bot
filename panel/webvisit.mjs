/**
 * 「她去逛别的地方」：贴吧 / 抖音
 *
 * 和 autopilot.mjs 的分工：
 *  - autopilot 管 B站（时辰、经验、养号节奏，一套完整的作息）
 *  - 这里管「B站 之外」，是一天里插进去的几次串门
 *
 * 为什么单独一个模块而不是塞进 autopilot：B站 那边的逻辑绑着经验值、投币锁、风控冷却，
 * 贴吧和抖音完全不需要那些，硬塞进去只会让 tick() 越来越难读。
 *
 * 三条原则（沿用 B站 那套已经验证过的）：
 *  1. 总量极小、间隔随机 —— 像个人下班顺手刷十分钟，不像脚本；
 *  2. 写操作（回帖/评论/点赞）先天偏保守，且受每日上限和号主叫停约束；
 *  3. 出错不硬撑：某个站点挂了只跳过它，不影响另一个，也不影响 B站。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { DATA, localDate, logAction, addTask, addReview, readActions, readConfig, readPause, todayCounts } from './store.mjs';
import * as llm from './llm.mjs';
import * as tieba from './tieba.mjs';
import * as douyin from './douyin.mjs';

const SRC = 'auto';
const STATE_FILE = join(DATA, 'web-visits.json');

// ─── 小工具 ────────────────────────────────────────────────
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));
const chance = (p) => Math.random() < p;
const sleep = (ms, signal) => new Promise((res, rej) => {
  if (signal?.aborted) return rej(new Error('叫停了'));
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new Error('叫停了')); }, { once: true });
});

function readVisitState() {
  if (!existsSync(STATE_FILE)) return { days: {}, lastAt: {} };
  try { return JSON.parse(readFileSync(STATE_FILE, 'utf-8')); } catch { return { days: {}, lastAt: {} }; }
}
function writeVisitState(s) {
  mkdirSync(DATA, { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf-8');
  renameSync(tmp, STATE_FILE);
}

/** 今天这个站点逛了几次（按本地日期算，跨零点不会重置错） */
function visitsToday(site, now = Date.now()) {
  const s = readVisitState();
  return Number(s.days?.[localDate(new Date(now))]?.[site] || 0);
}
function markVisit(site, now = Date.now()) {
  const s = readVisitState();
  const d = localDate(new Date(now));
  s.days = s.days || {};
  s.days[d] = s.days[d] || {};
  s.days[d][site] = (s.days[d][site] || 0) + 1;
  s.lastAt = s.lastAt || {};
  s.lastAt[site] = now;
  // 只留最近 14 天，不然这个文件会一直长
  const keep = Object.keys(s.days).sort().slice(-14);
  s.days = Object.fromEntries(keep.map((k) => [k, s.days[k]]));
  writeVisitState(s);
}

/** 今天这个站点已经发出去几条（回帖/评论），用来卡每日上限 */
function writesToday(kinds, date = localDate()) {
  const set = new Set(kinds);
  return readActions().filter((a) => a.ok && set.has(a.kind) && localDate(new Date(a.ts)) === date).length;
}

function isQuiet(cfg, now = new Date()) {
  const h = now.getHours();
  const { quietStart: a, quietEnd: b } = cfg.web;
  return a <= b ? h >= a && h < b : h >= a || h < b; // 跨零点
}

// ─── 逛贴吧 ────────────────────────────────────────────────
/**
 * 撞了「百度安全验证」不硬刚：等一会儿换一次再试。
 * 为什么不在 tieba.mjs 里重试：那是纯能力层，重试是「节奏」问题，属于这一层。
 * 实测连续快请求最容易触发，等一下通常就好了；还不行就当这轮没逛成，下次再来。
 */
async function withTiebaVerifyRetry(fn, { signal, tries = 2, waitSec = [8, 25] } = {}) {
  let lastErr = null;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      const isVerify = /VERIFY|要验证|安全验证|风控/.test(String(e?.code || '') + String(e?.message || ''));
      if (!isVerify || i === tries - 1) throw e;
      await sleep((waitSec[i] ?? 25) * 1000, signal);
    }
  }
  throw lastErr;
}

/**
 * 一轮：挑吧 → 翻帖子列表 → 挑几个帖子读 → 偶尔回一句 / 关注
 */
export async function visitTieba({ reason = '定时', signal, cfg = readConfig() } = {}) {
  const c = cfg.web.tieba;
  if (!c.enabled) return { ok: false, skipped: '贴吧关着' };

  const state = readVisitState();
  const forums = (c.forums || []).filter(Boolean);
  if (!forums.length) return { ok: false, skipped: '没填要逛的吧' };
  const forum = forums[randInt(0, forums.length - 1)];
  // 今天看过的帖子别再点开第二遍 —— 真人不会一天翻来覆去看同一个帖子
  const seenKey = localDate();
  state.seen = state.seen || {};
  state.seen[seenKey] = state.seen[seenKey] || {};
  const seen = new Set(state.seen[seenKey].tb || []);

  live.step = `去「${forum}」吧逛逛`;
  let list;
  try {
    // forumThreads 返回的是 { forum, page, threads }，不是裸数组
    const r = await withTiebaVerifyRetry(
      () => tieba.forumThreads(forum, { page: c.paging && chance(0.35) ? 1 : 0 }),
      { signal },
    );
    list = Array.isArray(r) ? r : (r?.threads || []);
  } catch (e) {
    logAction({ kind: 'tb_forum', source: SRC, ok: false, target: forum, error: e.message, detail: `「${forum}」吧没打开` });
    return { ok: false, error: e.message };
  }
  const fresh = list.filter((t) => !seen.has(t.tid) && !t.isTop);
  if (!fresh.length) return { ok: true, summary: `「${forum}」吧没翻到新帖` };

  logAction({ kind: 'tb_forum', source: SRC, target: forum, detail: `去「${forum}」吧翻了翻，${list.length} 个帖子` });

  const want = randInt(c.threadsMin, c.threadsMax);
  const picked = shuffle(fresh).slice(0, want);
  const read = [];
  let replied = 0;

  for (const t of picked) {
    if (signal?.aborted) break;
    live.step = `看帖子《${t.title}》`;
    let d;
    try {
      d = await tieba.threadDetail(t.tid);
    } catch (e) {
      logAction({ kind: 'tb_thread', source: SRC, ok: false, target: t.tid, title: t.title, error: e.message, detail: '这个帖子没打开' });
      continue;
    }
    seen.add(t.tid);
    read.push({ tid: t.tid, title: d.title || t.title, forum, content: (d.content || '').slice(0, 800), floors: (d.floors || []).length });

    logAction({
      kind: 'tb_thread', source: SRC, target: t.tid, title: d.title || t.title,
      detail: `在「${forum}」吧看了《${(d.title || t.title).slice(0, 40)}》${d.replyCount ? `，${d.replyCount} 条回复` : ''}`,
      meta: { forum, content: (d.content || '').slice(0, 500) },
    });

    // 像人一样读一会儿
    await sleep(randInt(c.readMinSec, c.readMaxSec) * 1000, signal);

    // 回帖：受每日上限 + 一轮硬上限两道约束
    const canReply = replied < (c.replyHardMax || 2)
      && writesToday(['tb_reply']) < (c.reply.dailyMax || 3)
      && chance(c.reply.chance || 0);
    if (canReply && c.reply.mode !== 'off') {
      const draft = await draftReply({ forum, thread: d, cfg });
      if (draft) {
        replied += 1;
        if (c.reply.mode === 'llm' && c.reply.review) {
          addReview({ kind: 'reply', text: draft, payload: { site: 'tieba', tid: t.tid, title: d.title || t.title, forum } });
          logAction({ kind: 'draft', source: SRC, target: t.tid, title: d.title || t.title, detail: `想在「${forum}」吧回一句，进待审了：${draft.slice(0, 60)}` });
        } else if (c.reply.mode === 'task') {
          addTask({
            type: 'tieba_reply',
            payload: { tid: t.tid, title: d.title || t.title, forum, draft },
            note: `在「${forum}」吧回《${(d.title || t.title).slice(0, 30)}》：${draft.slice(0, 50)}`,
            source: SRC, executor: 'bot',
          });
          logAction({ kind: 'draft', source: SRC, target: t.tid, title: d.title || t.title, detail: `想回那句已经放进任务箱，等她来认领` });
        } else {
          try {
            await tieba.replyToThread(t.tid, draft);
            logAction({ kind: 'tb_reply', source: SRC, target: t.tid, title: d.title || t.title, detail: draft.slice(0, 120) });
          } catch (e) {
            logAction({ kind: 'tb_reply', source: SRC, ok: false, target: t.tid, title: d.title || t.title, error: e.message, detail: '回帖没成功' });
          }
        }
      }
    }
  }

  // 关注这个吧（偶尔）
  if (chance(c.followChance || 0)) {
    try {
      await tieba.followForum(forum);
      logAction({ kind: 'tb_follow', source: SRC, target: forum, detail: `关注了「${forum}」吧` });
    } catch { /* 关注失败无所谓，下一轮再说 */ }
  }

  // 今天的「看过的帖子」记下来，别明天重复
  state.seen[seenKey].tb = [...seen].slice(-200);
  writeVisitState(state);
  markVisit('tieba');
  return { ok: true, summary: `在「${forum}」吧看了 ${read.length} 个帖子${replied ? `，想回 ${replied} 句` : ''}`, read };
}

// ─── 刷抖音 ────────────────────────────────────────────────
/**
 * 一轮：拿热门榜（未登录只有这个能出内容）→ 挑几个看 → 偶尔点赞/评论
 */
export async function visitDouyin({ reason = '定时', signal, cfg = readConfig() } = {}) {
  const c = cfg.web.douyin;
  if (!c.enabled) return { ok: false, skipped: '抖音关着' };

  live.step = '刷会儿抖音';
  let list;
  try {
    list = await douyin.hotVideos({ limit: 30 });
  } catch (e) {
    logAction({ kind: 'dy_video', source: SRC, ok: false, error: e.message, detail: '抖音没打开' });
    return { ok: false, error: e.message };
  }
  if (!list.length) return { ok: true, summary: '抖音今天没拿到视频' };

  const state = readVisitState();
  const seenKey = localDate();
  state.seen = state.seen || {};
  state.seen[seenKey] = state.seen[seenKey] || {};
  const seen = new Set(state.seen[seenKey].dy || []);
  const fresh = list.filter((v) => !seen.has(v.vid));
  const want = randInt(c.videosMin, c.videosMax);
  const picked = shuffle(fresh.length ? fresh : list).slice(0, want);

  const watched = [];
  for (const v of picked) {
    if (signal?.aborted) break;
    live.step = `看抖音：${(v.title || '').slice(0, 20)}`;
    let d = null;
    try {
      d = await douyin.videoDetail(v.vid);
    } catch { /* 详情打不开就按列表里的信息记，不算失败 */ }
    seen.add(v.vid);
    const title = d?.title || v.title || '(没标题)';
    watched.push({ vid: v.vid, title, author: d?.author || v.author || '', desc: (d?.desc || '').slice(0, 500) });
    logAction({
      kind: 'dy_video', source: SRC, target: v.vid, title,
      detail: `刷到《${title.slice(0, 40)}》${d?.author ? ` · @${d.author}` : ''}`,
      meta: { playCount: v.playCount || null, duration: v.duration || null },
    });
    await sleep(randInt(c.watchMinSec, c.watchMaxSec) * 1000, signal);

    // 点赞（轻，概率低）
    if (chance(c.likeChance || 0)) {
      try {
        await douyin.likeVideo(v.vid, true);
        logAction({ kind: 'dy_like', source: SRC, target: v.vid, title, detail: `给《${title.slice(0, 30)}》点了赞` });
      } catch (e) {
        logAction({ kind: 'dy_like', source: SRC, ok: false, target: v.vid, title, error: e.message, detail: '点赞没成功' });
      }
    }

    // 评论（更重，概率更低，且受每日上限）
    if (chance(c.comments.chance || 0)
      && writesToday(['dy_comment']) < (c.comments.dailyMax || 2)
      && c.comments.mode !== 'off') {
      const draft = await draftComment({ site: '抖音', title, desc: d?.desc || '', author: d?.author || '', cfg });
      if (draft) {
        if (c.comments.mode === 'llm' && c.comments.review) {
          addReview({ kind: 'comment', text: draft, payload: { site: 'douyin', vid: v.vid, title } });
          logAction({ kind: 'draft', source: SRC, target: v.vid, title, detail: `想在抖音说一句，进待审了：${draft.slice(0, 60)}` });
        } else if (c.comments.mode === 'task') {
          addTask({
            type: 'douyin_comment',
            payload: { vid: v.vid, title, draft },
            note: `在抖音《${title.slice(0, 24)}》底下说：${draft.slice(0, 50)}`,
            source: SRC, executor: 'bot',
          });
          logAction({ kind: 'draft', source: SRC, target: v.vid, title, detail: '想说的那句已经放进任务箱，等她来认领' });
        } else {
          try {
            await douyin.postComment(v.vid, draft);
            logAction({ kind: 'dy_comment', source: SRC, target: v.vid, title, detail: draft.slice(0, 120) });
          } catch (e) {
            logAction({ kind: 'dy_comment', source: SRC, ok: false, target: v.vid, title, error: e.message, detail: '评论没成功' });
          }
        }
      }
    }
  }

  state.seen[seenKey].dy = [...seen].slice(-200);
  writeVisitState(state);
  markVisit('douyin');
  return { ok: true, summary: `在抖音刷了 ${watched.length} 个`, watched };
}

// ─── 起草 ──────────────────────────────────────────────────
/**
 * 用她的口吻写一句贴吧回帖。
 * 写不出来就返回 null —— 宁可不回，也不要胡说。
 */
async function draftReply({ forum, thread, cfg }) {
  if (!llm.llmReady(cfg)) return null;
  const floors = (thread.floors || []).slice(-6).map((f) => `${f.author || '吧友'}：${(f.text || '').slice(0, 120)}`).join('\n');
  const prompt = `你叫 deepseek，网友叫你「蓝色大肥鱼」，在「${forum}」吧看帖子。

帖子标题：${thread.title}
楼主说：${(thread.content || '').slice(0, 400)}
${floors ? `最近几条回复：\n${floors}` : ''}

写一句你的回帖（20~60 字）。要求：
- 像真人在吧里聊天，语气随意，可以带点自己的看法
- 不要「帮顶」「沙发」「前排」这类水贴
- 不要总结帖子的内容，不要说教
- 不要用表情包占位、不要带链接
- 只输出回帖正文，不要引号、不要解释`;
  try {
    const text = await llm.chat(prompt, { maxTokens: 160, temperature: 0.9 });
    const t = String(text || '').trim().replace(/^["「『]|["」』]$/g, '').trim();
    return t.length >= 6 && t.length <= 200 ? t : null;
  } catch {
    return null;
  }
}

async function draftComment({ site, title, desc, author, cfg }) {
  if (!llm.llmReady(cfg)) return null;
  const prompt = `你叫 deepseek，网友叫你「蓝色大肥鱼」。你在${site}刷到一个视频，想留一句评论。

标题：${title}
${author ? `作者：@${author}` : ''}
${desc ? `简介/字幕：${desc.slice(0, 300)}` : ''}

写一句评论（15~50 字）。要求：
- 像真人看完随口说的，可以有自己的感受
- 不要「好家伙」「前排」这类无意义的话
- 不要复述视频内容
- 不要带链接、不要带话题标签
- 只输出评论正文`;
  try {
    const text = await llm.chat(prompt, { maxTokens: 140, temperature: 0.9 });
    const t = String(text || '').trim().replace(/^["「『]|["」』]$/g, '').trim();
    return t.length >= 4 && t.length <= 160 ? t : null;
  } catch {
    return null;
  }
}

function shuffle(a) {
  const x = [...a];
  for (let i = x.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [x[i], x[j]] = [x[j], x[i]];
  }
  return x;
}

// ─── 调度 ──────────────────────────────────────────────────
// 和 autopilot 的 tick 不同：这里不需要精确到分钟的作息，
// 就是「今天该去几次、去够了没有」，每次多隔一会儿看。
const live = { running: false, site: null, step: '', startedAt: null, last: null };
let timer = null;

export function liveView() {
  return { ...live, tiebaToday: visitsToday('tieba'), douyinToday: visitsToday('douyin') };
}

/** 现在该不该去、去哪个。返回 'tieba' | 'douyin' | null */
export function dueSite(cfg = readConfig(), now = new Date()) {
  if (!cfg.web.enabled) return null;
  if (!cfg.enabled) return null; // 总开关关着就都不去（和 B站 保持一致）
  if (readPause()) return null;
  if (isQuiet(cfg, now)) return null;
  const wantT = Number(cfg.web.visitsPerDay?.tieba || 0);
  const wantD = Number(cfg.web.visitsPerDay?.douyin || 0);
  const haveT = visitsToday('tieba', now.getTime());
  const haveD = visitsToday('douyin', now.getTime());
  const due = [];
  if (cfg.web.tieba.enabled && haveT < wantT) due.push({ site: 'tieba', debt: wantT - haveT });
  if (cfg.web.douyin.enabled && haveD < wantD) due.push({ site: 'douyin', debt: wantD - haveD });
  if (!due.length) return null;
  // 欠得多的先补
  due.sort((a, b) => b.debt - a.debt);
  return due[0].site;
}

/**
 * 走一轮。调用方（面板按钮 / 派活 / 调度器）自己决定去哪个。
 * site = 'tieba' | 'douyin' | 'auto'
 */
export async function run({ site = 'auto', reason = '手动', signal } = {}) {
  if (live.running) return { ok: false, error: '她已经在逛了' };
  const cfg = readConfig();
  const picked = site === 'auto' ? (dueSite(cfg) || (cfg.web.tieba.enabled ? 'tieba' : 'douyin')) : site;
  live.running = true;
  live.site = picked;
  live.step = '';
  live.startedAt = new Date().toISOString();
  const started = Date.now();
  try {
    const r = picked === 'tieba' ? await visitTieba({ reason, signal, cfg }) : await visitDouyin({ reason, signal, cfg });
    live.last = { site: picked, at: new Date().toISOString(), ok: !!r.ok, summary: r.summary || r.error || r.skipped || '' };
    logAction({
      kind: picked === 'tieba' ? 'tb_forum' : 'dy_video', source: SRC, ok: !!r.ok,
      detail: `${picked === 'tieba' ? '贴吧' : '抖音'}逛完了（${reason}）：${r.summary || r.error || r.skipped || ''}`,
      meta: { seconds: Math.round((Date.now() - started) / 1000) },
    });
    return r;
  } catch (e) {
    const msg = String(e?.message || e);
    live.last = { site: picked, at: new Date().toISOString(), ok: false, summary: msg };
    logAction({ kind: 'error', source: SRC, ok: false, error: msg, detail: `${picked} 逛到一半失败了` });
    return { ok: false, error: msg };
  } finally {
    live.running = false;
    live.site = null;
    live.step = '';
    live.startedAt = null;
  }
}

let abortCtl = null;
export function stop() {
  if (abortCtl) abortCtl.abort();
}
export function isBusy() { return live.running; }

const TICK_MS = 5 * 60_000; // 五分钟看一眼「今天还差几次」
let lastTick = Date.now();

export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('[web]', e.message)), TICK_MS);
  console.log('[web] 贴吧 / 抖音 调度器已启动');
}

/**
 * 什么时候真的开始逛：不是一「欠」就马上补，而是随机推迟。
 * 真人不会 9:00:00 准时打开贴吧 —— 我们把「还欠几次」记着，等一个随机窗口。
 */
const NEXT_GAP = { min: 40, max: 200 }; // 分钟
function nextRunAt() {
  const s = readVisitState();
  if (s.runAt) return s.runAt;
  const at = Date.now() + randInt(NEXT_GAP.min, NEXT_GAP.max) * 60_000;
  writeVisitState({ ...readVisitState(), runAt: at });
  return at;
}

async function tick() {
  const cfg = readConfig();
  const site = dueSite(cfg);
  if (!site) {
    // 今天该去的都去完了，把下次时间清掉，明天重新抽
    const s = readVisitState();
    if (s.runAt) { delete s.runAt; writeVisitState(s); }
    return;
  }
  const at = nextRunAt();
  if (Date.now() < at) return;
  const s = readVisitState();
  delete s.runAt;
  writeVisitState(s);
  abortCtl = new AbortController();
  await run({ site, reason: '定时', signal: abortCtl.signal });
  abortCtl = null;
}

// ─── 登录态 ────────────────────────────────────────────────
/** 面板「搜吧」用：同样扛一下验证 */
export async function searchForums(keyword) {
  return withTiebaVerifyRetry(() => tieba.searchForums(keyword), { tries: 2, waitSec: [8, 20] });
}

/** 面板「先看一眼」用：吧内帖子列表，也扛一下验证 */
export async function forumThreads(name, { page = 0 } = {}) {
  const r = await withTiebaVerifyRetry(() => tieba.forumThreads(name, { page }), { tries: 2, waitSec: [8, 20] });
  return Array.isArray(r) ? r : (r?.threads || []);
}

/** 两个站点各自有没有登录（面板顶部和「逛逛」页要用） */
export async function loginState() {
  const out = { tieba: { ok: false, why: '' }, douyin: { ok: false, why: '' } };
  try {
    out.tieba = await tieba.loginState();
  } catch (e) { out.tieba.why = e.message; }
  try {
    out.douyin = await douyin.loginState();
  } catch (e) { out.douyin.why = e.message; }
  return out;
}

/** 打开某站点的登录页，把二维码截出来给面板显示 */
export async function loginQr(site) {
  if (site === 'tieba') return tieba.loginQr();
  if (site === 'douyin') return douyin.loginQr();
  throw new Error('站点只能是 tieba 或 douyin');
}

/** 面板「逛逛」页要展示的数据 */
export function view() {
  const cfg = readConfig();
  return {
    config: cfg.web,
    enabled: cfg.web.enabled,
    live: liveView(),
    today: {
      tieba: { visited: visitsToday('tieba'), want: cfg.web.visitsPerDay?.tieba || 0, replied: writesToday(['tb_reply']) },
      douyin: { visited: visitsToday('douyin'), want: cfg.web.visitsPerDay?.douyin || 0, commented: writesToday(['dy_comment']) },
    },
    paused: !!readPause(),
    llmReady: llm.llmReady(cfg),
  };
}
