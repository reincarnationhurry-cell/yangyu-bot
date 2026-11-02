/**
 * 抖音操作库
 *
 * 为什么不用 fetch：抖音的页面内容全靠前端 JS 渲染，直接请求 HTML 只有导航和页脚，
 * 而且带着奇怪 UA 的裸请求极易撞验证码。真浏览器 + 真指纹才拿得到东西。
 *
 * 浏览器直接用 web.mjs（已经处理了沙箱、CDP Origin、登录态持久化），这里不重复造。
 *
 * ═══ 实测边界（2026-11-02，未登录，Chrome 真机）═══
 * 能拿到：
 *   - /hot 热榜：滚动后 30 个视频卡片（首屏 10 个，往下滚懒加载到 30）
 *   - /video/<id> 详情页：标题、描述、话题、作者、点赞/评论/收藏/分享数、发布时间
 *   - /video/<id> 评论区：**最多 10 条**一级评论（含楼中楼回复），点开「展开N条回复」还能更多
 * 拿不到：
 *   - / 、/jingxuan 、/discover ：被重定向成纯导航页，0 个视频卡片
 *   - /search/<kw> ：0 个卡片，页面写「登录后即可搜索更多精彩视频」，且带验证码容器
 *   - 未登录继续下拉评论：停在 10 条，页面写「登录后可查看更多评论」
 *   - 未登录发评论：输入框提示「请先登录后发表评论」
 *
 * 另一个容易搞错的地方：热榜卡片上的数字**不是播放量，是点赞数**。
 * 实测 3/3 与详情页 [data-e2e="video-player-digg"] 完全一致（3754 / 3559 / 2.8万）。
 * 所以 hotVideos 返回的 playCount 恒为 null，真实数字在 likeCount 里。
 */
import { openPage, browser } from './web.mjs';
import { persistentStamps } from './store.mjs';

const HOT_URL = 'https://www.douyin.com/hot';
const videoUrl = (vid) => `https://www.douyin.com/video/${vid}`;
const searchUrl = (kw) => `https://www.douyin.com/search/${encodeURIComponent(kw)}`;

/** 未登录时评论区最多只能展开到这么多条一级评论（实测硬上限） */
export const COMMENT_CAP_UNLOGGED = 10;

// ─── 错误 ──────────────────────────────────────────────────
/**
 * 抖音的失败都要说人话。调用方（面板/机器人）要能一眼看出该做什么：
 * 是「该登录了」还是「它改版了」还是「被拦了」。
 */
export class DouyinError extends Error {
  constructor(message, { code = 'error', loginRequired = false } = {}) {
    super(message);
    this.name = 'DouyinError';
    this.code = code;
    this.loginRequired = loginRequired;
  }
}

const needLogin = (what) => {
  // what 是「为什么需要登录」的补充说明，调用处为了好读可能自带前导逗号。
  // 直接拼会出「，，」这种低级错误（实测踩到过），所以统一剥一次再拼。
  const extra = String(what || '').replace(/^[，,]\s*/, '');
  return new DouyinError(`还没登录抖音${extra ? `，${extra}` : ''}。先在面板里扫码登录。`, {
    code: 'login-required',
    loginRequired: true,
  });
};

// ─── 页面开启口（测试可以换掉，避免真开浏览器）─────────────
// 单元测试要跑「未登录时写操作必须拒绝」，如果每次真开一个 Chrome，测试就没法在 CI 里跑，
// 也没必要。所以把「开页面」收敛成一个可替换的钩子，测试塞假页面进来即可。
let openPageImpl = openPage;

/** 仅测试用：注入假页面（传 null 还原） */
export function __setPageOpener(fn) {
  openPageImpl = fn || openPage;
}

async function withPage(url, fn, opts = {}) {
  const page = await openPageImpl(url, opts);
  try {
    return await fn(page);
  } finally {
    if (!opts.keep) await Promise.resolve(page.close?.()).catch(() => {});
  }
}

// ─── 纯函数：ID / 数字 / 文本 解析 ─────────────────────────
/**
 * 从各种输入里抠出 19 位视频 id。
 * 认得的写法：纯数字 id、/video/xxx、//www.douyin.com/video/xxx?x=1、分享短链里的数字。
 * 认不出就抛错 —— 静默返回 null 会让上层拿一个空字符串去拼 URL，最后报一个看不懂的错。
 */
export function parseVid(input) {
  const s = String(input ?? '').trim();
  if (!s) throw new DouyinError('没给视频 id 或链接', { code: 'bad-input' });
  if (/^\d{15,25}$/.test(s)) return s;
  const m = s.match(/\/video\/(\d{15,25})/);
  if (m) return m[1];
  const m2 = s.match(/(?:^|\D)(\d{19})(?:\D|$)/);
  if (m2) return m2[1];
  throw new DouyinError(`看不懂这个视频 id/链接：${s.slice(0, 60)}`, { code: 'bad-input' });
}

/**
 * 把「4.6万」「1.2亿」「3754」这种中文短数字换成整数。
 * 拿不到就返回 null，不要返回 0 —— 0 和「不知道」在统计里是两回事。
 */
export function parseCount(text) {
  const s = String(text ?? '').replace(/[,\s]/g, '');
  const m = s.match(/(\d+(?:\.\d+)?)\s*([万亿wW])?/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return null;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 1e4);
  if (unit === '亿') return Math.round(n * 1e8);
  return Math.round(n);
}

/** '01:40' → 100（秒）；认不出返回 null */
export function parseDuration(text) {
  const m = String(text ?? '').trim().match(/^(\d{1,2}):(\d{2})$/);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** 把 innerText 拆成「有内容的行」，去掉空白行 */
const lines = (text) => String(text ?? '').split('\n').map((s) => s.trim()).filter(Boolean);

// ─── 纯函数：热榜卡片解析 ──────────────────────────────────
/**
 * 解析一张热榜卡片。
 *
 * 卡片 innerText 实测长这样（行顺序不固定，有的卡多两行热点/在看人数）：
 *   00:18
 *   4.6万
 *   上升热点：蔡徐坤怕你感冒但不怕你心动
 *   435.2万人在看
 *   要抱抱 #要抱抱 #翻唱 #音为有你 #fyp
 *   @Reira_曾若妍
 *   · 3天前
 *
 * 所以不按行号取，按「长什么样」认：
 *   时长 =  HH:MM 形态
 *   数字 =  纯数字/带万亿后缀，且不是「N万人在看」那种带字的
 *   作者 =  以 @ 开头
 *   时间 =  以 · 开头
 *   标题 =  剩下的最长一行（通常带 # 话题）
 */
export function parseHotCard({ href, text } = {}) {
  const vid = String(href ?? '').match(/\/video\/(\d{15,25})/)?.[1] || null;
  if (!vid) return null;
  const ls = lines(text);

  let duration = null;
  let likeCount = null;
  let author = '';
  let publishTime = '';
  let event = '';
  const rest = [];

  for (const line of ls) {
    if (!duration) {
      const d = parseDuration(line);
      // 只认行首就是 HH:MM 的，避免把标题里的「3:2」当成时长
      if (d !== null && /^\d{1,2}:\d{2}$/.test(line)) { duration = d; continue; }
    }
    // 「435.2万人在看」这类带字的先摘出去，否则它也会被 parseCount 命中，抢走 likeCount
    if (/人在看|热度|播放/.test(line) && !/^[\d.]+[万亿]?$/.test(line)) continue;
    if (!likeCount && /^[\d.]+[万亿]?$/.test(line)) { likeCount = parseCount(line); continue; }
    if (/^(上升)?热点[：:]/.test(line)) { event = line.replace(/^(上升)?热点[：:]/, '').trim(); continue; }
    if (line.startsWith('@') && !author) { author = line.slice(1).trim(); continue; }
    if (/^[·•]/.test(line)) { publishTime = line.replace(/^[·•]\s*/, '').trim(); continue; }
    rest.push(line);
  }

  // 标题：优先带话题标签的那行，其次剩下最长的
  const title =
    rest.find((l) => l.includes('#')) ||
    rest.slice().sort((a, b) => b.length - a.length)[0] ||
    '';

  return {
    vid,
    url: videoUrl(vid),
    title: title.replace(/\s+/g, ' ').trim(),
    duration,
    // 抖音热榜卡片上没有播放量，只有点赞数（实测与详情页 digg 一致）。
    // 留着这个字段是为了接口稳定，值是 null 而不是瞎猜。
    playCount: null,
    likeCount,
    author,
    publishTime,
    event,
  };
}

/** 从一批 {href,text} 里解析卡片，顺手按 vid 去重 */
export function parseHotCards(cards = []) {
  const seen = new Set();
  const out = [];
  for (const c of cards) {
    const v = parseHotCard(c);
    if (!v || seen.has(v.vid)) continue;
    seen.add(v.vid);
    out.push(v);
  }
  return out;
}

// ─── 纯函数：评论解析 ──────────────────────────────────────
/**
 * 解析一条评论。
 *
 * 为什么把整条 innerText 丢进来解析、而不是在页面里精确抠 DOM 节点：
 * 抖音的类名全是 hash（Eh0a5CD4 这种），今天叫这个明天就换，抠节点必然脆。
 * 但 innerText 的**结构**很稳定，实测一条评论长这样：
 *
 *   鲸屿
 *   ...
 *   谁还记得他之前叫把妹王啊      ← 正文
 *   3天前·山东                   ← 时间
 *   758                          ← 点赞数
 *   分享 / 回复
 *   展开15条回复                  ← 有楼中楼才有
 *
 * 所以按「哪一行长得像什么」来认，改版只换配色不换行序。
 */
export function parseComment({ author, raw, stats } = {}) {
  const ls = lines(raw);
  const name = String(author ?? '').split('\n')[0].replace(/作者$/, '').trim();

  const isTime = (l) => /^(\d+\s*(秒|分钟|小时|天|周|个月)\s*前|\d+月\d+月|\d+月\d+日|\d{2}-\d{2}|刚刚)/.test(l) &&
                       l.length <= 20;
  const NOISE = /^(分享|回复|作者|展开\d+条回复|收起|\.{1,3}|举报|置顶)$/;

  let time = '';
  let likeRaw = '';
  let replyCount = 0;
  const bodyCands = [];

  for (const line of ls) {
    if (!time && isTime(line)) { time = line; continue; }
    if (/^展开\d+条回复$/.test(line)) { replyCount = Number(line.match(/\d+/)[0]); continue; }
    if (NOISE.test(line)) continue;
    // 作者名（可能带「作者」标记）跳过 —— 第一行通常是名字
    if (name && line === name) continue;
    if (line === '作者') continue;
    if (!likeRaw && /^[\d.]+[万亿]?$/.test(line)) { likeRaw = line; continue; }
    bodyCands.push(line);
  }

  // 正文：去掉名字/时间/数字后剩下的最长一行。
  // 有楼中楼时 innerText 会把子评论也串进来，所以绝不能整段返回，只能取最长的一行。
  const body = bodyCands.sort((a, b) => b.length - a.length)[0] || '';
  const likeLine = likeRaw || lines(stats).find((l) => /^[\d.]+[万亿]?$/.test(l)) || '';

  if (!name && !body) return null;
  return {
    author: name,
    text: body,
    likeCount: likeLine ? parseCount(likeLine) : null,
    likeCountRaw: likeLine,
    time,
    replyCount,
  };
}

// ─── 节流 ──────────────────────────────────────────────────
/**
 * 写操作的频率闸门。
 *
 * 为什么放函数内部而不是靠调用方：调用方有面板、自动养号、机器人好几个，
 * 任何一处漏了就是一次风控。默认点赞 20 秒、评论 30 秒，跟人手速差不多。
 * now 可注入，方便单测跳过 sleep。
 */
export function createThrottle({ likeMs = 20000, commentMs = 30000, now = () => Date.now(), stamps } = {}) {
  // stamps：落盘的时间戳（全局闸门用，跨进程、跨重启）；不给就只在内存里（单测用）
  const last = stamps || new Map();
  const gapOf = (kind) => (kind === 'comment' ? commentMs : likeMs);

  return {
    /** 现在能不能动手；不能就返回还要等多久 */
    check(kind) {
      const gap = gapOf(kind);
      // 用 has() 而不是 `last.get(kind) || 0`：
      // 没记录过要放行，但「记录在时间 0」也是有效记录，两者不能混。
      // （这个坑是单测抓出来的：now() 从 0 开始的场景里，第一次点赞会被误判成冷却中。）
      if (!last.has(kind)) return { ok: true, waitMs: 0 };
      const wait = last.get(kind) + gap - now();
      return wait <= 0 ? { ok: true, waitMs: 0 } : { ok: false, waitMs: wait };
    },
    mark(kind) {
      last.set(kind, now());
    },
    /** 测试与「换号/重开」用 */
    reset(kind) {
      if (kind) last.delete(kind);
      else last.clear();
    },
  };
}

/** 全局闸门：进程内所有写操作共用 */
export const throttle = createThrottle({ stamps: persistentStamps('douyin') });

/**
 * 动手前先过闸门。等不了就抛人话错误，绝不「先点了再说」。
 */
export function guardThrottle(kind, t = throttle) {
  const r = t.check(kind);
  if (!r.ok) {
    const sec = Math.ceil(r.waitMs / 1000);
    throw new DouyinError(
      `手太快了，${kind === 'comment' ? '评论' : '点赞'}要等 ${sec} 秒再来一次（防止被抖音当机器人）`,
      { code: 'throttled' },
    );
  }
}

// ─── 页面上的小工具 ────────────────────────────────────────
/**
 * 真点击一个「innerText 正好等于某段文字」的元素。
 *
 * 为什么不用 el.click()：实测抖音的「登录」按钮对合成的 el.click() 完全不响应，
 * 必须走 Input.dispatchMouseEvent 这种浏览器底层输入事件才会弹出登录框。
 *
 * 为什么不用 querySelector('button')：页面上第一个 button 是「开启读屏标签」的无障碍按钮
 * （位置在 2,2），点它什么都不会发生 —— 这个坑实测踩过。
 */
async function clickByText(page, text, { tag = 'button, div[role="button"], a' } = {}) {
  // 位置会变（懒加载、公告条出现），所以点之前重新量一次，量完立刻点，中间不 await
  const box = await page.eval(`(() => {
    for (const el of document.querySelectorAll(${JSON.stringify(tag)})) {
      if ((el.innerText || '').trim() !== ${JSON.stringify(text)}) continue;
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
    }
    return null;
  })()`).catch(() => null);
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
    }).catch(() => {});
  }
  return true;
}

/** 真点击一个选择器命中的元素（同样走 Input.dispatchMouseEvent，理由同上） */
async function clickBySelector(page, selector) {
  const box = await page.eval(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    el.scrollIntoView({ block: 'center' });
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return null;
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`).catch(() => null);
  if (!box) return false;
  for (const type of ['mousePressed', 'mouseReleased']) {
    await page.send('Input.dispatchMouseEvent', {
      type, x: box.x, y: box.y, button: 'left', clickCount: 1,
    }).catch(() => {});
  }
  return true;
}

/** 滚页面，触发抖音的懒加载。窗口和内部滚动容器都要滚 —— 详情页的评论是在内层容器里滚的 */
const SCROLL_ONCE = `(() => {
  window.scrollBy(0, window.innerHeight * 0.9);
  const boxes = [...document.querySelectorAll('div')]
    .filter((d) => d.scrollHeight > d.clientHeight + 200 && d.clientHeight > 300)
    .sort((a, b) => b.scrollHeight - a.scrollHeight)
    .slice(0, 1);
  for (const b of boxes) b.scrollTop = b.scrollHeight;
  return true;
})()`;

// ─── 热榜 ──────────────────────────────────────────────────
/**
 * 热榜视频列表。
 * @param {{limit?: number}} opts 默认 20，最多能滚出 30 个
 * @returns {Promise<Array<{vid,url,title,duration,playCount,likeCount,author,publishTime,event}>>}
 */
export async function hotVideos({ limit = 20 } = {}) {
  return withPage(HOT_URL, async (page) => {
    // 首屏只有 10 个，往下滚才长到 30。滚到够数或者不再增长就停。
    let cards = [];
    let prev = -1;
    let stuck = 0;
    for (let i = 0; i < 12; i++) {
      const raw = await page.eval(`(() => [...document.querySelectorAll('a[href*="/video/"]')]
        .map((a) => ({ href: a.getAttribute('href') || '', text: a.innerText || '' })))()`).catch(() => []);
      cards = parseHotCards(raw);
      if (cards.length >= limit) break;
      if (page.interruptible) break;
      if (cards.length === prev) {
        if (++stuck >= 3) break;
      } else {
        stuck = 0;
        prev = cards.length;
      }
      await page.eval(SCROLL_ONCE).catch(() => {});
      await new Promise((r) => setTimeout(r, 800));
    }

    if (!cards.length) {
      // 空列表不能当成功返回：上层会以为「今天热榜没有视频」。
      throw new DouyinError('抖音热榜这次没给出视频卡片，可能被拦了或者改版了，过一会儿再试', { code: 'empty' });
    }
    return cards.slice(0, limit);
  });
}

// ─── 登录态 ────────────────────────────────────────────────
/**
 * 怎么判断登录：看导航栏有没有头像、以及「登录」按钮还在不在。
 *
 * 实测未登录时页面有个 innerText 正好是「登录」的 button；
 * 登录后那个位置变成头像，`[class*="avatar"]` 才有东西。
 * 两路都对不上就返回 unknown 而不是瞎猜一个 false —— 猜错会让写操作去点一个不存在的按钮。
 */
export async function loginState() {
  return withPage(HOT_URL, async (page) => {
    // 轮询等导航栏渲染完，而不是死等 1.2 秒 —— 快的时候 300ms 就有结果
    let r = null;
    for (let i = 0; i < 20; i++) {
      r = await page.eval(`(() => {
        const txt = document.body ? document.body.innerText : '';
        let hasLoginBtn = false;
        for (const el of document.querySelectorAll('button, div[role="button"], a')) {
          if ((el.innerText || '').trim() === '登录') { hasLoginBtn = true; break; }
        }
        // 头像：优先 data-e2e，其次 class 含 avatar 的 img
        const avatar = document.querySelector('[data-e2e="live-avatar"] img, [class*="avatar"] img');
        const selfLink = document.querySelector('a[href*="/user/self"]');
        // 昵称在 localStorage 的 user_info 里（实测：头像 alt 是空的，/user/self 链接的字是导航栏的「我的」，
        // 以前就把「我的」当成了昵称）。都拿不到就留空，宁可不显示也别显示错的。
        let nickname = '';
        for (const k of ['user_info', 'user_info_passport_new', 'user_info_passport']) {
          const m = /"nickname"\\s*:\\s*"([^"]{1,40})"/.exec(localStorage.getItem(k) || '');
          if (m) { nickname = m[1]; break; }
        }
        if (!nickname) nickname = (avatar?.getAttribute('alt') || '').trim();
        if (/^(我的|我|头像|登录|个人主页)$/.test(nickname)) nickname = '';
        return { hasLoginBtn, hasAvatar: !!avatar || !!selfLink, nickname, hasBody: txt.length > 50 };
      })()`).catch(() => null);
      if (r && (r.hasLoginBtn || r.hasAvatar)) break;
      // 假页面（单测）的 eval 结果是恒定的，再等也不会有新内容，直接收手
      if (page.interruptible) break;
      await new Promise((res) => setTimeout(res, 300));
    }

    if (!r || !r.hasBody) {
      throw new DouyinError('抖音页面没打开，判断不了登录状态', { code: 'no-page' });
    }
    // 「登录按钮在」比「没看到头像」更可靠：没登录一定有按钮
    const loggedIn = !r.hasLoginBtn && r.hasAvatar;
    return {
      loggedIn,
      nickname: loggedIn ? r.nickname || '' : '',
      checkedAt: Date.now(),
    };
  });
}

// ─── 搜索 ──────────────────────────────────────────────────
/**
 * 搜视频。**未登录一定失败**：实测 /search/<kw> 一个视频卡片都不渲染，
 * 页面直接写「登录后即可搜索更多精彩视频」，还带验证码容器。
 * 所以这里不静默返回空数组（那等于骗调用方「搜到了 0 条」），而是抛 loginRequired。
 *
 * @param {string} keyword
 * @param {{limit?: number, page?: object}} opts
 */
export async function searchVideos(keyword, { limit = 10 } = {}) {
  const kw = String(keyword ?? '').trim();
  if (!kw) throw new DouyinError('搜索关键词是空的', { code: 'bad-input' });

  return withPage(searchUrl(kw), async (page) => {
    // 给 SPA 一点时间渲染，再用「有没有卡片」来判断登录与否，不靠猜
    let raw = [];
    for (let i = 0; i < 6; i++) {
      raw = await page.eval(`(() => [...document.querySelectorAll('a[href*="/video/"]')]
        .map((a) => ({ href: a.getAttribute('href') || '', text: a.innerText || '' })))()`).catch(() => []);
      if (raw.length || page.interruptible) break;
      await new Promise((r) => setTimeout(r, 1200));
    }
    if (!raw.length) {
      const body = (await page.text().catch(() => '')) || '';
      if (/登录后即可搜索|登录后搜索|请登录/.test(body)) {
        throw needLogin('，搜索视频必须先登录');
      }
      throw new DouyinError('抖了一路还是没搜到视频卡片，可能被风控拦了或者改版了', { code: 'empty' });
    }
    const found = parseHotCards(raw);
    // 搜索结果卡片的内文结构和热榜很像（时长/数字/标题/作者/时间），复用同一套解析
    if (!found.length) throw new DouyinError('搜索结果解析不出来，抖音可能改版了', { code: 'parse' });
    return found.slice(0, limit);
  });
}

// ─── 视频详情 ──────────────────────────────────────────────
/**
 * 视频详情。未登录也能拿到（实测）：标题/描述/话题/作者/点赞/评论/收藏/分享/发布时间。
 * 拿不到的是「这条视频到底播放了多少次」—— 页面本来就不给。
 *
 * 实测可靠的锚点（2026-11-02）：
 *   [data-e2e="detail-video-info"]          描述 + 计数 + 发布时间，第一个子 div 就是描述
 *   [data-e2e="detail-video-publish-time"]  「发布时间：2026-10-26 11:05」
 *   [data-e2e="user-info"]                  「小十七seven粉丝5691获赞7.5万」，名字要从这串里切
 *   [data-e2e="video-player-digg"] 等四个   点赞 / 评论 / 收藏 / 分享
 *
 * 别再使用「第一个 a[href*="/user/"]」当作者 —— 描述里的 @ 提及也长这样，
 * 实测会拿到 @DOG编舞师 而不是视频作者（踩过一次，报告里记着）。
 *
 * @returns {Promise<{vid,title,author,desc,likeCount,commentCount,collectCount,shareCount,publishTime,tags,url}>}
 */
export async function videoDetail(vidOrUrl) {
  const vid = parseVid(vidOrUrl);
  return withPage(videoUrl(vid), async (page) => {
    // 详情区是异步渲染的，实测同一版本会有 6 秒内读到空的情况。
    // 所以等锚点出来，而不是死等固定秒数。
    for (let i = 0; i < 15; i++) {
      const ready = await page.eval(
        `!!(document.querySelector('[data-e2e="detail-video-info"]') ||
             document.querySelector('[data-e2e="video-player-digg"]'))`,
      ).catch(() => false);
      if (ready || page.interruptible) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    const raw = await page.eval(`(() => {
      const info = document.querySelector('[data-e2e="detail-video-info"]');
      const digg = document.querySelector('[data-e2e="video-player-digg"]');
      const num = (sel) => {
        const el = document.querySelector(sel);
        return el ? (el.innerText || '').trim().split('\\n')[0] : '';
      };
      // 描述：detail-video-info 的第一个带文字的子元素
      let desc = '';
      if (info) {
        const first = [...info.children].find((c) => (c.innerText || '').trim());
        desc = first ? first.innerText.trim() : '';
      }
      const userInfo = document.querySelector('[data-e2e="user-info"]');
      return {
        desc,
        userInfo: userInfo ? (userInfo.innerText || '').trim() : '',
        digg: digg ? (digg.innerText || '').trim().split('\\n')[0] : '',
        comment: num('[data-e2e="feed-comment-icon"]'),
        collect: num('[data-e2e="video-player-collect"]'),
        share: num('[data-e2e="video-player-share"]'),
        publish: (() => {
          const el = document.querySelector('[data-e2e="detail-video-publish-time"]');
          return el ? (el.innerText || '').trim() : '';
        })(),
        title: document.title || '',
      };
    })()`).catch(() => null);

    if (!raw) throw new DouyinError('详情页读不出来，抖音把内容藏起来了，可能要登录', { code: 'no-page' });

    // 描述的多级兜底：detail-video-info → 正文里带话题的行 → <title>
    let desc = String(raw.desc || '').replace(/\s+/g, ' ').trim();
    if (!desc) {
      const body = (await page.text().catch(() => '')) || '';
      desc = lines(body).find((l) => l.includes('#') && l.length > 4) || '';
    }
    if (!desc && raw.title) {
      // <title> 形如「描述 - 作者于20260101发布在抖音…」，把尾巴切掉
      desc = String(raw.title).replace(/\s*-\s*[^-]*发布于抖音.*$/, '').trim();
    }
    if (!desc && !raw.digg && !raw.comment) {
      throw new DouyinError('抖音把内容藏起来了，可能要登录', { code: 'empty', loginRequired: true });
    }

    // 作者：「小十七seven粉丝5691获赞7.5万」→ 取「粉丝」前面那截
    let author = String(raw.userInfo || '').split('\n')[0];
    author = author.replace(/粉丝[\d.万亿]*.*$/, '').trim();
    if (!author) {
      // 兜底：详情区的第一个 @ 提及（不完美，但比空着强）
      author = String(desc.match(/@(\S+)/)?.[1] || '').trim();
    }

    const publishTime = String(raw.publish || '')
      .replace(/^发布时间[：:]\s*/, '')
      .trim();
    const tags = [...desc.matchAll(/#([^\s#]+)/g)].map((m) => m[1]);

    return {
      vid,
      url: videoUrl(vid),
      title: desc,
      desc,
      author,
      likeCount: parseCount(raw.digg),
      likeCountRaw: raw.digg || '',
      commentCount: parseCount(raw.comment),
      commentCountRaw: raw.comment || '',
      collectCount: parseCount(raw.collect),
      shareCount: parseCount(raw.share),
      publishTime,
      tags,
    };
  });
}

// ─── 评论区 ────────────────────────────────────────────────
/**
 * 视频评论。
 *
 * 实测（未登录）：一级评论最多 10 条，继续滚会停住，页面同时出现
 * 「请先登录后发表评论」「登录后可查看更多评论」。
 * 所以这里滚到不再增长就收手，并给返回的数组挂一个 loginWall 标记，
 * 让调用方知道「不是只有 10 条评论，是我只能看到 10 条」。
 *
 * @param {string} vidOrUrl
 * @param {{limit?: number}} opts 默认 20（未登录实际最多 10）
 * @returns {Promise<Array<{author,text,likeCount,time,replyCount}> & {loginWall?: boolean, capped?: boolean}>}
 */
export async function videoComments(vidOrUrl, { limit = 20 } = {}) {
  const vid = parseVid(vidOrUrl);
  return withPage(videoUrl(vid), async (page) => {
    for (let i = 0; i < 10; i++) {
      const ready = await page.eval(`!!document.querySelector('[data-e2e="comment-item"], [class*="comment-item"]')`)
        .catch(() => false);
      if (ready || page.interruptible) break;
      await new Promise((r) => setTimeout(r, 1000));
    }

    // 页面里只做「拿到一条评论的原文」这一件简单的事，解析全部交给纯函数 parseComment。
    // 为什么不在页面里精确抠节点：类名是 hash，抠了明天就废；innerText 结构才稳。
    const PULL = `(() => {
      const ITEM = '[data-e2e="comment-item"], [class*="comment-item"]';
      const all = [...document.querySelectorAll(ITEM)];
      // 楼中楼也带 comment-item，会嵌在父评论的 DOM 里，这里只要一级评论
      const top = all.filter((el) => !(el.parentElement && el.parentElement.closest(ITEM)));
      return top.map((el) => {
        let author = '';
        const a = el.querySelector('a[href*="/user/"]');
        if (a) author = (a.innerText || '').trim();
        if (!author) {
          const n = el.querySelector('[class*="nickname"], [class*="author"]');
          if (n) author = (n.innerText || '').trim();
        }
        const s = el.querySelector('[class*="stats"], [class*="like"]');
        return { author, raw: el.innerText || '', stats: s ? (s.innerText || '') : '' };
      });
    })()`;

    let rows = [];
    let prev = -1;
    let stuck = 0;
    for (let i = 0; i < 14; i++) {
      rows = await page.eval(PULL).catch(() => []);
      if (rows.length >= limit) break;
      if (rows.length === prev) {
        if (++stuck >= 3) break;
      } else {
        stuck = 0;
        prev = rows.length;
      }
      await page.eval(SCROLL_ONCE).catch(() => {});
      await new Promise((r) => setTimeout(r, 900));
    }

    const out = rows.map(parseComment).filter(Boolean).slice(0, limit);
    if (!out.length) {
      const body = (await page.text().catch(() => '')) || '';
      if (/登录后可查看更多评论|请先登录/.test(body)) {
        throw needLogin('，看评论要先登录');
      }
      throw new DouyinError('这条视频一条评论都读不到，可能关评论了，或者抖音改版了', { code: 'empty' });
    }

    const body = (await page.text().catch(() => '')) || '';
    // 数组上挂标记：JSON.stringify 不会带上，但调用方读得到
    out.loginWall = /登录后可查看更多评论/.test(body);
    out.capped = out.loginWall && out.length <= COMMENT_CAP_UNLOGGED;
    return out;
  });
}

// ─── 写操作（这里只实现，绝不主动跑）────────────────────────
/**
 * 发评论。
 *
 * 守卫顺序：先查登录 → 再过节流 → 再动 DOM。任何一步不过直接抛，不试。
 * 未登录时抖音的输入框就写着「请先登录后发表评论」，点下去只会弹登录框，
 * 所以登录检查放在最前面，省得白跑一趟。
 *
 * @param {string} vid
 * @param {string} text 最多 100 字（抖音限制）
 */
export async function postComment(vid, text, { throttle: t = throttle, opener = openPageImpl } = {}) {
  const id = parseVid(vid);
  const content = String(text ?? '').trim();
  if (!content) throw new DouyinError('评论内容是空的', { code: 'bad-input' });
  if (content.length > 100) throw new DouyinError('抖音评论最多 100 字，这条超了', { code: 'bad-input' });

  // 登录检查放在最前：省一次白跑，也给调用方一个明确的 loginRequired
  const st = await loginState();
  if (!st.loggedIn) throw needLogin();

  guardThrottle('comment', t);

  return withPage(videoUrl(id), async (page) => {
    const INPUT = '[data-e2e="comment-input"], textarea[placeholder*="评论"], div[contenteditable="true"]';
    const ok = await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(INPUT)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.focus();
      return true;
    })()`).catch(() => false);
    if (!ok) {
      throw new DouyinError('找不到评论输入框，抖音可能改版了，或者这条视频不让评论', { code: 'no-input' });
    }

    // contenteditable 和 textarea 填法不同：前者得走 execCommand 才会触发 React 的 onChange
    await page.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(INPUT)});
      if (!el) return false;
      el.focus();
      if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
        if (setter) setter.call(el, ${JSON.stringify(content)}); else el.value = ${JSON.stringify(content)};
        el.dispatchEvent(new Event('input', { bubbles: true }));
      } else {
        document.execCommand('insertText', false, ${JSON.stringify(content)});
        el.dispatchEvent(new InputEvent('input', { bubbles: true, data: ${JSON.stringify(content)} }));
      }
      return true;
    })()`).catch(() => false);

    await new Promise((r) => setTimeout(r, 600));
    const sent = (await clickBySelector(page, '[data-e2e="comment-publish"]')) || (await clickBySelector(page, 'button[class*="publish"]'));
    if (!sent) throw new DouyinError('找不到「发布」按钮，抖音可能改版了', { code: 'no-button' });

    // 发完等一下，把回显读出来核对 —— 点了不等于发成功了
    await new Promise((r) => setTimeout(r, 2500));
    const echoed = await page.eval(`(() => {
      const body = document.body ? document.body.innerText : '';
      return body.includes(${JSON.stringify(content)});
    })()`).catch(() => false);
    if (!echoed) {
      throw new DouyinError('点了发布，但评论区没看到这条内容，可能被拦了（风控）', { code: 'not-confirmed' });
    }

    t.mark('comment');
    return { ok: true, vid: id, text: content };
  });
}

/**
 * 点赞 / 取消点赞。
 * @param {string} vid
 * @param {boolean} on true=点赞 false=取消（默认点赞）
 */
export async function likeVideo(vid, on = true, { throttle: t = throttle } = {}) {
  const id = parseVid(vid);
  const want = on !== false;

  const st = await loginState();
  if (!st.loggedIn) throw needLogin();

  guardThrottle('like', t);

  return withPage(videoUrl(id), async (page) => {
    for (let i = 0; i < 10; i++) {
      const ready = await page.eval(`!!document.querySelector('[data-e2e="video-player-digg"]')`).catch(() => false);
      if (ready || page.interruptible) break;
      await new Promise((r) => setTimeout(r, 900));
    }

    // aria-pressed / class 里带 active 表示已经点过了，避免重复点反而取消
    const before = await page.eval(`(() => {
      const el = document.querySelector('[data-e2e="video-player-digg"]');
      if (!el) return null;
      const pressed = el.getAttribute('aria-pressed');
      const cls = (el.className || '').toString();
      return { pressed, active: /active|selected|islike/i.test(cls) || pressed === 'true' };
    })()`).catch(() => null);
    if (!before) throw new DouyinError('找不到点赞按钮，抖音可能改版了', { code: 'no-button' });

    if (before.active === want) {
      return { ok: true, vid: id, liked: want, already: true };
    }

    const clicked = await clickBySelector(page, '[data-e2e="video-player-digg"]');
    if (!clicked) throw new DouyinError('点赞按钮点不动，抖音可能改版了', { code: 'no-button' });

    await new Promise((r) => setTimeout(r, 1200));
    const after = await page.eval(`(() => {
      const el = document.querySelector('[data-e2e="video-player-digg"]');
      const cls = (el.className || '').toString();
      return /active|selected|islike/i.test(cls) || el.getAttribute('aria-pressed') === 'true';
    })()`).catch(() => null);

    if (after !== want) {
      throw new DouyinError(`点了${want ? '赞' : '取消赞'}，但状态没变，可能被拦了`, { code: 'not-confirmed' });
    }

    t.mark('like');
    return { ok: true, vid: id, liked: want, already: false };
  });
}

// ─── 扫码登录 ──────────────────────────────────────────────
/**
 * 拿登录二维码。
 *
 * 实测：直接 visits /login 会被重定向，正确做法是在 /hot 上真点导航栏的「登录」按钮，
 * 会弹出一个 innerText 含「扫码登录 / 验证码登录 / 密码登录」的弹窗
 * （class 是 douyin_login_new_class，但这个 class 是 hash 化的，不能依赖）。
 * 截图整页交回去，让用户直接扫 —— 比找二维码 canvas 再抠图稳得多。
 */
export async function loginQr({ keep = false } = {}) {
  const page = await openPageImpl(HOT_URL);
  let ok = false;
  try {
    // 这里有个必须踩对的时间差（实测）：
    // 「登录」按钮在 React 水合之前就已经躺在 DOM 里了，这时候点**毫无反应**；
    // 必须等热榜卡片真的渲染出来（说明水合完成），点下去才会弹登录框。
    // 实测对照：水合前点 → 无弹窗；等卡片出现再点 → 「扫码登录」正常弹出。
    for (let i = 0; i < 25; i++) {
      const ready = await page.eval(`document.querySelectorAll('a[href*="/video/"]').length > 0`)
        .catch(() => false);
      if (ready || page.interruptible) break;
      await new Promise((r) => setTimeout(r, 400));
    }
    // 水合完成后再留一点余量，别卡在最后一帧
    await new Promise((r) => setTimeout(r, 1200));

    const DIALOG = /扫码登录|二维码|验证码登录|密码登录/;
    const hasDialog = () => page.eval(`${DIALOG}.test(document.body.innerText)`).catch(() => false);

    let found = await hasDialog();
    // 点了要验证；不弹就重试。宁可多试两次，也别把「没点着」当成「抖音坏了」。
    for (let attempt = 0; attempt < 3 && !found; attempt++) {
      const clicked = await clickByText(page, '登录');
      if (!clicked) {
        throw new DouyinError('页面上找不到「登录」按钮，抖音可能改版了', { code: 'no-button' });
      }
      for (let i = 0; i < 12; i++) {
        found = await hasDialog();
        if (found) break;
        if (page.interruptible) break;
        await new Promise((r) => setTimeout(r, 600));
      }
    }
    if (!found) {
      throw new DouyinError('点了「登录」但没弹出登录框，抖音可能改版了', { code: 'no-dialog' });
    }

    // 二维码是异步画出来的，再给一点时间，别截到空框
    await new Promise((r) => setTimeout(r, 1000));

    // 只截登录框那一块，不截整页 —— 整页 880KB 而弹窗区域只有 40KB 左右，
    // 面板要把它塞进 <img> 里显示，没必要传一整张热榜。
    const clip = await page.eval(`(() => {
      // 弹窗的特征：文本里有「扫码登录」，且是个够大的居中块
      let best = null;
      for (const el of document.querySelectorAll('div')) {
        const t = el.innerText || '';
        if (!/扫码登录|验证码登录/.test(t)) continue;
        const r = el.getBoundingClientRect();
        if (r.width < 300 || r.height < 300) continue;
        if (!best || r.width * r.height < best.w * best.h) {
          best = { x: r.x, y: r.y, w: r.width, h: r.height };
        }
      }
      return best;
    })()`).catch(() => null);

    const shot = clip
      ? await page
          .send('Page.captureScreenshot', {
            format: 'png',
            clip: {
              x: Math.max(0, Math.floor(clip.x)),
              y: Math.max(0, Math.floor(clip.y)),
              width: Math.ceil(clip.w),
              height: Math.ceil(clip.h),
              scale: 1,
            },
          })
          .catch(() => null)
      : null;
    const png = shot?.data || (await page.screenshot().catch(() => null));
    if (!png) throw new DouyinError('登录框出来了但截图失败', { code: 'no-shot' });
    const out = { png, expiresAt: Date.now() + 120_000 };
    ok = true;
    return keep ? { ...out, page } : out;
  } finally {
    // keep=true 时登录框所在的标签页要留着：扫码确认后是它在轮询、种 cookie
    if (!keep || !ok) await Promise.resolve(page.close?.()).catch(() => {});
  }
}

/**
 * 纯函数：一堆 cookie 里有没有抖音的登录会话。
 * 登录成功后 .douyin.com 上会种 sessionid / sessionid_ss / sid_tt；游客没有这几个。
 */
export function hasSession(cookies) {
  return (cookies || []).some((x) => /^(sessionid|sessionid_ss|sid_tt)$/.test(x?.name || '')
    && /(^|\.)douyin\.com$/.test(x?.domain || '') && !!x?.value);
}

/** 扫码时轮询用：只看 cookie，不像 loginState 那样每次都开一遍 /hot */
export async function hasSessionCookie() {
  const c = await browser();
  const { cookies } = await c.send('Storage.getCookies');
  return hasSession(cookies);
}

/** 给外面用的常量，免得面板里硬编码域名 */
export const urls = { hot: HOT_URL, video: videoUrl, search: searchUrl };
