/**
 * 百度贴吧操作库：逛吧、看帖、回帖、关注
 *
 * 为什么全走浏览器、不走 fetch：
 * 贴吧的接口几乎都要 BDUSS + 一串风控签名（sign/fr 之类的动态值），
 * 手工拼出来比「真的用浏览器点一下」脆弱得多。好在 web.mjs 已经有一个
 * 纯粹的独立浏览器（自己的 profile，登录态持久化在 data/web-browser），
 * 这里只负责「怎么把页面读成结构化数据」和「怎么保证不惹麻烦」。
 *
 * 几个必须踩对的坑（都是真机实测出来的，改之前先看）：
 *  1. 桌面版 https://tieba.baidu.com/f?kw=猫 **永远**返回「百度安全验证」页。
 *     能用的是移动版 https://tieba.baidu.com/mo/q/m?kw=猫。
 *     但即使给移动版地址，Chrome 里也会被贴吧自己的 JS 跳成 PC 布局渲染
 *     （出现 .pc-pb-box），所以解析代码两套 DOM 都得认。
 *  2. 帖子页是前端渲染的：goto 回来时 document.body.innerText 只有 47 个字符
 *     （一串楼层占位数字 + 底部导航），大约 1 秒后标题和正文才出现。
 *     必须 waitFor，不能 goto 完立刻读。
 *  3. 帖子回复列表是**虚拟列表**（.virtual-list-item），只有滚到视野里的才渲染。
 *     一进来只有 4 条，滚到底能到 6 条以上；未登录时页尾写「登录后查看全部评论内容」，
 *     也就是**未登录最多只能看到一部分回复**。这是贴吧的硬限制，不是解析没写对。
 *  4. .pb-content-item 不是「楼」，是**楼中楼的一条回复**；.pb-content-wrap 也不是楼，
 *     是**楼主正文**。真正的楼层是 .pb-comment-item。名字很坑，别按字面猜。
 *  5. .comment-content 的 innerText 会把楼中楼、时间、地区、点赞数全带出来，
 *     所以正文必须取 .pb-rich-text 里**第一个** .pb-content-item 的文本，不能直接 innerText。
 *  6. 未登录时 .comment-content 里没有时间/地区节点，只有时间的是 .pc-pb-comments-desc
 *     （在 comment-content 的兄弟位置）。所以元信息要从外层 .pb-comment-item 里找。
 */
import { openPage, withPage, browser } from './web.mjs';

const MO = 'https://tieba.baidu.com/mo/q/m';
const SEARCH = 'https://tieba.baidu.com/f/search/res';
const PASSPORT = 'https://passport.baidu.com/v2/?login';

/** 读楼层列表/首页列表时的统一等待条件；超时给中文话，不吐选择器 */
const LIST_READY = 'document.querySelectorAll(".pb-comment-item, .threads_list li, .relevant-forum").length > 0';

export class TiebaError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TiebaError';
    this.code = code;
  }
}

// ─── 小工具 ────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s ?? '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();

/**
 * tid 可以从三种东西里来：纯数字、/p/123 路径、完整 URL。
 * 统一在这里收口，别让每个调用点各写一遍正则。
 */
export function parseTid(tidOrUrl) {
  const s = String(tidOrUrl ?? '').trim();
  if (/^\d{5,}$/.test(s)) return s;
  const m = s.match(/\/p\/(\d{5,})/) || s.match(/[?&]tid=(\d{5,})/);
  if (m) return m[1];
  throw new TiebaError(`看不出这是哪个帖子：${s.slice(0, 60) || '(空)'}。给 /p/ 数字或帖子链接。`, 'BAD_TID');
}

/** 吧名 → 移动版首页地址。pn 只在需要翻页时带上（贴吧会自己补 pn=0）。 */
export function forumUrl(name, page = 0) {
  const kw = String(name ?? '').trim().replace(/吧$/, '');
  if (!kw) throw new TiebaError('吧名是空的，要逛哪个吧？', 'BAD_FORUM');
  const pn = Math.max(0, Number(page) || 0) * 20;
  return `${MO}?kw=${encodeURIComponent(kw)}${pn ? `&pn=${pn}` : ''}`;
}

/** 帖子地址：统一用移动版入口，桌面版会撞安全验证 */
export function threadUrl(tidOrUrl) {
  return `https://tieba.baidu.com/p/${parseTid(tidOrUrl)}?lp=5028&mo_device=1`;
}

export function searchUrl(keyword) {
  const w = String(keyword ?? '').trim();
  if (!w) throw new TiebaError('要搜什么吧？关键词是空的', 'BAD_KEYWORD');
  return `${SEARCH}?qw=${encodeURIComponent(w)}`;
}

/**
 * 贴吧把「142」「1.4万」这种都当回复数。
 * 列表和详情页的计数口径不一样（详情页头部的 142 是全楼回复数），所以两处都走这里。
 */
export function parseCount(text) {
  const s = String(text ?? '').replace(/\s+/g, '');
  if (!s) return 0;
  const m = s.match(/([\d.]+)\s*(万|w|W|亿)?/);
  if (!m) return 0;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return 0;
  const unit = m[2];
  if (unit === '万' || unit === 'w' || unit === 'W') return Math.round(n * 10000);
  if (unit === '亿') return Math.round(n * 1e8);
  return Math.round(n);
}

// ─── 节流 ──────────────────────────────────────────────────
// 贴吧对「新号 + 机器节奏」非常敏感，回帖连着发两条基本必被删或被要求验证。
// 节流放在函数内部而不是让调用方自觉：调用方是面板/后台/机器人三套代码，
// 只要有一处忘了就是一次风控事故。
export const LIMITS = {
  reply: 30_000, // 回帖：至少 30 秒一条
  follow: 60_000, // 关注吧：一分钟内别连着关注一堆
};

const lastAt = new Map();

/**
 * 纯函数版节流判断：给定上次时间、现在、间隔，算出还要等多久。
 * 单独拆出来是为了能在测试里注入假时钟，不用真的等 30 秒。
 */
export function waitMsFor(last, now, gap) {
  if (!last) return 0;
  const left = Number(last) + Number(gap) - Number(now);
  return left > 0 ? left : 0;
}

/** 真正执行时的节流：等够时间再放行（同一类操作全局共享一个水位） */
async function throttle(kind) {
  const gap = LIMITS[kind] ?? 0;
  if (!gap) return;
  const wait = waitMsFor(lastAt.get(kind), Date.now(), gap);
  if (wait > 0) await sleep(wait);
  lastAt.set(kind, Date.now());
}

/** 给调用方/测试用的只读视图：现在还要等多久 */
export function throttleLeft(kind, now = Date.now()) {
  return waitMsFor(lastAt.get(kind), now, LIMITS[kind] ?? 0);
}

/** 测试用：把节流水位清空（别在生产代码里调） */
export function resetThrottle() {
  lastAt.clear();
}

// ─── 登录 ──────────────────────────────────────────────────
/**
 * 有没有登录，看 BDUSS —— 百度系的登录态就靠它，Cookie 里没有它 = 游客。
 * 不读页面文案（「登录」「退出」这种词页面上到处都是，容易误判）。
 */
export async function isLoggedIn() {
  try {
    const c = await browser();
    const { cookies } = await c.send('Storage.getCookies');
    return (cookies || []).some((x) => x.name === 'bduss' && /(^|\.)baidu\.com$/.test(x.domain || ''));
  } catch (e) {
    throw new TiebaError(`查登录状态时浏览器没响应：${e.message}`, 'BROWSER');
  }
}

/** 写操作前的闸门：没登录就别往下走了，别等到点了按钮才报奇怪的错 */
export async function canWrite() {
  if (!(await isLoggedIn())) {
    throw new TiebaError('还没登录贴吧，先扫码登录再回帖/关注', 'NOT_LOGGED_IN');
  }
  return true;
}

/** loginState 和 isLoggedIn 是一回事，保留这个别名是为了跟面板其它模块的命名习惯对齐 */
export async function loginState() {
  return { loggedIn: await isLoggedIn() };
}

/**
 * 打开百度登录页并把二维码截出来。
 * 为什么截图而不是抽 <img>：那个二维码是第三方控件（tang-pass-Qrcode），
 * 直接抓 img 会拿到一个随时会过期的 URL，面板还得自己再请求一次；
 * 截图就是「他眼睛看到的东西」，扫不出来才是我们的问题。
 */
export async function loginQr() {
  const page = await openPage(PASSPORT, { timeoutMs: 30_000 });
  try {
    // 二维码是控件异步画的，等它真的画出来再截
    await page
      .waitFor('(()=>{const i=document.querySelector("img.tang-pass-qrcode-img");return i && i.complete && i.naturalWidth>0;})()', { timeoutMs: 20_000 })
      .catch(() => null);
    const boxInfo = await page.eval(`(() => {
      const el = document.querySelector("#TANGRAM__PSP_3__qrcode, .tang-pass-qrcode, img.tang-pass-qrcode-img");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.max(0, Math.round(r.x) - 12), y: Math.max(0, Math.round(r.y) - 12), width: Math.round(r.width) + 24, height: Math.round(r.height) + 24 };
    })()`).catch(() => null);
    // CDP 的 clip 字段名是 width/height，不是 w/h —— 写错了整个调用会报 "Invalid parameters"
    const shot = boxInfo && boxInfo.width > 50 && boxInfo.height > 50
      ? await page.send('Page.captureScreenshot', { format: 'png', clip: { x: boxInfo.x, y: boxInfo.y, width: boxInfo.width, height: boxInfo.height, scale: 2 } })
        .then((r) => r.data).catch(() => null)
      : null;
    const png = shot || await page.screenshot();
    const loggedIn = await isLoggedIn();
    return { png, loggedIn, url: await page.url() };
  } finally {
    // 留一张页面没意义；二维码过期了下次再开
    await page.close().catch(() => {});
  }
}

// ─── 搜吧 ──────────────────────────────────────────────────
/**
 * 搜吧。坑：任务里提到的 /mo/q/search 实测返回空壳（只有「退出」两个字，没有结果），
 * 真正能用的是 PC 的 /f/search/res?qw=。这个地址不撞安全验证，能拿到吧卡片。
 * 结果里同时混着「大家都在逛的吧」（导航位，跟关键词无关）和真正的搜索结果，
 * 所以只认带 data-track 的 .relevant-forum —— 那是搜索卡片自己的标记。
 */
export async function searchForums(keyword) {
  const url = searchUrl(keyword);
  return withPage(url, async (page) => {
    await page.waitFor('.relevant-forum', { timeoutMs: 15_000 }).catch(() => null);
    const raw = await page.eval(`(() => {
      const out = [];
      for (const a of document.querySelectorAll("a.relevant-forum, a[class*=relevant-forum]")) {
        let track = null;
        try { track = JSON.parse(a.getAttribute("data-track") || "null"); } catch {}
        const txt = (a.innerText || "").replace(/\\s+/g, " ").trim();
        out.push({
          href: a.getAttribute("href") || "",
          kw: track && track.fname ? String(track.fname) : null,
          fid: track && track.fid ? String(track.fid) : null,
          text: txt,
        });
      }
      return out;
    })()`, { timeoutMs: 15_000 }).catch(() => []);

    const list = (raw || []).map((x) => {
      // 名字优先用 data-track 里的 fname（干净），没有就从「XX吧」里剥
      const name = (x.kw || '').trim() || (x.text.match(/^(.+?)\s*吧/) || [])[1]?.trim() || '';
      if (!name) return null;
      // 描述：名字后面到「关注」之前的那一段，没有就是空
      const desc = (x.text.match(/^.+?\s*吧\s+(.+?)\s*关注/) || [])[1]?.trim() || '';
      // 坑：贴吧网页写的是 "295W"（西文 W），不是「万」。只认中文单位会把 295W 读成 295。
      const members = (x.text.match(/关注\s*([\d.]+)\s*([万wW亿]?)/) || []).slice(1).join('') || '';
      const posts = (x.text.match(/贴子\s*([\d.]+)\s*([万wW亿]?)/) || []).slice(1).join('') || '';
      return {
        name,
        url: forumUrl(name),
        fid: x.fid,
        desc: clean(desc),
        memberCount: parseCount(members),
        threadCount: parseCount(posts),
      };
    }).filter(Boolean);

    // 同一个吧可能既有精准卡又有普通卡，去重但保留第一个（精准卡信息更全）
    const seen = new Set();
    const forums = list.filter((f) => (seen.has(f.name) ? false : (seen.add(f.name), true)));
    if (!forums.length) {
      throw new TiebaError(`搜「${keyword}」没搜到贴吧，可能是关键词太冷门，或者贴吧要验证了`, 'EMPTY');
    }
    return forums;
  }, { timeoutMs: 25_000 });
}

// ─── 吧内帖子列表 ──────────────────────────────────────────
/**
 * 把吧首页的 DOM 读成帖子数组。
 *
 * 为什么解析函数要接受 injected 的 doc：这段逻辑是「贴吧会改版」的第一道防线，
 * 必须能在不开浏览器的前提下拿假 DOM 跑回归（用注入的假 document 测）。
 * 三套选择器对应三种改版：现在这套（.threads_list > li）、
 * 任务里描述的旧结构（li.medias_wrap）、以及兜底的「任何带 /p/ 链接的 li」。
 */
export function parseThreads(doc = typeof document !== 'undefined' ? document : null) {
  if (!doc) return [];
  const out = [];
  const seen = new Set();
  const pick = (li) => {
    const a = li.querySelector('a[href*="/p/"]');
    if (!a) return null;
    const href = a.getAttribute('href') || '';
    const m = href.match(/\/p\/(\d{5,})/);
    const tid = String(li.getAttribute('data-tid') || (m && m[1]) || '').trim();
    if (!/^\d{5,}$/.test(tid) || seen.has(tid)) return null;
    seen.add(tid);

    // 标题：优先 .ti_title（新版），去掉「置顶」角标；旧版直接读链接文本
    const titleBox = li.querySelector('.ti_title') || a;
    const iconText = (li.querySelector('.ti_title_icon')?.innerText || '').trim();
    let title = '';
    const spans = titleBox.querySelectorAll('span');
    if (spans.length) {
      title = [...spans]
        .filter((s) => !/ti_title_icon/.test(String(s.className || '')))
        .map((s) => (s.innerText || '').trim())
        .filter(Boolean)
        .join(' ');
    }
    if (!title) title = (titleBox.innerText || a.innerText || '').trim();
    // 链接文本里常把回复数粘在标题后面（"标题\n142"），截掉末尾纯数字
    title = title.replace(/\n+/g, ' ').replace(/\s+\d+\s*$/, '').trim();

    // 作者：新版在 .ti_author 里；置顶贴没有作者节点
    const author = (li.querySelector('.ti_author')?.innerText || '').trim();

    // 回复数：.btn_reply 的图标文本；没有就退回「标题后面那串数字」
    let replyCount = NaN;
    const replyEl = li.querySelector('.btn_reply, .ti_zan_reply');
    if (replyEl) replyCount = Number((replyEl.innerText || '').replace(/[^\d]/g, ''));
    if (!Number.isFinite(replyCount)) {
      const tail = (a.innerText || '').trim().split('\n').pop();
      replyCount = Number((tail || '').replace(/[^\d]/g, ''));
    }

    return {
      tid,
      title,
      url: '/p/' + tid,
      replyCount: Number.isFinite(replyCount) ? replyCount : 0,
      isTop: /tl_top/.test(String(li.className || '')) || !!iconText,
      author,
      lastReplyAt: (li.querySelector('.ti_time')?.innerText || '').trim(),
    };
  };

  for (const sel of ['ul.threads_list > li', '.threads_list li', 'li.medias_wrap', 'li[data-tid]', 'li']) {
    const nodes = [...doc.querySelectorAll(sel)];
    if (!nodes.length) continue;
    const got = nodes.map(pick).filter(Boolean);
    if (got.length) return got;
  }
  return out;
}

export async function forumThreads(name, { page = 0 } = {}) {
  const url = forumUrl(name, page);
  return withPage(url, async (p) => {
    await p.waitFor('document.querySelector("ul.threads_list, .threads_list")', { timeoutMs: 20_000 }).catch(() => null);
    const threads = await p.eval(`(${parseThreads.toString()})(document)`, { timeoutMs: 20_000 }).catch(() => null);

    // 没有列表 = 要么吧名不存在，要么撞了验证页。两种都给一句人话。
    if (!threads || !threads.length) {
      const body = await p.text().catch(() => '');
      if (/安全验证|验证码|百度安全/.test(body)) {
        throw new TiebaError(`贴吧要验证，可能被风控了（${name}）。过一会儿再试，或者先在浏览器里手动过一下验证。`, 'VERIFY');
      }
      if (/抱歉|不存在|没有找到/.test(body)) {
        throw new TiebaError(`没有「${name}」这个吧，换个名字试试`, 'NOT_FOUND');
      }
      throw new TiebaError(`没读到「${name}」吧的帖子列表，贴吧可能改版了`, 'EMPTY');
    }

    // isTop 的帖子贴吧会一直置顶，翻页时也重复出现，这里保留但排在前面（不做删除，
    // 上层想只逛新帖可以自己 filter）
    return {
      forum: String(name).replace(/吧$/, ''),
      page,
      threads,
    };
  }, { timeoutMs: 30_000 });
}

// ─── 帖子详情 ──────────────────────────────────────────────
/**
 * 把帖子页的 DOM 读成结构化数据。同样接受注入的 doc，好让回归测试不开浏览器。
 * 名字最容易搞混，这里再强调一遍：
 *   .pb-content-item = 楼中楼的一条回复（不是楼！）
 *   .pb-content-wrap = 楼主正文（不是楼层容器！）
 *   .pb-comment-item = 真正的「楼」
 */
export function parseThreadDetail(doc = typeof document !== 'undefined' ? document : null) {
  const empty = { title: '', forumName: '', author: '', content: '', floors: [], replyCount: 0, isMediaOnly: false, loggedInHint: false };
  if (!doc) return empty;
  const txt = (el) => (el ? (el.innerText || '').trim() : '');
  const clean = (s) => String(s || '').replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').trim();
  const bodyText = (doc.body && doc.body.innerText) || '';

  const title =
    clean(txt(doc.querySelector('.pb-title'))) ||
    clean(txt(doc.querySelector('.core_title_txt'))) ||
    clean(String(doc.title || '').replace(/[-_]百度贴吧$/, ''));

  // 吧名：详情页把名字和「吧」拆成两个节点，.forum-name .name 里是纯名字
  const forumName =
    clean(txt(doc.querySelector('.forum-name .name'))) ||
    clean(txt(doc.querySelector('.forum-name-main'))) ||
    clean(txt(doc.querySelector('a.forum-info-left .name'))) ||
    clean(txt(doc.querySelector('.card_title_fname'))).replace(/吧$/, '');

  // 楼主：.head-line 里同时有等级/头衔，.head-name 才是干净昵称
  const head = doc.querySelector('.head-line');
  const author =
    clean(txt(head && head.querySelector('.head-name'))) ||
    clean(txt(doc.querySelector('.pb-author, .d_author, .louzhubiaoshi')));

  // 楼主正文：.pb-content-wrap 里的第一个 .pb-content-item（后面那些是楼中楼）。
  // 坑：视频帖/图片帖没有 .pb-content-wrap（实测 /p/9285426732 就是），
  // 那种帖子的「正文」其实就是标题本身 + 媒体。
  // 注意：兜底**不能**退回上层容器（.pc-pb-box），那会把楼层、按钮、播放器全读进正文
  // （实测踩过：正文变成「神喵摆尾 2024-11-24 江苏 关注 视频 00:00 00:02 ...」一坨）。
  const wrap = doc.querySelector('.pb-content-wrap');
  const firstItem = wrap && wrap.querySelector('.pb-content-item');
  let content =
    clean(txt(firstItem)) ||
    clean(txt(wrap)) ||
    clean(txt(doc.querySelector('.d_post_content, .post_content')));

  // 纯视频/图片帖（没有 .pb-content-wrap）就不要再从 .image-text 里抢救文字了：
  // 实测那里面是「作者 头衔 时间 地区 关注 00:02/00:21 倍速 转发 收藏 只看楼主 第2楼 …」，
  // 靠关键词过滤既漏又误伤，还不如老老实实说「这条没有文字正文」。
  // 中文没有 \b 词边界，正则过滤这条路本身就是错的（踩过）。
  const isMediaOnly = !content;

  const floors = [];
  [...doc.querySelectorAll('.pb-comment-item, .l_post')].forEach((el, i) => {
    const name =
      clean(txt(el.querySelector('.head-name'))) ||
      clean(txt(el.querySelector('.d_name, .p_author_name, a[href*="/home/main"]')));
    // 正文取第一个 pb-content-item —— 直接读 .comment-content 的 innerText 会把
    // 楼中楼、时间、地区、点赞数全黏进来
    const bodyEl = el.querySelector('.pb-rich-text .pb-content-item') || el.querySelector('.d_post_content');
    const text = clean(txt(bodyEl)) || clean(txt(el.querySelector('.pb-rich-text')));
    // 时间/地区在 .pc-pb-comments-desc 里（未登录时 comment-content 里没有）
    const descLeft = clean(txt(el.querySelector('.comment-desc-left, .post-tail-wrap')));
    const time = (descLeft.match(/^\S+/) || [''])[0];
    const location = (descLeft.match(/\S+\s+(\S+)$/) || [])[1] || '';
    const likeText = clean(txt(el.querySelector('.zan-container')));
    const replies = [...el.querySelectorAll('.pb-lzl-item')].map((x) => ({
      author: clean(txt(x.querySelector('.head-name'))),
      text: clean(txt(x.querySelector('.pb-rich-text .pb-content-item')) || txt(x.querySelector('.pb-rich-text'))),
    })).filter((x) => x.text);
    floors.push({
      floor: i + 1,
      author: name,
      text,
      time,
      location,
      likeCount: Number((likeText || '').replace(/[^\d]/g, '')) || 0,
      replies,
    });
  });

  // 全楼回复数：页头的「全部回复 (142)」，退回第一屏互动条上的最大数字
  let replyCount = 0;
  const m = bodyText.match(/全部回复\s*\(?\s*([\d.]+\s*[万亿]?)/);
  if (m) replyCount = Number(m[1].replace(/[^\d.]/g, '')) * (/万/.test(m[1]) ? 10000 : 1);
  if (!replyCount) {
    const inter = clean(txt(doc.querySelector('.pc-pb-first-floor-interactive')));
    const nums = (inter.match(/\d+/g) || []).map(Number).filter((n) => n > 0);
    if (nums.length) replyCount = Math.max(...nums);
  }

  return {
    title,
    forumName,
    author,
    content,
    floors,
    replyCount: Math.round(replyCount) || 0,
    isMediaOnly,
    loggedInHint: /先登录|登录后查看/.test(bodyText),
  };
}

export async function threadDetail(tidOrUrl, { maxFloors = 30 } = {}) {
  const tid = parseTid(tidOrUrl);
  const url = threadUrl(tid);
  return withPage(url, async (p) => {
    // 前端渲染，goto 回来只有占位数字（实测 47 字符）；必须先等标题/正文出现
    const ok = await p.waitFor(
      'document.querySelector(".pb-title, .pb-content-wrap, .core_title_txt")',
      { timeoutMs: 25_000 },
    ).then(() => true).catch(() => false);

    if (!ok) {
      const body = await p.text().catch(() => '');
      if (/安全验证|验证码|百度安全/.test(body)) {
        throw new TiebaError('贴吧要验证，可能被风控了。过一会儿再试。', 'VERIFY');
      }
      if (/该贴已被删除|帖子不存在|已被隐藏/.test(body)) {
        throw new TiebaError(`这个帖子不在了（${tid}），可能被删了`, 'DELETED');
      }
      throw new TiebaError(`帖子页没渲染出来（${tid}），贴吧可能要验证或者改版了`, 'EMPTY');
    }

    // 回复是虚拟列表，只有进过视野才渲染。滚到底再等一会儿，能多拿到几条。
    // 未登录时贴吧只放一部分，页尾写「登录后查看全部评论内容」。
    await p.eval('(()=>{window.scrollTo(0,document.body.scrollHeight);return 1})()', { timeoutMs: 10_000 }).catch(() => null);
    await sleep(1200);
    const firstCount = await p.eval('document.querySelectorAll(".pb-comment-item").length', { timeoutMs: 10_000 }).catch(() => 0);
    if (firstCount < 8) {
      // 再滚一次，虚拟列表有时要滚两轮才补满
      await p.eval('(()=>{const a=document.querySelector(".pc-pb-comments"); if(a) a.scrollTop=a.scrollHeight; window.scrollTo(0,document.body.scrollHeight); return 1})()', { timeoutMs: 10_000 }).catch(() => null);
      await sleep(1000);
    }

    const data = await p.eval(`(${parseThreadDetail.toString()})(document)`, { timeoutMs: 20_000 }).catch((e) => {
      throw new TiebaError(`帖子解析失败（${tid}）：${e.message}`, 'PARSE');
    });

    // 视频/图片帖本来就没有文字正文，那是正常的，不能当解析失败
    if (!data || (!data.title && !data.content && !(data.floors || []).length)) {
      throw new TiebaError(`帖子页读到了但没内容（${tid}），贴吧可能改版了`, 'EMPTY');
    }

    const floors = data.floors.slice(0, Math.max(1, maxFloors));
    const truncated = data.floors.length > floors.length || data.loggedInHint;
    return {
      tid,
      url,
      title: clean(data.title),
      forumName: clean(data.forumName),
      author: clean(data.author),
      content: clean(data.content),
      floors,
      replyCount: data.replyCount || data.floors.length,
      floorCount: data.floors.length,
      // 纯视频/图片帖：content 为空是正常的，别让上层以为解析失败
      isMediaOnly: !!data.isMediaOnly,
      truncated,
      note: data.loggedInHint && data.floors.length < 10
        ? '未登录时贴吧只放一部分回复，想读全要登录'
        : undefined,
    };
  }, { timeoutMs: 45_000 });
}

// ─── 回帖（写操作）─────────────────────────────────────────
/**
 * 回帖。
 * 这里刻意做得很保守：**没登录直接抛**，登录了也要先过 30 秒节流，
 * 最后才真的点输入框。贴吧发帖后会弹验证码，所以输入框找不齐就报错，
 * 绝不「先点一下再说」—— 写操作失败一次留下的脏状态比多一些校验麻烦得多。
 *
 * 注意：真机只验证到「未登录时抛错」这一步，登录态的提交流程没跑过
 * （任务要求写操作不要真跑），第一次真用之前请人工盯一次。
 */
export async function replyToThread(tidOrUrl, text) {
  const tid = parseTid(tidOrUrl);
  const body = String(text ?? '').trim();
  if (!body) throw new TiebaError('回帖内容不能是空的', 'BAD_TEXT');
  if (body.length > 1000) throw new TiebaError(`回帖太长了（${body.length} 字），贴吧一般限制 1000 字以内`, 'TOO_LONG');

  await canWrite(); // 未登录就在这里抛「还没登录贴吧」
  await throttle('reply');

  const url = threadUrl(tid);
  return withPage(url, async (p) => {
    await p.waitFor('document.querySelector(".pb-title, .core_title_txt")', { timeoutMs: 25_000 }).catch(() => null);

    // 输入框有三套可能的形态：直接 textarea / 富文本 contenteditable / 要先点「回复」才展开
    const found = await p.eval(`(() => {
      const ta = document.querySelector("textarea[class*=reply], .reply-input textarea, textarea");
      if (ta) return "textarea";
      const ce = document.querySelector('[contenteditable="true"]');
      if (ce) return "contenteditable";
      return null;
    })()`, { timeoutMs: 10_000 }).catch(() => null);

    if (!found) {
      // 没找到输入框：多半是没登录（页面显示「想说点啥？先登录一下吧」）
      const hint = await p.text().catch(() => '');
      if (/先登录|登录后/.test(hint)) {
        throw new TiebaError('还没登录贴吧，先扫码登录再回帖', 'NOT_LOGGED_IN');
      }
      throw new TiebaError('没找到回帖输入框，贴吧可能改版了', 'NO_INPUT');
    }

    // 输入 + 触发事件：贴吧的输入框是 Vue 受控的，直接改 value 不触发 input 事件它不认
    const ok = await p.eval(`(() => {
      const body = ${JSON.stringify(body)};
      const ta = document.querySelector("textarea[class*=reply], .reply-input textarea, textarea");
      if (ta) {
        const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set;
        ta.focus();
        if (setter) setter.call(ta, body); else ta.value = body;
        ta.dispatchEvent(new Event("input", { bubbles: true }));
        ta.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
      const ce = document.querySelector('[contenteditable="true"]');
      if (ce) { ce.focus(); ce.innerText = body; ce.dispatchEvent(new Event("input", { bubbles: true })); return true; }
      return false;
    })()`, { timeoutMs: 10_000 });

    if (!ok) throw new TiebaError('回帖内容填不进输入框，贴吧可能改版了', 'FILL');

    // 提交按钮：多候选；找不到就不点，宁可报错也不乱点页面上的「发贴」
    const clicked = await p.eval(`(() => {
      const cands = [
        ".reply-submit", ".submit-btn", ".post-submit", "button[class*=submit]",
        ".pb-reply-submit", "a[class*=submit]", "span[class*=submit]",
      ];
      for (const s of cands) {
        const el = document.querySelector(s);
        if (el && /发表|发送|提交|回复|确定/.test(el.innerText || "")) { el.click(); return s; }
      }
      // 兜底：找文本是「发表」的按钮
      for (const el of document.querySelectorAll("button, a, div, span")) {
        if (el.children.length === 0 && /^(发表|发送|提交)$/.test((el.innerText || "").trim())) { el.click(); return "text"; }
      }
      return null;
    })()`, { timeoutMs: 10_000 });

    if (!clicked) throw new TiebaError('找不到提交按钮，贴吧可能改版了（内容已填但没发出去）', 'NO_SUBMIT');

    // 发出去之后贴吧会弹验证码 / 或者直接出现在列表里。给几秒看结果。
    await sleep(2500);
    const after = await p.text().catch(() => '');
    if (/验证码|安全验证|操作过于频繁/.test(after)) {
      throw new TiebaError('贴吧要验证码（或者判定操作太快了），这条没发出去。过一会儿再试。', 'RISK');
    }
    return { ok: true, tid, url, text: body, submittedAt: new Date().toISOString() };
  }, { timeoutMs: 60_000 });
}

// ─── 关注吧（写操作）───────────────────────────────────────
/**
 * 关注吧。跟回帖一样：先登录、再节流，最后才点。
 * 移动版吧首页的「关注」按钮是 a.operation_right_btn；点了会变「已关注」。
 */
export async function followForum(name) {
  const forum = String(name ?? '').trim().replace(/吧$/, '');
  if (!forum) throw new TiebaError('吧名是空的，要关注哪个吧？', 'BAD_FORUM');

  await canWrite();
  await throttle('follow');

  return withPage(forumUrl(forum), async (p) => {
    await p.waitFor('document.querySelector("ul.threads_list, .threads_list")', { timeoutMs: 20_000 }).catch(() => null);

    const state = await p.eval(`(() => {
      // 已经在关注的吧上点「关注」不会出错，但没必要浪费一次请求
      const btn = document.querySelector("a.operation_right_btn, .forum_info .focus, a[class*=operation_right]");
      if (!btn) return { found: false };
      const label = (btn.innerText || "").trim();
      return { found: true, label, followed: /已关注|取消关注/.test(label) };
    })()`, { timeoutMs: 10_000 }).catch(() => ({ found: false }));

    if (!state.found) {
      const hint = await p.text().catch(() => '');
      if (/先登录|登录后/.test(hint)) throw new TiebaError('还没登录贴吧，先扫码登录再关注', 'NOT_LOGGED_IN');
      throw new TiebaError(`没找到「${forum}」吧的关注按钮，贴吧可能改版了`, 'NO_BUTTON');
    }
    if (state.followed) return { ok: true, forum, already: true };

    const clicked = await p.eval(`(() => {
      const btn = document.querySelector("a.operation_right_btn, .forum_info .focus, a[class*=operation_right]");
      if (!btn) return false;
      btn.scrollIntoView({ block: "center" });
      btn.click();
      return true;
    })()`, { timeoutMs: 10_000 });

    if (!clicked) throw new TiebaError(`点不动「${forum}」吧的关注按钮`, 'CLICK');

    await sleep(2000);
    const now = await p.eval(`(() => {
      const btn = document.querySelector("a.operation_right_btn, .forum_info .focus, a[class*=operation_right]");
      return btn ? (btn.innerText || "").trim() : "";
    })()`, { timeoutMs: 10_000 }).catch(() => '');

    if (!/已关注|取消关注/.test(now)) {
      throw new TiebaError(`点了关注但状态没变（现在显示「${now || '空'}」），可能要登录或者被风控了`, 'NOT_CONFIRMED');
    }
    return { ok: true, forum, already: false };
  }, { timeoutMs: 40_000 });
}
