/**
 * B站操作库
 *
 * 面板、自动养号（autopilot）和机器人都走这里，避免几套实现分叉。
 * 所有写操作都要 Cookie（bilibili-mcp/login/cookie.json）。
 *
 * 踩过的坑都在注释里标了，改之前先看。
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const PKG = join(ROOT, 'bilibili-mcp', 'node_modules', 'bilibili-mcp-server', 'dist');
const DEVICE_FILE = join(here, 'data', 'device.json');

export const COOKIE_FILE =
  process.env.BILIBILI_COOKIE_FILE || join(ROOT, 'bilibili-mcp', 'login', 'cookie.json');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** B站风控类错误码：遇到就该停手歇一会儿，而不是重试 */
export const RISK_CODES = new Set([-352, -412, -509, -799, 412]);

export class BiliError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
    this.risk = RISK_CODES.has(Number(code));
  }
}

// ─── 凭证 ──────────────────────────────────────────────────
export function loadCookie() {
  if (!existsSync(COOKIE_FILE)) {
    throw new Error(`没有登录凭证：${COOKIE_FILE}。先扫码登录 B站。`);
  }
  const ck = JSON.parse(readFileSync(COOKIE_FILE, 'utf-8'));
  if (!ck.sessdata) throw new Error('凭证缺 sessdata');
  return ck;
}

export function isLoggedIn() {
  try {
    return !!loadCookie().sessdata;
  } catch {
    return false;
  }
}

// ─── 设备指纹（buvid3 / buvid4 / b_nut）────────────────────
// 坑：真浏览器的每个请求都带 buvid3。只带 SESSDATA 的请求在风控眼里
// 就是「没有设备的登录态」，是 -352 / -412 / 「账号异常」的常见诱因。
// 这里向 B站要一对 buvid，落盘后长期复用 —— 真人的浏览器也不会每天换设备。
let _device = null;
export async function getDevice() {
  if (_device) return _device;
  if (existsSync(DEVICE_FILE)) {
    try {
      _device = JSON.parse(readFileSync(DEVICE_FILE, 'utf-8'));
      if (_device.buvid3) return _device;
    } catch { /* 坏文件就重新要 */ }
  }
  const r = await fetch('https://api.bilibili.com/x/frontend/finger/spi', {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' },
    signal: AbortSignal.timeout(10000),
  }).then((x) => x.json());
  if (r.code !== 0 || !r.data?.b_3) throw new Error('取设备标识（buvid）失败');
  _device = {
    buvid3: r.data.b_3,
    buvid4: r.data.b_4,
    b_nut: String(Math.floor(Date.now() / 1000)),
    createdAt: new Date().toISOString(),
  };
  mkdirSync(dirname(DEVICE_FILE), { recursive: true });
  writeFileSync(DEVICE_FILE, JSON.stringify(_device, null, 2), { mode: 0o600 });
  return _device;
}

async function cookieHeader(ck) {
  const parts = [`SESSDATA=${ck.sessdata}`, `bili_jct=${ck.bili_jct || ''}`];
  if (ck.dede_user_id) parts.push(`DedeUserID=${ck.dede_user_id}`);
  for (const [k, v] of Object.entries(ck.extra || {})) if (/^[\w]+$/.test(k) && v) parts.push(`${k}=${v}`);
  try {
    const d = await getDevice();
    parts.push(`buvid3=${d.buvid3}`, `b_nut=${d.b_nut}`);
    if (d.buvid4) parts.push(`buvid4=${encodeURIComponent(d.buvid4)}`);
  } catch { /* 拿不到 buvid 也别挡住主流程 */ }
  return parts.join('; ');
}

// Wbi 签名是懒加载的：它自己会读同一份 cookie
let _signWbi = null;
async function signWbi(params) {
  if (!_signWbi) {
    process.env.BILIBILI_COOKIE_FILE = COOKIE_FILE;
    const mod = await import(`file://${join(PKG, 'api', 'wbi.js')}`);
    _signWbi = mod.signWbi;
  }
  return _signWbi(params);
}

async function jget(url, opts = {}) {
  const ck = loadCookie();
  const res = await fetch(url, {
    ...opts,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.bilibili.com',
      Cookie: await cookieHeader(ck),
      ...(opts.headers || {}),
    },
    signal: AbortSignal.timeout(opts.timeout || 15000),
  });
  const text = await res.text();
  if (res.status === 412) throw new BiliError('请求被风控拦截（HTTP 412），歇一会儿再试', 412);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`返回不是 JSON（HTTP ${res.status}）：${text.slice(0, 120)}`);
  }
}

/** 统一的 form POST：自动带 csrf、设备 cookie，非 0 返回码抛 BiliError */
async function jpost(url, form, { referer = 'https://www.bilibili.com', origin, okCodes = [0] } = {}) {
  const ck = loadCookie();
  const body = new URLSearchParams({ ...form, csrf: ck.bili_jct });
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': UA,
      Referer: referer,
      Origin: origin || 'https://www.bilibili.com',
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: await cookieHeader(ck),
    },
    body,
    signal: AbortSignal.timeout(15000),
  });
  if (res.status === 412) throw new BiliError('请求被风控拦截（HTTP 412）', 412);
  const j = await res.json().catch(() => ({ code: -1, message: `HTTP ${res.status}` }));
  if (!okCodes.includes(j.code)) throw new BiliError(`${j.message || '失败'}（code=${j.code}）`, j.code);
  return j;
}

async function videoBase(bvid) {
  const info = await jget(
    `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
  );
  if (info.code !== 0) throw new BiliError(`取视频失败：${info.message}`, info.code);
  return info.data;
}

// ─── 账号状态 ──────────────────────────────────────────────
export async function getAccountStatus() {
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav');
  const d = nav.data || {};
  let moral = null;
  try {
    const info = await jget('https://api.bilibili.com/x/space/myinfo');
    if (info.code === 0) moral = info.data?.moral ?? null;
  } catch {
    /* 查不到就算了，不影响主流程 */
  }
  return {
    loggedIn: !!d.isLogin,
    uname: d.uname || '',
    uid: String(d.mid || ''),
    face: d.face || '',
    coins: d.money ?? 0,
    level: d.level_info?.current_level ?? null,
    exp: d.level_info?.current_exp ?? null,
    expMin: d.level_info?.current_min ?? null,
    expNext: d.level_info?.next_exp ?? null,
    moral,
    vip: d.vipStatus === 1,
    emailVerified: !!d.email_verified,
    mobileVerified: !!d.mobile_verified,
  };
}

/**
 * 今日经验完成情况 + 最近经验流水。
 * 每日上限：登录 5 / 观看 5 / 分享 5 / 投币 50（每枚 10）。
 */
export async function getExpStatus() {
  const [reward, coinExp, log] = await Promise.all([
    jget('https://api.bilibili.com/x/member/web/exp/reward'),
    jget('https://api.bilibili.com/x/web-interface/coin/today/exp').catch(() => ({ data: 0 })),
    jget('https://api.bilibili.com/x/member/web/exp/log?jsonp=jsonp').catch(() => ({ data: {} })),
  ]);
  const r = reward.data || {};
  return {
    login: !!r.login,
    watch: !!r.watch,
    share: !!r.share,
    coinsExp: Number(coinExp.data || r.coins || 0),
    email: !!r.email,
    tel: !!r.tel,
    safeQuestion: !!r.safe_question,
    identify: !!r.identify_card,
    log: (log.data?.list || []).slice(0, 30),
  };
}

// ─── 刷视频（看详情 + 翻评论）─────────────────────────────
export async function browseVideo(bvid) {
  const v = await videoBase(bvid);
  // 顺手拉一页评论，像人一样翻一翻
  let comments = [];
  try {
    const c = await jget(
      `https://api.bilibili.com/x/v2/reply?type=1&oid=${v.aid}&pn=1&ps=20&sort=1`,
    );
    comments = (c.data?.replies || []).map(mapReply);
  } catch {
    /* 评论拉不到不影响看视频 */
  }
  return {
    bvid: v.bvid,
    aid: v.aid,
    cid: v.cid,
    title: v.title,
    owner: v.owner?.name || '',
    ownerUid: String(v.owner?.mid || ''),
    ownerFace: v.owner?.face || '',
    desc: v.desc || '',
    duration: v.duration,
    tname: v.tname || '',
    stat: {
      view: v.stat?.view ?? 0,
      danmaku: v.stat?.danmaku ?? 0,
      reply: v.stat?.reply ?? 0,
      like: v.stat?.like ?? 0,
      coin: v.stat?.coin ?? 0,
      favorite: v.stat?.favorite ?? 0,
      share: v.stat?.share ?? 0,
    },
    pubdate: v.pubdate,
    pic: v.pic,
    noReply: !!v.rights?.no_reply,
    comments,
  };
}

// ─── 字幕：她「听到」了什么 ───────────────────────────────
// player/wbi/v2 列出这个分 P 的字幕轨：UP 主上传的 CC 字幕，或 B站 自动生成的 AI 字幕（ai-zh，要登录才给）。
// 字幕地址是 //aisubtitle.hdslb.com/... 这种不带协议的。拿不到返回 null —— 没字幕不等于视频里没人说话。
// 坑：这个接口偶尔会串台给别的视频的字幕，所以核对一下返回的 cid。
export async function videoSubtitle(bvid, cid) {
  const signed = await signWbi({ bvid, cid: String(cid) });
  const r = await jget('https://api.bilibili.com/x/player/wbi/v2?' + new URLSearchParams(signed));
  if (r.code !== 0) throw new BiliError(`取字幕失败：${r.message}`, r.code);
  if (r.data?.cid && String(r.data.cid) !== String(cid)) return null;
  const tracks = r.data?.subtitle?.subtitles || [];
  const zh = (t) => /zh|中文/i.test(`${t.lan} ${t.lan_doc}`);
  const isAi = (t) => String(t.lan).startsWith('ai-');
  const pick = tracks.find((t) => zh(t) && !isAi(t)) || tracks.find(zh) || tracks[0];
  if (!pick?.subtitle_url) return null;
  const url = pick.subtitle_url.startsWith('//') ? `https:${pick.subtitle_url}` : pick.subtitle_url;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' }, signal: AbortSignal.timeout(15000) });
  if (res.status === 412) throw new BiliError('请求被风控拦截（HTTP 412）', 412);
  const j = await res.json().catch(() => ({}));
  const lines = (j.body || [])
    .map((x) => ({ from: Number(x.from) || 0, to: Number(x.to) || 0, text: String(x.content || '').trim() }))
    .filter((x) => x.text);
  if (!lines.length) return null;
  return { source: isAi(pick) ? 'ai' : 'cc', lan: pick.lan_doc || pick.lan, lines };
}

function mapReply(x) {
  return {
    rpid: String(x.rpid),
    user: x.member?.uname || '',
    uid: String(x.mid || ''),
    face: x.member?.avatar || '',
    text: x.content?.message || '',
    like: x.like || 0,
    ctime: x.ctime || 0,
    parent: String(x.parent || 0),
    root: String(x.root || 0),
    subCount: x.rcount || 0,
    subs: (x.replies || []).slice(0, 3).map((s) => ({
      rpid: String(s.rpid),
      user: s.member?.uname || '',
      text: s.content?.message || '',
    })),
  };
}

// ─── 像真人一样「看」一个视频：播放心跳 ───────────────────
// 只调 /view 拿详情 **不会** 留下观看记录，也不算「每日观看」经验。
// 网页播放器的做法是：开播发一次心跳，之后每 15 秒发一次，结束再发一次，
// 心跳里带着已播放秒数。B站据此写入历史记录、累计播放进度。
//
// opts.seconds   计划看多少秒（调用方决定，见 autopilot 的观看时长策略）
// opts.signal    AbortSignal，用于中途停止（面板的「暂停」按钮）
// opts.onTick    每次心跳后回调 (playedSec)
export async function watchVideo(bvid, { seconds, signal, onTick, interval = 15 } = {}) {
  const ck = loadCookie();
  const v = await videoBase(bvid);
  const duration = Number(v.duration) || 60;
  const target = Math.max(5, Math.min(Math.round(seconds ?? duration), duration));
  const startTs = Math.floor(Date.now() / 1000);
  const referer = `https://www.bilibili.com/video/${v.bvid}`;

  const beat = (played, playType) =>
    jpost(
      'https://api.bilibili.com/x/click-interface/web/heartbeat',
      {
        aid: String(v.aid),
        bvid: v.bvid,
        cid: String(v.cid),
        mid: String(ck.dede_user_id || ''),
        played_time: String(played),
        real_played_time: String(played),
        realtime: String(played),
        start_ts: String(startTs),
        type: '3',
        sub_type: '0',
        dt: '2',
        play_type: String(playType), // 1=开始播放 0=播放中 4=结束
        auto_continued_play: '0',
        quality: '80',
        video_duration: String(duration),
        last_play_progress_time: String(played),
        max_play_progress_time: String(played),
        refer_url: 'https://www.bilibili.com/',
        outer: '0',
        spmid: '333.788.0.0',
        from_spmid: '333.1007.tianma.1-1-1.click',
      },
      { referer },
    );

  await beat(0, 1);
  let played = 0;
  let aborted = false;
  while (played < target) {
    const step = Math.min(interval, target - played);
    const ok = await sleep(step * 1000, signal);
    played += step;
    if (!ok) { aborted = true; break; }
    await beat(played, played >= target ? 4 : 0);
    onTick?.(played);
  }
  // 历史记录兜底上报：确保「历史记录」页能看到进度
  await jpost(
    'https://api.bilibili.com/x/v2/history/report',
    { aid: String(v.aid), cid: String(v.cid), progress: String(played) },
    { referer },
  ).catch(() => {});

  return { bvid: v.bvid, aid: v.aid, title: v.title, owner: v.owner?.name || '', duration, played, aborted };
}

/** 可被 AbortSignal 打断的 sleep；被打断返回 false */
export function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve(false);
    const t = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(true); }, ms);
    const onAbort = () => { clearTimeout(t); resolve(false); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

// ─── 分享（每日 +5 经验）──────────────────────────────────
// 71000 = 今天已经分享过这个视频，也算成功
export async function shareVideo(bvid) {
  const v = await videoBase(bvid);
  await jpost(
    'https://api.bilibili.com/x/web-interface/share/add',
    // 网页播放器分享时带的就是这几个字段，只给 aid 的请求不像真人点的
    { aid: String(v.aid), eab_x: '2', ramval: '0', source: 'web_normal', ga: '1' },
    { referer: `https://www.bilibili.com/video/${v.bvid}`, okCodes: [0, 71000] },
  );
  return { ok: true };
}

// ─── 投币（每枚 +10 经验，每天经验上限 50）──────────────────
// 实测教训：号里明明有 1 枚币，接口投币却返回 -403「账号异常」，同一枚币在浏览器里
// 却投成功了 —— 说明是脚本请求被风控盯上，不是余额问题。失败越多越像异常账号。
// 所以：**投币只要失败一次就永久上锁**，所有调用方（面板/自动养号/机器人 CLI）都被拦，
// 只能由号主在面板里手动解锁。余额不足不打接口、也不上锁。
const COIN_LOCK_FILE = join(here, 'data', 'coin-lock.json');

export function coinLock() {
  if (!existsSync(COIN_LOCK_FILE)) return null;
  try { return JSON.parse(readFileSync(COIN_LOCK_FILE, 'utf-8')); } catch { return { at: '?', reason: '锁文件损坏' }; }
}
/** 解锁时把旧锁改名留档（coin-lock.<时间>.json），方便回头查是哪次失败的 */
export function unlockCoin() {
  if (!existsSync(COIN_LOCK_FILE)) return false;
  renameSync(COIN_LOCK_FILE, COIN_LOCK_FILE.replace(/\.json$/, `.${Date.now()}.json`));
  return true;
}

export async function coinVideo(bvid, multiply = 1) {
  const lock = coinLock();
  if (lock) throw new BiliError(`投币已上锁（${lock.at} 失败过一次：${lock.reason}），需在面板手动解锁`, 'COIN_LOCKED');
  const nav = await jget('https://api.bilibili.com/x/web-interface/nav');
  const money = Number(nav.data?.money || 0);
  if (money < multiply) throw new BiliError(`硬币不够（余额 ${money}）`, 'NO_COIN');
  const v = await videoBase(bvid);
  try {
    await jpost(
      'https://api.bilibili.com/x/web-interface/coin/add',
      { aid: String(v.aid), bvid: v.bvid, multiply: String(multiply), select_like: '0' },
      { referer: `https://www.bilibili.com/video/${v.bvid}` },
    );
  } catch (e) {
    mkdirSync(dirname(COIN_LOCK_FILE), { recursive: true });
    writeFileSync(COIN_LOCK_FILE, JSON.stringify({ at: new Date().toISOString(), bvid, code: e.code ?? null, reason: e.message }, null, 2));
    throw e;
  }
  return { ok: true, left: money - multiply };
}

// ─── 搜索 ──────────────────────────────────────────────────
export async function searchVideo(keyword, order = 'totalrank', page = 1) {
  const signed = await signWbi({
    search_type: 'video',
    keyword,
    page: String(page),
    order,
  });
  const r = await jget(
    'https://api.bilibili.com/x/web-interface/wbi/search/type?' + new URLSearchParams(signed),
  );
  if (r.code !== 0) throw new BiliError(`搜索失败：${r.message}`, r.code);
  return (r.data?.result || []).map((x) => ({
    bvid: x.bvid,
    title: String(x.title || '').replace(/<[^>]+>/g, ''),
    author: x.author,
    owner: x.author,
    ownerUid: String(x.mid || ''),
    play: x.play,
    view: x.play,
    review: x.review,
    danmaku: x.video_review,
    duration: x.duration,
    durationSec: parseDuration(x.duration),
    pubdate: x.pubdate,
    description: x.description,
    pic: x.pic ? (x.pic.startsWith('//') ? 'https:' + x.pic : x.pic) : '',
    tname: x.typename,
  }));
}

function parseDuration(s) {
  if (typeof s === 'number') return s;
  const parts = String(s || '').split(':').map(Number);
  return parts.reduce((acc, n) => acc * 60 + (n || 0), 0);
}

// ─── 首页推荐（最像真人刷 B站 的入口）─────────────────────
export async function feedVideos(ps = 12) {
  const signed = await signWbi({
    fresh_type: '4',
    ps: String(ps),
    fresh_idx: String(1 + Math.floor(Math.random() * 5)),
    fresh_idx_1h: '1',
    brush: '1',
    web_location: '1430650',
  });
  const r = await jget(
    'https://api.bilibili.com/x/web-interface/wbi/index/top/feed/rcmd?' + new URLSearchParams(signed),
  );
  if (r.code !== 0) throw new BiliError(`取推荐失败：${r.message}`, r.code);
  return (r.data?.item || [])
    .filter((x) => x.goto === 'av' && x.bvid)
    .map((x) => ({
      bvid: x.bvid,
      title: x.title,
      owner: x.owner?.name,
      ownerUid: String(x.owner?.mid || ''),
      view: x.stat?.view,
      like: x.stat?.like,
      danmaku: x.stat?.danmaku,
      duration: x.duration,
      durationSec: x.duration,
      pubdate: x.pubdate,
      pic: x.pic,
    }));
}

// ─── 热门 ──────────────────────────────────────────────────
export async function hotVideos(max = 20) {
  const r = await jget('https://api.bilibili.com/x/web-interface/popular?ps=50&pn=1');
  if (r.code !== 0) throw new BiliError(`取热门失败：${r.message}`, r.code);
  return (r.data?.list || []).slice(0, max).map((x) => ({
    bvid: x.bvid,
    title: x.title,
    owner: x.owner?.name,
    ownerUid: String(x.owner?.mid || ''),
    view: x.stat?.view,
    like: x.stat?.like,
    danmaku: x.stat?.danmaku,
    reply: x.stat?.reply,
    duration: x.duration,
    durationSec: x.duration,
    pubdate: x.pubdate,
    pic: x.pic,
    tname: x.tname,
  }));
}

// ─── 观看历史（验证心跳是否生效的最直接证据）───────────────
export async function watchHistory(ps = 20) {
  const r = await jget(`https://api.bilibili.com/x/web-interface/history/cursor?ps=${ps}&type=archive`);
  if (r.code !== 0) throw new BiliError(`取历史失败：${r.message}`, r.code);
  return (r.data?.list || []).map((x) => ({
    bvid: x.history?.bvid || '',
    title: x.title,
    pic: x.cover,
    owner: x.author_name,
    viewAt: x.view_at,
    progress: x.progress, // -1 表示看完
    duration: x.duration,
  }));
}

// ─── 点赞 ──────────────────────────────────────────────────
// 现行接口：/x/web-interface/archive/like，like=1 赞 / 2 取消。
// 上游用的 /x/v2/view/like 已废弃。65006 = 已经赞过
export async function likeVideo(bvid, like = true) {
  await jpost(
    'https://api.bilibili.com/x/web-interface/archive/like',
    { bvid, like: like ? '1' : '2' },
    { referer: `https://www.bilibili.com/video/${bvid}`, okCodes: [0, 65006] },
  );
  return { ok: true };
}

// ─── 发评论 / 回复评论 ─────────────────────────────────────
// 一级评论：oid=aid, type=1，不带 root/parent
// 楼中楼：带 root（根评论 rpid）和 parent（被回复的 rpid）
// 回复「消息中心」里的评论时，oid/type 直接用消息里的 subject_id / business_id
export async function postComment({ bvid, aid, oid, type = 1, message, rootRpid, parentRpid }) {
  let target = oid || aid;
  if (!target) target = (await videoBase(bvid)).aid;
  const form = { oid: String(target), type: String(type), message, plat: '1' };
  if (rootRpid) form.root = String(rootRpid);
  if (parentRpid) form.parent = String(parentRpid);
  const j = await jpost('https://api.bilibili.com/x/v2/reply/add', form, {
    referer: bvid ? `https://www.bilibili.com/video/${bvid}` : 'https://message.bilibili.com/',
  });
  return { rpid: String(j.data?.rpid_str || j.data?.rpid || '') };
}

// ─── 视频下的评论（供面板挑要回复的）──────────────────────
export async function videoComments(bvid, aid, page = 1) {
  const oid = aid || (await videoBase(bvid)).aid;
  const r = await jget(
    `https://api.bilibili.com/x/v2/reply?type=1&oid=${oid}&pn=${page}&ps=20&sort=1`,
  );
  if (r.code !== 0) throw new BiliError(`取评论失败：${r.message}`, r.code);
  return { count: r.data?.page?.count || 0, list: (r.data?.replies || []).map(mapReply) };
}

// ─── 一串楼中楼（回别人之前，先看看这串里前面聊了什么）──────
// 第一页是最老的 20 条；楼长了就再拉最后一页，保证最新的几句在里面
export async function replyThread({ oid, type = 1, root, ps = 20 }) {
  const url = (pn) => `https://api.bilibili.com/x/v2/reply/reply?oid=${oid}&type=${type}&root=${root}&pn=${pn}&ps=${ps}`;
  const r = await jget(url(1));
  if (r.code !== 0) throw new BiliError(`取楼中楼失败：${r.message}`, r.code);
  let list = r.data?.replies || [];
  const pages = Math.ceil((r.data?.page?.count || 0) / ps);
  if (pages > 1) {
    const last = await jget(url(pages)).catch(() => null);
    if (last?.code === 0) list = [...list, ...(last.data?.replies || [])];
  }
  return { root: r.data?.root ? mapReply(r.data.root) : null, list: list.map(mapReply) };
}

// ─── 给评论点赞 ────────────────────────────────────────────
export async function likeReply({ oid, type = 1, rpid }) {
  await jpost('https://api.bilibili.com/x/v2/reply/action', { oid: String(oid), type: String(type), rpid: String(rpid), action: '1' });
  return { ok: true };
}

/** 她自己的 UID（从 cookie 读，不打接口） */
export function myUid() {
  try { return String(loadCookie().dede_user_id || ''); } catch { return ''; }
}

// ─── 消息中心：未读数 / 回复我的 / @我 / 收到的赞 ───────────
export async function unreadCounts() {
  const [feed, dm] = await Promise.all([
    jget('https://api.bilibili.com/x/msgfeed/unread?build=0&mobi_app=web'),
    jget(
      'https://api.vc.bilibili.com/session_svr/v1/session_svr/single_unread?unread_type=0&show_dustbin=1&build=0&mobi_app=web',
      { headers: { Referer: 'https://message.bilibili.com/' } },
    ).catch(() => ({ data: {} })),
  ]);
  const f = feed.data || {};
  const d = dm.data || {};
  return {
    reply: f.reply || 0,
    at: f.at || 0,
    like: f.like || 0,
    sys: f.sys_msg || 0,
    dm: (d.follow_unread || 0) + (d.unfollow_unread || 0),
  };
}

function mapFeedItem(x) {
  const it = x.item || {};
  return {
    id: String(x.id),
    user: x.user?.nickname || '',
    uid: String(x.user?.mid || ''),
    face: x.user?.avatar || '',
    time: x.reply_time || x.at_time || 0,
    title: it.title || '',
    uri: it.uri || '',
    text: it.source_content || '',
    myText: it.target_reply_content || '',
    // 回复用：
    oid: String(it.subject_id || ''),
    type: Number(it.business_id || 1),
    rpid: String(it.source_id || ''),
    root: String(it.root_id || 0) !== '0' ? String(it.root_id) : String(it.source_id || ''),
  };
}

export async function replyFeed() {
  const r = await jget('https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web', {
    headers: { Referer: 'https://message.bilibili.com/' },
  });
  if (r.code !== 0) throw new BiliError(`取回复消息失败：${r.message}`, r.code);
  return (r.data?.items || []).map(mapFeedItem);
}

export async function atFeed() {
  const r = await jget('https://api.bilibili.com/x/msgfeed/at?platform=web&build=0&mobi_app=web', {
    headers: { Referer: 'https://message.bilibili.com/' },
  });
  if (r.code !== 0) throw new BiliError(`取@消息失败：${r.message}`, r.code);
  return (r.data?.items || []).map(mapFeedItem);
}

export async function likeFeed() {
  const r = await jget('https://api.bilibili.com/x/msgfeed/like?platform=web&build=0&mobi_app=web', {
    headers: { Referer: 'https://message.bilibili.com/' },
  });
  if (r.code !== 0) throw new BiliError(`取点赞消息失败：${r.message}`, r.code);
  return (r.data?.total?.items || []).map((x) => ({
    id: String(x.id),
    users: (x.users || []).map((u) => u.nickname),
    face: x.users?.[0]?.avatar || '',
    count: x.counts || 0,
    title: x.item?.title || '',
    desc: x.item?.desc || '',
    uri: x.item?.uri || '',
    time: x.like_time || 0,
  }));
}

// ─── 用户名片（批量取昵称/头像，私信列表用）────────────────
const _cardCache = new Map();
export async function userCards(uids) {
  const need = [...new Set(uids.map(String))].filter((u) => u && !_cardCache.has(u));
  if (need.length) {
    try {
      const r = await jget(
        `https://api.vc.bilibili.com/account/v1/user/cards?uids=${need.slice(0, 50).join(',')}`,
      );
      for (const c of r.data || []) _cardCache.set(String(c.mid), { name: c.name, face: c.face });
    } catch { /* 拿不到就显示 UID */ }
  }
  return Object.fromEntries(uids.map((u) => [String(u), _cardCache.get(String(u)) || null]));
}

// ─── 私信：会话列表 ────────────────────────────────────────
export async function listSessions() {
  const r = await jget(
    'https://api.vc.bilibili.com/session_svr/v1/session_svr/get_sessions' +
      '?session_type=1&group_id=0&build=0&mobi_app=web',
    { headers: { Referer: 'https://message.bilibili.com/' } },
  );
  if (r.code !== 0) throw new BiliError(`取会话失败：${r.message}`, r.code);
  const list = (r.data?.session_list || []).map((s) => ({
    talkerId: String(s.talker_id),
    unread: s.unread_count || 0,
    ts: s.session_ts,
    // session_ts 是微秒
    time: s.session_ts ? new Date(Number(s.session_ts) / 1000).toISOString() : null,
    lastMsg: parseMsgContent(s.last_msg?.content, s.last_msg?.msg_type),
    lastSender: String(s.last_msg?.sender_uid || ''),
  }));
  const cards = await userCards(list.map((s) => s.talkerId));
  for (const s of list) {
    s.name = cards[s.talkerId]?.name || SYSTEM_TALKERS[s.talkerId] || '';
    s.system = !!SYSTEM_TALKERS[s.talkerId];
    s.face = cards[s.talkerId]?.face || '';
  }
  return list;
}

function parseMsgContent(content, type) {
  if (!content) return '';
  try {
    const c = JSON.parse(content);
    if (c.content != null) return String(c.content);
    if (type === 2) return '[图片]';
    return c.title || c.text || '[消息]';
  } catch {
    return content;
  }
}

// ─── 私信：拉某个会话的消息 ────────────────────────────────
export async function listMessages(talkerId, size = 30) {
  const ck = loadCookie();
  const me = ck.dede_user_id || '';
  const r = await jget(
    'https://api.vc.bilibili.com/svr_sync/v1/svr_sync/fetch_session_msgs' +
      `?talker_id=${talkerId}&session_type=1&size=${size}&sender_device_id=1&build=0&mobi_app=web`,
    { headers: { Referer: 'https://message.bilibili.com/' } },
  );
  if (r.code !== 0) throw new BiliError(`取消息失败：${r.message}`, r.code);
  return (r.data?.messages || [])
    .map((m) => ({
      msgKey: String(m.msg_key || ''),
      seqno: Number(m.msg_seqno || 0),
      from: String(m.sender_uid || ''),
      to: String(m.receiver_id || ''),
      mine: String(m.sender_uid) === String(me),
      text: parseMsgContent(m.content, m.msg_type),
      ts: m.timestamp,
      time: m.timestamp ? new Date(Number(m.timestamp) * 1000).toISOString() : null,
      type: m.msg_type,
    }))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
}

// ─── 私信：标记已读 ────────────────────────────────────────
// 坑：只拉消息不算已读，B站那边的未读数会一直挂着。网页版点开会话时会调这个接口，
// ack_seqno 填这个会话里最大的 msg_seqno。
export async function markSessionRead(talkerId, ackSeqno) {
  const ck = loadCookie();
  let seq = Number(ackSeqno || 0);
  if (!seq) seq = Math.max(0, ...(await listMessages(talkerId, 20)).map((m) => m.seqno));
  await jpost(
    'https://api.vc.bilibili.com/session_svr/v1/session_svr/update_ack',
    { talker_id: String(talkerId), session_type: '1', ack_seqno: String(seq), build: '0', mobi_app: 'web', csrf_token: ck.bili_jct },
    { referer: 'https://message.bilibili.com/', origin: 'https://message.bilibili.com' },
  );
  return { ok: true };
}

// 官方系统号不是普通用户，user/cards 查不到名字
const SYSTEM_TALKERS = { '844424930131964': 'B站官方通知' };

// ─── 私信：发送 ────────────────────────────────────────────
// 坑：这个接口要 Wbi 签名（w_sender_uid / w_receiver_id / w_dev_id），
// 且正文是 form-urlencoded，csrf 要同时给 csrf 和 csrf_token 两个字段。
export async function sendPrivateMessage(receiverUid, text) {
  const ck = loadCookie();
  const me = String(ck.dede_user_id || '');
  if (!me) throw new Error('凭证里没有 dede_user_id，无法确定发送者');

  const devId = crypto.randomUUID().toUpperCase();
  const signed = await signWbi({
    w_sender_uid: me,
    w_receiver_id: String(receiverUid),
    w_dev_id: devId,
  });
  const j = await jpost(
    'https://api.vc.bilibili.com/web_im/v1/web_im/send_msg?' + new URLSearchParams(signed),
    {
      'msg[sender_uid]': me,
      'msg[receiver_id]': String(receiverUid),
      'msg[receiver_type]': '1',
      'msg[msg_type]': '1',
      'msg[msg_status]': '0',
      'msg[dev_id]': devId,
      'msg[timestamp]': String(Math.floor(Date.now() / 1000)),
      'msg[content]': JSON.stringify({ content: text }),
      csrf_token: ck.bili_jct,
      mobi_app: 'web',
    },
    { referer: 'https://message.bilibili.com/', origin: 'https://message.bilibili.com' },
  );
  return { msgKey: String(j.data?.msg_key || '') };
}

// ─── 关注 / 动态 / 收藏（给「特别关注」用）─────────────────────
// 动态流 feed/all 一次就能拿到所有关注的人的新动态，比挨个去 UP 主空间查省得多
// （空间投稿接口 /x/space/wbi/arc/search 风控很严，能不碰就不碰）。

const DYN_KIND = {
  DYNAMIC_TYPE_AV: 'video',
  DYNAMIC_TYPE_DRAW: 'draw',
  DYNAMIC_TYPE_WORD: 'word',
  DYNAMIC_TYPE_FORWARD: 'forward',
  DYNAMIC_TYPE_ARTICLE: 'article',
  DYNAMIC_TYPE_LIVE_RCMD: 'live',
};

function mapDynamic(it) {
  const m = it.modules || {};
  const author = m.module_author || {};
  const dyn = m.module_dynamic || {};
  const arc = dyn.major?.archive;
  const text =
    dyn.desc?.text ||
    dyn.major?.opus?.summary?.text ||
    dyn.major?.opus?.title ||
    dyn.major?.article?.title ||
    '';
  return {
    id: String(it.id_str || ''),
    kind: DYN_KIND[it.type] || 'other',
    uid: String(author.mid || ''),
    name: author.name || '',
    face: author.face || '',
    ts: Number(author.pub_ts || 0) * 1000,
    text: String(text).slice(0, 200),
    liked: !!m.module_stat?.like?.status,
    video: arc
      ? {
          bvid: arc.bvid,
          aid: String(arc.aid || ''),
          title: arc.title,
          pic: arc.cover,
          durationText: arc.duration_text,
          durationSec: parseDuration(arc.duration_text),
        }
      : null,
  };
}

/** 关注的人的动态流（最新在前）。type: all / video */
export async function followFeed({ type = 'all', offset = '' } = {}) {
  const q = new URLSearchParams({ timezone_offset: '-480', type, page: '1', features: 'itemOpusStyle' });
  if (offset) q.set('offset', offset);
  const r = await jget('https://api.bilibili.com/x/polymer/web-dynamic/v1/feed/all?' + q);
  if (r.code !== 0) throw new BiliError(`取关注动态失败：${r.message}`, r.code);
  return {
    items: (r.data?.items || []).map(mapDynamic).filter((x) => x.id && x.uid),
    offset: r.data?.offset || '',
  };
}

/** B站自带的「特别关注」分组（tagid = -10） */
export async function specialFollowings() {
  const r = await jget('https://api.bilibili.com/x/relation/tag?tagid=-10&pn=1&ps=50');
  if (r.code !== 0) throw new BiliError(`取特别关注分组失败：${r.message}`, r.code);
  return (r.data || []).map((u) => ({ uid: String(u.mid), name: u.uname, face: u.face }));
}

/** 我和某人的关系：following = 我关注了 TA */
export async function relationWith(uid) {
  const r = await jget(`https://api.bilibili.com/x/relation?fid=${encodeURIComponent(uid)}`);
  if (r.code !== 0) throw new BiliError(`查关注关系失败：${r.message}`, r.code);
  const a = Number(r.data?.attribute || 0);
  return { following: a === 2 || a === 6, blocked: a === 128 };
}

export async function followUser(uid) {
  await jpost(
    'https://api.bilibili.com/x/relation/modify',
    { fid: String(uid), act: '1', re_src: '11' },
    { referer: `https://space.bilibili.com/${uid}` },
  );
  return { ok: true };
}

/** 给一条动态点赞（不是视频点赞）。这个接口吃 JSON，csrf 在 query 里 */
export async function likeDynamic(dynId) {
  const ck = loadCookie();
  const res = await fetch(
    `https://api.bilibili.com/x/dynamic/feed/dyn/thumb?csrf=${encodeURIComponent(ck.bili_jct)}`,
    {
      method: 'POST',
      headers: {
        'User-Agent': UA,
        Referer: `https://t.bilibili.com/${dynId}`,
        Origin: 'https://t.bilibili.com',
        'Content-Type': 'application/json',
        Cookie: await cookieHeader(ck),
      },
      body: JSON.stringify({ dyn_id_str: String(dynId), up: 1, spmid: '333.1365.0.0' }),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (res.status === 412) throw new BiliError('请求被风控拦截（HTTP 412）', 412);
  const j = await res.json().catch(() => ({ code: -1, message: `HTTP ${res.status}` }));
  if (j.code !== 0) throw new BiliError(`${j.message || '失败'}（code=${j.code}）`, j.code);
  return { ok: true };
}

/** 收藏进默认收藏夹；已经收藏过就什么都不做 */
export async function favoriteVideo(bvid) {
  const ck = loadCookie();
  const v = await videoBase(bvid);
  const had = await jget(`https://api.bilibili.com/x/v2/fav/video/favoured?aid=${v.aid}`);
  if (had.code === 0 && had.data?.favoured) return { ok: true, already: true };
  const fl = await jget(
    `https://api.bilibili.com/x/v3/fav/folder/created/list-all?type=2&up_mid=${encodeURIComponent(ck.dede_user_id || '')}`,
  );
  const folder = fl.data?.list?.[0];
  if (fl.code !== 0 || !folder) throw new BiliError(`找不到默认收藏夹：${fl.message || ''}`, fl.code);
  await jpost(
    'https://api.bilibili.com/x/v3/fav/resource/deal',
    { rid: String(v.aid), type: '2', add_media_ids: String(folder.id), del_media_ids: '' },
    { referer: `https://www.bilibili.com/video/${v.bvid}` },
  );
  return { ok: true, already: false };
}

/** 我有没有给这个视频点过赞（只读，用来避免重复点、核对失败的点赞到底生效没） */
export async function hasLiked(bvid) {
  const r = await jget(`https://api.bilibili.com/x/web-interface/archive/has/like?bvid=${encodeURIComponent(bvid)}`);
  return r.code === 0 && Number(r.data) === 1;
}

// ─── 扫码登录 ──────────────────────────────────────────────
// 改了密保、改密码、异地登录之类，B站会把旧 SESSDATA 作废（面板显示「掉登录」）。
// 流程：generate 拿 url + qrcode_key → 手机 B站 扫码确认 → poll 返回 0 时，凭证在 Set-Cookie 里。
// 写回同一个 cookie.json：面板下一次请求就用新的，DSH 里的 MCP 也会（打过补丁）自动重读。
const PASSPORT = 'https://passport.bilibili.com/x/passport-login/web/qrcode';

export async function qrLoginStart() {
  const r = await fetch(`${PASSPORT}/generate`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' },
    signal: AbortSignal.timeout(10000),
  }).then((x) => x.json());
  if (r.code !== 0 || !r.data?.qrcode_key) throw new Error(`取登录二维码失败（code=${r.code}）`);
  // 二维码用 bilibili-mcp 自带的 qrcode 包画成 SVG，面板保持零依赖
  const { createRequire } = await import('node:module');
  const QR = createRequire(join(ROOT, 'bilibili-mcp', 'package.json'))('qrcode');
  const svg = await QR.toString(r.data.url, { type: 'svg', margin: 2, errorCorrectionLevel: 'M' });
  return { key: r.data.qrcode_key, svg, expiresAt: Date.now() + 170_000 };
}

/** 查一次扫码状态：waiting / scanned / expired / ok */
export async function qrLoginPoll(key) {
  const res = await fetch(`${PASSPORT}/poll?qrcode_key=${encodeURIComponent(key)}`, {
    headers: { 'User-Agent': UA, Referer: 'https://www.bilibili.com' },
    signal: AbortSignal.timeout(10000),
  });
  const j = await res.json();
  const code = j.data?.code;
  if (code === 86101) return { status: 'waiting' };
  if (code === 86090) return { status: 'scanned' };
  if (code === 86038) return { status: 'expired' };
  if (code !== 0) return { status: 'error', message: j.data?.message || j.message || `code=${code}` };

  const jar = new Map();
  for (const raw of res.headers.getSetCookie?.() || []) {
    const [pair] = raw.split(';');
    const eq = pair.indexOf('=');
    if (eq > 0) jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
  }
  // 兜底：成功时 data.url 的 query 里也带着这几个值
  try {
    const u = new URL(j.data.url);
    for (const k of ['SESSDATA', 'bili_jct', 'DedeUserID']) if (!jar.get(k) && u.searchParams.get(k)) jar.set(k, u.searchParams.get(k));
  } catch { /* 没有就算了 */ }
  if (!jar.get('SESSDATA')) return { status: 'error', message: '确认了登录，但没拿到 SESSDATA，再扫一次试试' };

  // SESSDATA 在 Set-Cookie 里是 URL 编码过的（带 %2C），原样存，发请求时也原样带
  const ck = {
    sessdata: jar.get('SESSDATA'),
    bili_jct: jar.get('bili_jct') || '',
    dede_user_id: jar.get('DedeUserID') || '',
    lastRefresh: Date.now(),
  };
  if (j.data.refresh_token) ck.refresh_token = j.data.refresh_token;
  // 登录时 B站 一并下发的会话 cookie 也留着，发请求时原样带上（以前只存三个，等于把会话拆残了）
  const extra = Object.fromEntries([...jar].filter(([k]) => ['DedeUserID__ckMd5', 'sid'].includes(k)));
  if (Object.keys(extra).length) ck.extra = extra;
  mkdirSync(dirname(COOKIE_FILE), { recursive: true });
  const tmp = COOKIE_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(ck, null, 2), { mode: 0o600 });
  renameSync(tmp, COOKIE_FILE);
  return { status: 'ok', uid: ck.dede_user_id };
}
