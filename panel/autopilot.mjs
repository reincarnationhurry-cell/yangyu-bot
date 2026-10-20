#!/usr/bin/env node
/**
 * 自动养号（autopilot）
 *
 * 跑在面板进程里（launchd 托管，开机自启）。逻辑：
 *  1. 每天给选中的几个「时辰」各抽一个随机时间点，作为今天的刷 B站 计划；
 *     每个时辰还有一定概率直接跳过 —— 真人不会每天准点打卡。
 *  2. 每 30 秒检查一次：到点了就开一轮「刷 B站」：
 *     挑视频 → 打开详情翻评论 → 用播放心跳真的「看」一段 → 随缘点赞 / 分享 / 评论。
 *  3. 电脑睡着时 setTimeout 不走，醒来后：时辰还没过就补跑，过了就记为「错过」。
 *  4. 碰到风控码（-352/-412/-799…）立即收手，冷却 2 小时。
 *
 * 也可以命令行单独跑一轮：node autopilot.mjs run
 */
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import * as bili from './bili.mjs';
import * as llm from './llm.mjs';
import * as notify from './notify.mjs';
import {
  ROOT, SHICHEN, localDate, logAction, todayCounts, addTask, addReview as addReviewRaw, readReview, updateReview,
  readConfig, readState, writeState, readActions, readJsonl, appendJsonl, FILES, nowIso, readTasks,
  ACTION_NAMES, blockedFor, addBlock, readVip, writeVip, updateTask, addWish,
} from './store.mjs';

const TICK_MS = 30_000;
const SRC = 'auto';

// ─── 待审：进队列的同时在 QQ 里叫号主一声 ─────────────────────
function addReview(x) {
  const r = addReviewRaw(x);
  notify.notifyReview(r).catch(() => {}); // 提醒失败不影响主流程，下次聊天她照样会问
  return r;
}

/** 按 id（或前 6 位）找一条还没处理的待审 */
export function findPendingReview(idOrPrefix) {
  const key = String(idOrPrefix || '').replace(/^#/, '').trim();
  if (!key) return null;
  const hits = readReview().filter((x) => x.status === 'pending' && x.id.startsWith(key));
  if (hits.length > 1) throw new Error(`#${key} 对上了好几条，多给几位`);
  return hits[0] || null;
}

/** 审过了，发出去。面板按钮和 QQ 里的她（review.mjs）共用这一份 */
export async function approveReview(id, newText, by = 'panel') {
  const r = findPendingReview(id);
  if (!r) throw new Error('这条已经处理过了，或者找不到');
  const text = String(newText ?? r.text).trim();
  if (!text) throw new Error('内容是空的');
  const src = by === 'bot' ? 'bot' : 'auto';
  if (r.kind === 'comment') {
    const res = await bili.postComment({ bvid: r.payload.bvid, message: text });
    logAction({ kind: 'comment', source: src, target: r.payload.bvid, title: r.payload.title, detail: text });
    updateReview(r.id, { status: 'posted', text, rpid: res.rpid, by });
    return { kind: r.kind };
  }
  if (r.kind === 'reply') {
    const p = r.payload;
    await bili.postComment({ oid: p.oid, type: p.type, message: text, rootRpid: p.root, parentRpid: p.rpid });
    logAction({ kind: 'reply_comment', source: src, target: p.rpid, title: p.said, detail: text.slice(0, 120) });
    updateReview(r.id, { status: 'posted', text, by });
    return { kind: r.kind };
  }
  if (r.kind === 'diary') {
    const res = await publishDiary(text, src, { force: true });
    updateReview(r.id, { status: 'posted', text, url: res.url, by });
    return { kind: r.kind, url: res.url };
  }
  throw new Error(`不认识的待审类型：${r.kind}`);
}

export function rejectReview(id, by = 'panel') {
  const r = findPendingReview(id);
  if (!r) throw new Error('这条已经处理过了，或者找不到');
  updateReview(r.id, { status: 'rejected', by });
  return { kind: r.kind };
}

// ─── 运行时状态（给面板实时展示）───────────────────────────
const live = {
  running: false,
  startedAt: null,
  reason: '',
  step: '',
  video: null, // { bvid, title, owner, played, target }
  done: 0,
  planned: 0,
};
let abortCtl = null;
let lastTick = Date.now();
let timer = null;

export function liveStatus() {
  return { ...live, video: live.video ? { ...live.video } : null };
}

// ─── 随机工具 ──────────────────────────────────────────────
const rand = (a, b) => a + Math.random() * (b - a);
const randInt = (a, b) => Math.floor(rand(a, b + 1));
const chance = (p) => Math.random() < p;
function weightedPick(weights) {
  const entries = Object.entries(weights).filter(([, w]) => w > 0);
  let r = Math.random() * entries.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of entries) { if ((r -= w) <= 0) return k; }
  return entries[0]?.[0];
}

// ─── 今日计划 ──────────────────────────────────────────────
function windowRange(date, sc) {
  const [y, m, d] = date.split('-').map(Number);
  const start = new Date(y, m - 1, d, sc.start, 0, 0).getTime();
  const end = start + 2 * 3600_000; // 每个时辰 2 小时（子时跨到次日 01:00）
  return { start, end };
}

export function makePlan(date, cfg = readConfig()) {
  const slots = [];
  for (const key of cfg.windows) {
    const sc = SHICHEN.find((s) => s.key === key);
    if (!sc) continue;
    const { start, end } = windowRange(date, sc);
    const skip = !chance(cfg.windowChance);
    // 时间点落在时辰内，留出最后 20 分钟让这一轮刷完
    const at = Math.round(rand(start + 3 * 60_000, end - 20 * 60_000));
    slots.push({ key, label: sc.label, start, end, at, status: skip ? 'skipped' : 'pending' });
  }
  return slots.sort((a, b) => a.start - b.start);
}

function ensurePlan(state, date) {
  if (!state.plans[date]) state.plans[date] = makePlan(date);
  // 时辰已经过完还没跑的（比如总开关关着、电脑睡着），记为错过
  for (const s of state.plans[date]) if (s.status === 'pending' && Date.now() >= s.end) s.status = 'missed';
  // 只留最近 7 天的计划
  for (const d of Object.keys(state.plans).sort().slice(0, -7)) delete state.plans[d];
  return state.plans[date];
}

export function todayPlan() {
  const state = readState();
  const date = localDate();
  const plan = ensurePlan(state, date);
  writeState(state);
  return plan;
}

/** 配置改了（换了时辰）之后，重新抽今天还没到的时间点 */
export function replanToday() {
  const state = readState();
  const date = localDate();
  const old = state.plans[date] || [];
  const fresh = makePlan(date);
  const now = Date.now();
  state.plans[date] = fresh.map((s) => {
    const prev = old.find((o) => o.key === s.key);
    if (prev && (prev.status !== 'pending' || prev.end < now)) return prev; // 已发生的不改
    if (s.end < now) return { ...s, status: 'missed' };
    if (s.at < now) s.at = Math.round(rand(now + 60_000, Math.max(now + 120_000, s.end - 20 * 60_000)));
    return s;
  });
  writeState(state);
  return state.plans[date];
}

// ─── 调度循环 ──────────────────────────────────────────────
export function startScheduler() {
  if (timer) return;
  timer = setInterval(() => tick().catch((e) => console.error('[autopilot]', e)), TICK_MS);
  setTimeout(() => tick().catch(() => {}), 5000);
  console.log('[autopilot] 调度器已启动');
}

async function tick() {
  const now = Date.now();
  const gap = now - lastTick;
  lastTick = now;
  const cfg = readConfig();
  // 排队的 QQ 提醒：你一开口就补上（不受自动养号开关影响）
  notify.flushPending(readReview).catch(() => {});
  if (!cfg.enabled || live.running) return;

  if (gap > 5 * 60_000) {
    logAction({ kind: 'wake', source: SRC, detail: `电脑醒了（睡了约 ${Math.round(gap / 60_000)} 分钟）` });
  }

  const state = readState();
  if (state.cooldownUntil && now < state.cooldownUntil) return;

  // 特别关注：定期看一眼关注动态；有新视频且是「尽快」模式，就抽个几分钟后的时间去看
  if (cfg.vip.enabled && cfg.vip.users.length) {
    try {
      await checkVip();
    } catch (e) {
      if (e.risk) { enterCooldown(cfg, e); return; }
      console.error('[autopilot] 特别关注检查失败', e.message);
    }
    const vip = readVip();
    const hasWork = vipPending(cfg, vip).length > 0 || vip.queue.some((q) => q.type === 'dyn' && cfg.vip.users.some((u) => u.uid === q.uid));
    if (!hasWork || !cfg.vip.asap || isQuiet(cfg, now)) {
      if (vip.runAt) { vip.runAt = null; writeVip(vip); }
    } else if (!vip.runAt) {
      vip.runAt = now + rand(3, 15) * 60_000; // 刷到推送也不会秒点进去
      writeVip(vip);
    } else if (now >= vip.runAt) {
      vip.runAt = null;
      writeVip(vip);
      await runSession({ reason: '特别关注更新了', vipOnly: true });
      return;
    }
  }

  // 昨天的子时会跨到今天凌晨，所以两天都看
  const dates = [localDate(new Date(now - 86400_000)), localDate(new Date(now))];
  ensurePlan(state, dates[1]);
  let due = null;
  for (const d of dates) {
    for (const s of state.plans[d] || []) {
      if (s.status !== 'pending') continue;
      if (now >= s.end) { s.status = 'missed'; continue; }
      if (now >= s.at && !due) due = { date: d, slot: s };
    }
  }
  writeState(state);
  if (!due) return;

  due.slot.status = 'running';
  writeState(state);
  const result = await runSession({ reason: `${due.slot.label} 定时`, slotKey: due.slot.key });
  const st2 = readState();
  const s2 = (st2.plans[due.date] || []).find((x) => x.key === due.slot.key);
  if (s2) { s2.status = result.ok ? 'done' : 'failed'; s2.ranAt = Date.now(); s2.summary = result.summary; }
  writeState(st2);
}

export function stopSession() {
  if (abortCtl) abortCtl.abort();
}

// ─── 挑视频 ────────────────────────────────────────────────
async function pickCandidates(cfg, state) {
  const s = cfg.session;
  const tried = new Set();
  const out = [];
  const seen = state.seen || {};
  for (let i = 0; i < 3 && out.length < s.videosMax * 2; i++) {
    const src = weightedPick(s.sourceWeights);
    if (tried.has(src) && src !== 'interest') continue;
    tried.add(src);
    let list = [];
    try {
      if (src === 'feed') list = await bili.feedVideos(12);
      else if (src === 'hot') list = await bili.hotVideos(30);
      else {
        const kw = cfg.interests[randInt(0, cfg.interests.length - 1)];
        if (!kw) continue;
        live.step = `搜「${kw}」`;
        list = await bili.searchVideo(kw, chance(0.6) ? 'totalrank' : 'pubdate');
        logAction({ kind: 'search', source: SRC, target: kw, detail: `搜「${kw}」，${list.length} 条` });
      }
    } catch (e) {
      if (e.risk) throw e;
      continue;
    }
    for (const v of list) {
      const dur = Number(v.durationSec || 0);
      if (!v.bvid || seen[v.bvid] || out.some((o) => o.bvid === v.bvid)) continue;
      if (dur && (dur < 20 || dur > s.maxDurationSec)) continue;
      out.push({ ...v, src });
    }
    await bili.sleep(rand(1500, 4000));
  }
  // 打散，别总按接口顺序看
  return out.sort(() => Math.random() - 0.5);
}

function watchPlan(cfg, duration, { noSkip = false, vip = false } = {}) {
  const s = cfg.session;
  if (vip) {
    // 特别关注的视频认真看：75%~100%，短的基本看完
    const sec = duration <= 180 ? duration : Math.round(duration * rand(0.75, 1));
    return { seconds: Math.max(10, Math.min(sec, cfg.vip.maxWatchSec, duration)), skipped: false };
  }
  if (!noSkip && chance(s.skipChance)) return { seconds: Math.min(duration, randInt(6, 25)), skipped: true };
  const ratio = rand(s.watchRatioMin, s.watchRatioMax);
  // 很短的视频往往会看完
  const sec = duration <= 90 && chance(0.7) ? duration : Math.round(duration * ratio);
  return { seconds: Math.max(10, Math.min(sec, s.maxWatchSec, duration)), skipped: false };
}

// ─── 写动作的保险丝 ────────────────────────────────────────
// 被熔断的动作直接跳过；被 B站 拒了就记一笔、熔断这个动作，但这一轮接着看视频。
// 风控码（-352/-412…）照样往外抛，让整轮停下来冷却。
async function tryAction(kind, v, fn, summary) {
  const name = ACTION_NAMES[kind] || kind;
  if (blockedFor(kind)) {
    if (summary) (summary.paused ||= new Set()).add(name);
    // 接口被拦的点赞 / 分享：记进清单，号主在自己浏览器里顺手点掉
    if ((kind === 'like' || kind === 'share') && v?.bvid) addWish({ kind, bvid: v.bvid, title: v.title, owner: v.owner });
    return { ok: false, blocked: true };
  }
  try {
    return { ok: true, result: await fn() };
  } catch (e) {
    if (!(e instanceof bili.BiliError)) {
      // 网络抖动之类，不算 B站 拒绝，不熔断
      logAction({ kind, source: SRC, ok: false, target: v?.bvid || '', title: v?.title || '', error: e.message, detail: `${name}没成功（网络问题）` });
      return { ok: false };
    }
    const b = addBlock(kind, { code: e.code, error: e.message });
    if ((kind === 'like' || kind === 'share') && v?.bvid) addWish({ kind, bvid: v.bvid, title: v.title, owner: v.owner });
    const hours = Math.round((b.until - Date.now()) / 3600_000);
    let note = '';
    if (kind === 'like' && v?.bvid) {
      // 有时接口报错但其实点上了，核对一下，省得你以为没点
      if (await bili.hasLiked(v.bvid).catch(() => false)) note = '（核对了一下，B站那边其实点上了）';
    }
    logAction({
      kind, source: SRC, ok: false, target: v?.bvid || '', title: v?.title || '', error: e.message,
      detail: `${name}被 B站 拒了，先停 ${hours} 小时不${name}${note}`,
    });
    if (e.risk || e.code === -101) throw e;
    return { ok: false };
  }
}

function enterCooldown(cfg, e) {
  const st = readState();
  st.cooldownUntil = Date.now() + cfg.cooldownMin * 60_000;
  writeState(st);
  logAction({ kind: 'cooldown', source: SRC, ok: false, error: e.message, detail: `碰到风控（${e.code}），歇 ${cfg.cooldownMin} 分钟` });
}

function isQuiet(cfg, now = Date.now()) {
  const h = new Date(now).getHours();
  const { quietStart: a, quietEnd: b } = cfg.vip;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

// ─── 特别关注 ──────────────────────────────────────────────
// 动态流 feed/all 一次拿到所有关注的人的新动态，只挑特别关注的人：
//  - 发了视频 → 排进队列，下一轮（尽快模式下几分钟后）优先看，点赞、收藏、投币、评论；
//  - 发了图文/文字动态 → 顺手点个赞，再去看看 TA 最近一个没看过的视频。
function vipPending(cfg, vip = readVip()) {
  const today = localDate();
  const left = Math.max(0, cfg.vip.dailyMax - (vip.done?.[today] || 0));
  const seen = readState().seen || {};
  const uids = new Set(cfg.vip.users.map((u) => String(u.uid)));
  return vip.queue.filter((q) => q.type === 'video' && uids.has(q.uid) && !seen[q.bvid]).slice(0, left);
}

function dropFromVipQueue(key, { countDone = false } = {}) {
  const vip = readVip();
  vip.queue = vip.queue.filter((q) => (q.bvid || q.dynId) !== key);
  if (countDone) {
    const today = localDate();
    vip.done = { ...(vip.done || {}), [today]: (vip.done?.[today] || 0) + 1 };
  }
  writeVip(vip);
}

export function vipView() {
  const cfg = readConfig();
  const vip = readVip();
  return {
    config: cfg.vip,
    queue: vip.queue,
    pending: vipPending(cfg, vip).length,
    doneToday: vip.done?.[localDate()] || 0,
    lastCheck: vip.lastCheck || null,
    nextCheck: vip.nextCheck || null,
    runAt: vip.runAt || null,
    autopilotOn: cfg.enabled,
  };
}

export async function checkVip({ force = false } = {}) {
  const cfg = readConfig();
  const vip = readVip();
  const now = Date.now();
  if (!force && now < (vip.nextCheck || 0)) return { checked: false, found: 0 };
  // 先把下次检查时间写好：这次失败了也不会每 30 秒狂查
  vip.lastCheck = now;
  vip.nextCheck = now + cfg.vip.checkMin * rand(0.7, 1.3) * 60_000;
  writeVip(vip);

  const users = new Map(cfg.vip.users.map((u) => [String(u.uid), u]));
  if (!users.size) return { checked: true, found: 0 };

  const { items } = await bili.followFeed({ type: 'all' });
  const maxAge = cfg.vip.maxAgeHours * 3600_000;
  const seen = readState().seen || {};
  const keys = new Set(vip.queue.map((q) => q.bvid || q.dynId));
  let videoFeed = null;
  let found = 0;
  const push = (q) => {
    const k = q.bvid || q.dynId;
    if (keys.has(k)) return false;
    keys.add(k);
    vip.queue.push({ ...q, addedAt: now });
    return true;
  };

  // 老的在前，按时间顺序排进队列
  for (const it of [...items].sort((a, b) => a.ts - b.ts)) {
    const u = users.get(it.uid);
    if (!u || vip.handled[it.id] || now - it.ts > maxAge) continue;
    vip.handled[it.id] = { t: now, uid: it.uid };
    const name = it.name || u.name || it.uid;
    if (it.kind === 'video' && it.video) {
      if (seen[it.video.bvid]) continue;
      if (push({ type: 'video', bvid: it.video.bvid, title: it.video.title, uid: it.uid, name, ts: it.ts, why: '新视频' })) {
        found++;
        logAction({ kind: 'vip_new', source: SRC, target: it.video.bvid, title: it.video.title, detail: `特别关注「${name}」发了新视频《${it.video.title}》` });
      }
      continue;
    }
    if (it.kind === 'live') continue;
    found++;
    logAction({ kind: 'vip_new', source: SRC, target: it.id, detail: `特别关注「${name}」发了条动态：${it.text.slice(0, 40) || '（图片）'}` });
    if (cfg.vip.likeDynamic && !it.liked) push({ type: 'dyn', dynId: it.id, uid: it.uid, name, text: it.text.slice(0, 60), ts: it.ts });
    // 看到动态，顺路去 TA 那儿看一个最近没看过的视频
    videoFeed ??= await bili.followFeed({ type: 'video' }).then((r) => r.items).catch(() => []);
    const latest = [...items, ...videoFeed]
      .filter((x) => x.uid === it.uid && x.video && !seen[x.video.bvid] && !keys.has(x.video.bvid) && now - x.ts < 30 * 86400_000)
      .sort((a, b) => b.ts - a.ts)[0];
    if (latest) push({ type: 'video', bvid: latest.video.bvid, title: latest.video.title, uid: it.uid, name, ts: latest.ts, why: '看到动态顺路看' });
  }

  // 队列别无限长；已处理记录留 30 天
  vip.queue = vip.queue.slice(-12);
  const cut = now - 30 * 86400_000;
  vip.handled = Object.fromEntries(Object.entries(vip.handled).filter(([, h]) => (h.t ?? h) >= cut));
  vip.done = Object.fromEntries(Object.entries(vip.done || {}).sort().slice(-7));
  writeVip({ ...readVip(), lastCheck: vip.lastCheck, nextCheck: vip.nextCheck, queue: vip.queue, handled: vip.handled, done: vip.done });
  return { checked: true, found };
}

async function likeVipDynamics(cfg, signal) {
  const uids = new Set(cfg.vip.users.map((u) => String(u.uid)));
  const dyns = readVip().queue.filter((q) => q.type === 'dyn' && uids.has(q.uid));
  for (const d of dyns) {
    if (signal.aborted) return;
    live.step = `给「${d.name}」的动态点赞`;
    await bili.sleep(rand(2000, 6000), signal);
    const r = await tryAction('dyn_like', { title: d.text }, () => bili.likeDynamic(d.dynId));
    if (r.blocked) return; // 熔断中就留着，等恢复了再点
    dropFromVipQueue(d.dynId);
    if (r.ok) logAction({ kind: 'dyn_like', source: SRC, target: d.dynId, title: d.text, detail: `给「${d.name}」的动态点了赞` });
  }
}

// ─── 一轮「刷 B站」──────────────────────────────────────────
// 派活的计划字段：true = 每个都做，false = 不做，数字 = 概率，undefined = 照平时的随缘
const want = (v, fallback) => (v === true || v === false ? v : typeof v === 'number' ? chance(v) : fallback);

async function directivePool(cfg, state, d) {
  const seen = state.seen || {};
  const out = [];
  for (const kw of d.keywords || []) {
    live.step = `搜「${kw}」`;
    let list = [];
    try {
      list = await bili.searchVideo(kw, chance(0.6) ? 'totalrank' : 'pubdate');
    } catch (e) {
      if (e.risk) throw e;
      continue;
    }
    logAction({ kind: 'search', source: SRC, target: kw, detail: `搜「${kw}」，${list.length} 条` });
    const ok = list.filter((v) => v.bvid && !seen[v.bvid] && !out.some((o) => o.bvid === v.bvid) &&
      (!v.durationSec || (v.durationSec >= 20 && v.durationSec <= cfg.session.maxDurationSec)));
    // 搜索结果前排里随机挑，别总点第一个
    out.push(...ok.slice(0, 8).sort(() => Math.random() - 0.5));
    await bili.sleep(rand(1500, 4000));
  }
  if (out.length) return out;
  return pickCandidates(cfg, state);
}

export async function runSession({ reason = '手动', slotKey, videos, vipOnly = false, directive = null } = {}) {
  if (live.running) return { ok: false, summary: '已经在刷了' };
  const cfg = readConfig();
  const state = readState();
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    return { ok: false, summary: '风控冷却中' };
  }
  abortCtl = new AbortController();
  const signal = abortCtl.signal;
  Object.assign(live, { running: true, startedAt: nowIso(), reason, step: '准备', video: null, done: 0, planned: 0 });
  const summary = { watched: 0, liked: 0, shared: 0, coined: 0, favored: 0, commented: 0, queued: 0, seconds: 0 };
  const watchedList = [];

  logAction({ kind: 'session_start', source: SRC, detail: `开始刷B站（${reason}）` });
  try {
    const acct = await bili.getAccountStatus();
    if (!acct.loggedIn) throw new Error('B站未登录（cookie 失效），需要重新扫码');
    const exp = await bili.getExpStatus().catch(() => ({}));

    // 特别关注的人先看（你点名的视频除外）
    const useVip = !videos?.length && !directive && cfg.vip.enabled;
    if (useVip) await likeVipDynamics(cfg, signal);
    const vipList = useVip
      ? vipPending(cfg).map((q) => ({ bvid: q.bvid, title: q.title, vip: true, vipName: q.name }))
      : [];

    live.step = '挑视频';
    let pool;
    let n;
    if (videos?.length) {
      pool = videos;
      n = videos.length;
    } else if (directive) {
      pool = await directivePool(cfg, state, directive);
      n = Math.max(1, Math.min(5, Math.round(directive.count || 2)));
    } else if (vipOnly) {
      pool = vipList;
      n = vipList.length;
    } else {
      const extra = await pickCandidates(cfg, state);
      pool = [...vipList, ...extra.filter((x) => !vipList.some((v) => v.bvid === x.bvid))];
      n = vipList.length + Math.min(extra.length, randInt(cfg.session.videosMin, cfg.session.videosMax));
    }
    n = Math.min(n, pool.length);
    live.planned = n;
    const hasVip = pool.slice(0, n).some((c) => c.vip);
    let needShare = cfg.share.daily && !exp.share;
    let lastWatched = null;
    let needCoin = cfg.coin.enabled && !bili.coinLock() && (exp.coinsExp || 0) < cfg.coin.dailyMax * 10 && acct.coins >= 1;

    for (let i = 0; i < n && !signal.aborted; i++) {
      const c = pool[i];
      const vipCfg = c.vip ? cfg.vip : null;
      live.step = c.vip ? `去看「${c.vipName}」的新视频` : '打开视频';
      let v;
      try {
        v = await bili.browseVideo(c.bvid);
      } catch (e) {
        if (e.risk || e.code === -101) throw e;
        // 视频被删了、设了权限之类：跳过这个，别让整轮挂掉
        logAction({ kind: 'error', source: SRC, ok: false, target: c.bvid, title: c.title || '', error: e.message, detail: '这个视频打不开，跳过' });
        if (c.vip) dropFromVipQueue(c.bvid);
        continue;
      }
      logAction({ kind: 'view', source: SRC, target: v.bvid, title: v.title, detail: `${c.vip ? '⭐ ' : ''}打开了《${v.title}》· ${v.owner}` });
      await bili.sleep(rand(2000, 6000), signal);

      // 你点名让她看的视频不会被「划走」；特别关注的认真看
      const plan = watchPlan(cfg, v.duration, { noSkip: !!videos?.length || !!directive, vip: !!c.vip });
      live.step = plan.skipped ? '扫一眼' : '看视频';
      live.video = { bvid: v.bvid, title: v.title, owner: v.owner, pic: v.pic, played: 0, target: plan.seconds };
      const w = await bili.watchVideo(v.bvid, {
        seconds: plan.seconds,
        signal,
        onTick: (p) => { if (live.video) live.video.played = p; },
      });
      summary.watched++;
      summary.seconds += w.played;
      watchedList.push({ bvid: v.bvid, title: v.title, owner: v.owner });
      logAction({
        kind: 'watch', source: SRC, target: v.bvid, title: v.title,
        detail: `${plan.skipped ? '划走了' : '看了'}《${v.title}》${fmtSec(w.played)} / ${fmtSec(v.duration)}`,
        meta: { played: w.played, duration: v.duration, owner: v.owner, vip: !!c.vip },
      });
      appendDiaryFragment({ type: 'watch', bvid: v.bvid, title: v.title });
      state.seen = state.seen || {};
      state.seen[v.bvid] = Date.now();
      if (signal.aborted) break;

      if (!plan.skipped) {
        lastWatched = v;
        const counts = todayCounts();
        // 点赞：特别关注的必点，其他随缘
        let liked = false;
        if ((vipCfg ? vipCfg.like : want(directive?.like, chance(cfg.like.chance))) && (counts.like || 0) < cfg.like.dailyMax) {
          await bili.sleep(rand(1500, 5000), signal);
          const r = await tryAction('like', v, () => bili.likeVideo(v.bvid, true), summary);
          if (r.ok) {
            liked = true;
            summary.liked++;
            logAction({ kind: 'like', source: SRC, target: v.bvid, title: v.title, detail: `给《${v.title}》点了赞` });
          }
        }
        // 投币只投给点过赞的视频；这一轮有特别关注的，币留给 TA
        if (liked && needCoin && (c.vip ? vipCfg.coin : !hasVip)) {
          try {
            await bili.sleep(rand(2000, 5000), signal);
            await bili.coinVideo(v.bvid, 1);
            summary.coined++;
            needCoin = false;
            logAction({ kind: 'coin', source: SRC, target: v.bvid, title: v.title, detail: `给《${v.title}》投了 1 个币` });
          } catch (e) {
            needCoin = false; // bili.coinVideo 失败时已永久上锁，之后再也不会自动投
            logAction({ kind: 'coin', source: SRC, ok: false, target: v.bvid, error: e.message, detail: '投币失败，已锁定投币，需手动解锁' });
            if (e.risk) throw e;
          }
        }
        // 收藏：只给特别关注的
        if (vipCfg?.favorite || directive?.favorite === true) {
          await bili.sleep(rand(1500, 4000), signal);
          const r = await tryAction('favorite', v, () => bili.favoriteVideo(v.bvid), summary);
          if (r.ok && !r.result.already) {
            summary.favored++;
            logAction({ kind: 'favorite', source: SRC, target: v.bvid, title: v.title, detail: `收藏了《${v.title}》` });
          }
        }
        // 分享（每日 +5 经验）：有特别关注的就分享 TA 的
        const shareNow = directive?.share === true || (directive?.share !== false && needShare && (c.vip || (!hasVip && chance(0.5))));
        if (shareNow) {
          await bili.sleep(rand(1500, 4000), signal);
          const r = await tryAction('share', v, () => bili.shareVideo(v.bvid), summary);
          needShare = false;
          if (r.ok) {
            summary.shared++;
            logAction({ kind: 'share', source: SRC, target: v.bvid, title: v.title, detail: `分享了《${v.title}》` });
          }
        }
        // 评论
        if (cfg.comment.mode !== 'off' && !v.noReply && want(directive?.comment, vipCfg ? vipCfg.comment : chance(cfg.comment.chance))) {
          const r = await maybeComment(cfg, v, w.played, { vipName: c.vip ? c.vipName : null });
          if (r === 'posted') summary.commented++;
          if (r === 'queued') summary.queued++;
        }
      }
      if (c.vip) dropFromVipQueue(c.bvid, { countDone: true });

      live.video = null;
      if (i < n - 1) {
        live.step = '歇一会儿';
        await bili.sleep(rand(cfg.session.gapMinSec, cfg.session.gapMaxSec) * 1000, signal);
      }
      live.done = i + 1;
    }

    // 还没分享过：补分享最后一个认真看了的视频（别分享划走的）
    if (!signal.aborted && needShare && lastWatched && directive?.share !== false) {
      await bili.sleep(rand(1500, 4000), signal);
      const r = await tryAction('share', lastWatched, () => bili.shareVideo(lastWatched.bvid), summary);
      if (r.ok) {
        summary.shared++;
        logAction({ kind: 'share', source: SRC, target: lastWatched.bvid, title: lastWatched.title, detail: `分享了《${lastWatched.title}》` });
      }
    }

    // 晚上那一轮顺便处理日记
    if (!signal.aborted && slotKey && slotKey === cfg.diary.window) await maybeDiary(cfg);

    // 合并已看记录，顺手清掉 30 天前的
    const st = readState();
    const cut = Date.now() - 30 * 86400_000;
    st.seen = Object.fromEntries(
      Object.entries({ ...(st.seen || {}), ...state.seen }).filter(([, t]) => t >= cut),
    );
    summary.paused = summary.paused ? [...summary.paused] : [];
    st.lastRun = { at: nowIso(), reason, summary };
    writeState(st);

    const text = summarize(summary, signal.aborted);
    logAction({ kind: 'session_end', source: SRC, detail: text, meta: summary });
    return { ok: true, summary: text };
  } catch (e) {
    if (e.risk) enterCooldown(cfg, e);
    else logAction({ kind: 'error', source: SRC, ok: false, error: e.message, detail: '这一轮中断了' });
    return { ok: false, summary: e.message };
  } finally {
    Object.assign(live, { running: false, step: '', video: null });
    abortCtl = null;
  }
}

function fmtSec(s) {
  s = Math.round(s || 0);
  return s >= 60 ? `${Math.floor(s / 60)}分${String(s % 60).padStart(2, '0')}秒` : `${s}秒`;
}

function summarize(s, aborted) {
  const parts = [`看了 ${s.watched} 个视频（共 ${fmtSec(s.seconds)}）`];
  if (s.liked) parts.push(`点赞 ${s.liked}`);
  if (s.shared) parts.push('分享 1');
  if (s.coined) parts.push(`投币 ${s.coined}`);
  if (s.favored) parts.push(`收藏 ${s.favored}`);
  if (s.commented) parts.push(`评论 ${s.commented}`);
  if (s.queued) parts.push(`${s.queued} 条评论待处理`);
  if (s.paused?.length) parts.push(`${s.paused.join('、')}暂停中没做`);
  return (aborted ? '被叫停：' : '') + parts.join('，');
}

// ─── 评论：AI 起草 → 待审 / 直接发；或交给 QQ 里的她 ───────
function commentsToday() {
  const today = localDate();
  const posted = todayCounts().comment || 0;
  const queued = readReview().filter((r) => r.kind === 'comment' && localDate(new Date(r.ts)) === today).length;
  const tasks = readTasks().filter((t) => t.type === 'comment' && t.source === SRC && localDate(new Date(t.ts)) === today).length;
  return posted + queued + tasks;
}

async function maybeComment(cfg, v, played, { vipName = null } = {}) {
  if (commentsToday() >= cfg.comment.dailyMax) return null;
  let mode = cfg.comment.mode;
  if (mode === 'llm' && !llm.llmReady()) mode = 'task';

  if (mode === 'task') {
    addTask({
      type: 'comment',
      source: SRC,
      payload: { bvid: v.bvid, title: v.title },
      note: vipName
        ? `你特别关注的「${vipName}」发了新视频《${v.title}》（${v.bvid}），已经看过、点了赞，去评论区说两句真心话吧`
        : `刚刷到《${v.title}》（${v.bvid}），看完有想说的就去评论一句；没感觉就算了`,
    });
    return 'queued';
  }
  live.step = '想想说点什么';
  let text;
  try {
    text = await llm.draftComment(v, { watchedSec: played });
  } catch (e) {
    logAction({ kind: 'error', source: SRC, ok: false, error: e.message, detail: 'AI 起草评论失败' });
    return null;
  }
  if (!text) return null;
  if (cfg.comment.review) {
    addReview({ kind: 'comment', text, payload: { bvid: v.bvid, title: v.title, owner: v.owner } });
    logAction({ kind: 'draft', source: SRC, target: v.bvid, title: v.title, detail: `给《${v.title}》起草了评论，等你审` });
    return 'queued';
  }
  await bili.sleep(rand(8000, 20000)); // 打字也要时间
  const r = await tryAction('comment', v, () => bili.postComment({ bvid: v.bvid, message: text }));
  if (!r.ok) return null;
  logAction({ kind: 'comment', source: SRC, target: v.bvid, title: v.title, detail: text });
  return 'posted';
}

// ─── 日记 ──────────────────────────────────────────────────
function diaryPublishedToday() {
  const today = localDate();
  return readJsonl(FILES.diary).some((e) => e.type === 'published' && e.date === today);
}

async function maybeDiary(cfg) {
  if (cfg.diary.mode === 'off' || diaryPublishedToday()) return;
  const today = localDate();
  if (readReview().some((r) => r.kind === 'diary' && r.status === 'pending' && localDate(new Date(r.ts)) === today)) return;
  if (readTasks().some((t) => t.type === 'diary' && t.status === 'pending')) return;

  const watched = readActions()
    .filter((a) => a.kind === 'watch' && a.ok && localDate(new Date(a.ts)) === today)
    .map((a) => ({ title: a.title, owner: a.meta?.owner }));
  if (watched.length === 0) return;

  let mode = cfg.diary.mode;
  if (mode === 'llm' && !llm.llmReady()) mode = 'task';
  if (mode === 'task') {
    addTask({ type: 'diary', source: SRC, note: '今天刷了不少，有想写的就写进养鱼日记发条动态；没想法就不发' });
    return;
  }
  live.step = '写日记';
  const text = await llm.draftDiary(watched).catch((e) => {
    logAction({ kind: 'error', source: SRC, ok: false, error: e.message, detail: 'AI 起草日记失败' });
    return null;
  });
  if (!text) return;
  if (cfg.diary.review) {
    addReview({ kind: 'diary', text, payload: { date: today } });
    logAction({ kind: 'draft', source: SRC, detail: '起草了今天的养鱼日记，等你审' });
  } else {
    await publishDiary(text, SRC);
  }
}

function appendDiaryFragment(e) {
  try {
    appendJsonl(FILES.diary, { ts: nowIso(), date: localDate(), keyword: null, summary: null, thought: null, text: null, ...e });
  } catch { /* 日记碎片写不进去不影响主流程 */ }
}

/** 发日记：复用 diary.mjs（write 记正文 + publish 发动态），保持只有一套发布实现 */
export function publishDiary(text, source = 'panel', { force = false } = {}) {
  const dir = join(ROOT, 'diary');
  const run = (args) =>
    new Promise((resolve, reject) => {
      const p = spawn(process.execPath, ['diary.mjs', ...args], { cwd: dir });
      let out = '';
      p.stdout.on('data', (d) => (out += d));
      p.stderr.on('data', (d) => (out += d));
      p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(out.trim().split('\n').pop() || `退出码 ${code}`))));
    });
  return run(['write', text])
    .then(() => run(force ? ['publish', '--force'] : ['publish']))
    .then((out) => {
      const url = (out.match(/https:\/\/t\.bilibili\.com\/\d+/) || [])[0] || '';
      logAction({ kind: 'diary', source, target: url, detail: text.slice(0, 80) });
      return { ok: true, url };
    });
}

// ─── CLI ───────────────────────────────────────────────────
if (import.meta.url === `file://${process.argv[1]}`) {
  const cmd = process.argv[2];
  if (cmd === 'run') {
    const r = await runSession({ reason: '命令行' });
    console.log(r.ok ? '✓ ' : '✗ ', r.summary);
  } else if (cmd === 'plan') {
    for (const s of todayPlan()) {
      console.log(`${s.label}  ${new Date(s.at).toLocaleTimeString('zh-CN')}  ${s.status}`);
    }
  } else {
    console.log('用法：node autopilot.mjs run   立刻刷一轮\n      node autopilot.mjs plan  看今天的计划');
  }
}


// ─── 派活：面板直接去做，不用等 QQ 里的她 ───────────────────
const PRESETS = {
  browse: () => ({ count: randInt(2, 4) }),
  browse_like: () => ({ count: 3, like: 0.7 }),
  comment: () => ({ count: 2, comment: true }),
};

/** 今天看过的视频 → AI 起草日记 → 进待审（动态是公开的，一律先审） */
async function diaryNow() {
  if (!llm.llmReady()) throw new Error('没配模型，写日记只能交给 QQ 里的她');
  const today = localDate();
  const watched = readActions()
    .filter((a) => a.kind === 'watch' && a.ok && localDate(new Date(a.ts)) === today)
    .map((a) => ({ title: a.title, owner: a.meta?.owner }));
  if (!watched.length) return '今天还没看过视频，没东西可写';
  live.step = '写日记';
  const text = await llm.draftDiary(watched);
  if (!text) return '她看了看今天刷的，觉得没什么想写的';
  addReview({ kind: 'diary', text, payload: { date: today } });
  logAction({ kind: 'draft', source: SRC, detail: '起草了今天的养鱼日记，等你审' });
  return '日记起草好了，在「待审」里';
}

/** 看新回复 / @ → AI 起草回复进待审；私信只报数，不替你回 */
async function inboxNow() {
  const [replies, ats, unread] = await Promise.all([
    bili.replyFeed().catch(() => []),
    bili.atFeed().catch(() => []),
    bili.unreadCounts().catch(() => null),
  ]);
  const since = Date.now() / 1000 - 3 * 86400;
  const drafted = new Set(readReview().filter((r) => r.kind === 'reply').map((r) => r.payload?.rpid));
  const todo = [...replies, ...ats].filter((x) => x.time >= since && x.rpid && x.text && !drafted.has(x.rpid)).slice(0, 3);
  const dm = unread?.dm || 0;
  const tail = dm ? `；私信有 ${dm} 条未读，去「消息」里看` : '';
  if (!todo.length) return `没有要回的新评论${tail}`;
  if (!llm.llmReady()) return `有 ${todo.length} 条新回复/@，没配模型起草不了，去「消息」里回${tail}`;
  let n = 0;
  for (const x of todo) {
    const text = await llm.draftReply({ context: x.title ? `《${x.title}》` : '', message: x.text, kind: 'comment' }).catch(() => null);
    if (!text) continue;
    addReview({
      kind: 'reply', text,
      payload: { oid: x.oid, type: x.type, root: x.root, rpid: x.rpid, user: x.user, said: x.text.slice(0, 120), title: x.title },
    });
    n++;
  }
  return `看了 ${todo.length} 条新回复/@，起草了 ${n} 条回复，在「待审」里${tail}`;
}

export async function runTask(task) {
  updateTask(task.id, { status: 'in_progress', claimedAt: nowIso(), executor: 'panel' });
  let plan = null;
  try {
    if (live.running) {
      updateTask(task.id, { resultNote: '她正在刷，这轮完了就去' });
      while (live.running) await bili.sleep(10_000);
    }
    let note;
    let ok = true;
    if (task.type === 'diary') note = await diaryNow();
    else if (task.type === 'check') note = await inboxNow();
    else {
      plan = PRESETS[task.type]?.() || (await llm.parseTask(task.note));
      const short = (task.note || task.type).slice(0, 20);
      const r = await runSession({ reason: `派活：${short}`, directive: plan });
      ok = r.ok;
      note = r.summary;
    }
    updateTask(task.id, { status: ok ? 'done' : 'failed', doneAt: nowIso(), resultNote: note, plan });
    logAction({ kind: ok ? 'task_done' : 'error', source: SRC, ok, target: task.type, detail: `派的活：${task.note || task.type} → ${note}` });
  } catch (e) {
    updateTask(task.id, { status: 'failed', doneAt: nowIso(), resultNote: e.message, plan });
    logAction({ kind: 'error', source: SRC, ok: false, error: e.message, detail: `派的活没做成：${task.note || task.type}` });
  }
}
