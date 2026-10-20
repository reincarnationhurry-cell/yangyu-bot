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
import {
  ROOT, SHICHEN, localDate, logAction, todayCounts, addTask, addReview, readReview,
  readConfig, readState, writeState, readActions, readJsonl, appendJsonl, FILES, nowIso, readTasks,
} from './store.mjs';

const TICK_MS = 30_000;
const SRC = 'auto';

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
  if (!cfg.enabled || live.running) return;

  if (gap > 5 * 60_000) {
    logAction({ kind: 'wake', source: SRC, detail: `电脑醒了（睡了约 ${Math.round(gap / 60_000)} 分钟）` });
  }

  const state = readState();
  if (state.cooldownUntil && now < state.cooldownUntil) return;

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

function watchPlan(cfg, duration, { noSkip = false } = {}) {
  const s = cfg.session;
  if (!noSkip && chance(s.skipChance)) return { seconds: Math.min(duration, randInt(6, 25)), skipped: true };
  const ratio = rand(s.watchRatioMin, s.watchRatioMax);
  // 很短的视频往往会看完
  const sec = duration <= 90 && chance(0.7) ? duration : Math.round(duration * ratio);
  return { seconds: Math.max(10, Math.min(sec, s.maxWatchSec, duration)), skipped: false };
}

// ─── 一轮「刷 B站」──────────────────────────────────────────
export async function runSession({ reason = '手动', slotKey, videos } = {}) {
  if (live.running) return { ok: false, summary: '已经在刷了' };
  const cfg = readConfig();
  const state = readState();
  if (state.cooldownUntil && Date.now() < state.cooldownUntil) {
    return { ok: false, summary: '风控冷却中' };
  }
  abortCtl = new AbortController();
  const signal = abortCtl.signal;
  Object.assign(live, { running: true, startedAt: nowIso(), reason, step: '准备', video: null, done: 0, planned: 0 });
  const summary = { watched: 0, liked: 0, shared: 0, coined: 0, commented: 0, queued: 0, seconds: 0 };
  const watchedList = [];

  logAction({ kind: 'session_start', source: SRC, detail: `开始刷B站（${reason}）` });
  try {
    const acct = await bili.getAccountStatus();
    if (!acct.loggedIn) throw new Error('B站未登录（cookie 失效），需要重新扫码');
    const exp = await bili.getExpStatus().catch(() => ({}));

    live.step = '挑视频';
    const pool = videos?.length ? videos : await pickCandidates(cfg, state);
    const n = videos?.length || Math.min(pool.length, randInt(cfg.session.videosMin, cfg.session.videosMax));
    live.planned = n;
    let needShare = cfg.share.daily && !exp.share;
    let lastWatched = null;
    let needCoin = cfg.coin.enabled && !bili.coinLock() && (exp.coinsExp || 0) < cfg.coin.dailyMax * 10 && acct.coins >= 1;

    for (let i = 0; i < n && !signal.aborted; i++) {
      const c = pool[i];
      live.step = '打开视频';
      const v = await bili.browseVideo(c.bvid);
      logAction({ kind: 'view', source: SRC, target: v.bvid, title: v.title, detail: `打开了《${v.title}》· ${v.owner}` });
      await bili.sleep(rand(2000, 6000), signal);

      // 你点名让她看的视频不会被「划走」
      const plan = watchPlan(cfg, v.duration, { noSkip: !!videos?.length });
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
        meta: { played: w.played, duration: v.duration, owner: v.owner },
      });
      appendDiaryFragment({ type: 'watch', bvid: v.bvid, title: v.title });
      state.seen = state.seen || {};
      state.seen[v.bvid] = Date.now();
      if (signal.aborted) break;

      if (!plan.skipped) {
        lastWatched = v;
        const counts = todayCounts();
        // 点赞
        if (chance(cfg.like.chance) && (counts.like || 0) < cfg.like.dailyMax) {
          await bili.sleep(rand(1500, 5000), signal);
          await bili.likeVideo(v.bvid, true);
          summary.liked++;
          logAction({ kind: 'like', source: SRC, target: v.bvid, title: v.title, detail: `给《${v.title}》点了赞` });
          // 投币只投给点过赞的视频
          if (needCoin) {
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
        }
        // 分享（每日 +5 经验），挑一个看完的视频
        if (needShare && chance(0.5)) {
          await bili.sleep(rand(1500, 4000), signal);
          await bili.shareVideo(v.bvid);
          needShare = false;
          summary.shared++;
          logAction({ kind: 'share', source: SRC, target: v.bvid, title: v.title, detail: `分享了《${v.title}》` });
        }
        // 评论
        if (cfg.comment.mode !== 'off' && !v.noReply && chance(cfg.comment.chance)) {
          const r = await maybeComment(cfg, v, w.played);
          if (r === 'posted') summary.commented++;
          if (r === 'queued') summary.queued++;
        }
      }

      live.video = null;
      if (i < n - 1) {
        live.step = '歇一会儿';
        await bili.sleep(rand(cfg.session.gapMinSec, cfg.session.gapMaxSec) * 1000, signal);
      }
      live.done = i + 1;
    }

    // 还没分享过：补分享最后一个认真看了的视频（别分享划走的）
    if (!signal.aborted && needShare && lastWatched) {
      await bili.sleep(rand(1500, 4000), signal);
      await bili.shareVideo(lastWatched.bvid);
      summary.shared++;
      logAction({ kind: 'share', source: SRC, target: lastWatched.bvid, title: lastWatched.title, detail: `分享了《${lastWatched.title}》` });
    }

    // 晚上那一轮顺便处理日记
    if (!signal.aborted && slotKey && slotKey === cfg.diary.window) await maybeDiary(cfg);

    // 合并已看记录，顺手清掉 30 天前的
    const st = readState();
    const cut = Date.now() - 30 * 86400_000;
    st.seen = Object.fromEntries(
      Object.entries({ ...(st.seen || {}), ...state.seen }).filter(([, t]) => t >= cut),
    );
    st.lastRun = { at: nowIso(), reason, summary };
    writeState(st);

    const text = summarize(summary, signal.aborted);
    logAction({ kind: 'session_end', source: SRC, detail: text, meta: summary });
    return { ok: true, summary: text };
  } catch (e) {
    const st = readState();
    if (e.risk) {
      st.cooldownUntil = Date.now() + cfg.cooldownMin * 60_000;
      writeState(st);
      logAction({ kind: 'cooldown', source: SRC, ok: false, error: e.message, detail: `碰到风控（${e.code}），歇 ${cfg.cooldownMin} 分钟` });
    } else {
      logAction({ kind: 'error', source: SRC, ok: false, error: e.message, detail: '这一轮中断了' });
    }
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
  if (s.commented) parts.push(`评论 ${s.commented}`);
  if (s.queued) parts.push(`${s.queued} 条评论待处理`);
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

async function maybeComment(cfg, v, played) {
  if (commentsToday() >= cfg.comment.dailyMax) return null;
  let mode = cfg.comment.mode;
  if (mode === 'llm' && !llm.llmReady()) mode = 'task';

  if (mode === 'task') {
    addTask({
      type: 'comment',
      source: SRC,
      payload: { bvid: v.bvid, title: v.title },
      note: `刚刷到《${v.title}》（${v.bvid}），看完有想说的就去评论一句；没感觉就算了`,
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
  await bili.postComment({ bvid: v.bvid, message: text });
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
