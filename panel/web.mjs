/**
 * 「她的网页浏览器」：一个专用的 Chrome，让她能真的逛贴吧、刷抖音
 *
 * 为什么不用 fetch：贴吧桌面版直接 403「百度安全验证」，抖音同理。
 * 只有真浏览器、真 JS、真指纹才能拿到内容 —— 这也正是她「像人一样逛」该有的样子。
 *
 * 和 browser.mjs（B站专用窗口）的分工：
 *  - browser.mjs：把 B站 引擎的 cookie 塞进浏览器，只为了「用她的会话点一下」；
 *  - 这里：完全独立的浏览器，自己登录贴吧/抖音，登录态持久化在 data/web-browser 里。
 * 两者互不干扰，B站 那个窗口的 passport 屏蔽策略仍然有效。
 *
 * 几个必须踩对的坑（都是实测出来的）：
 *  1. Chrome 156 起对 DevTools 的 WebSocket 做 Origin 校验，Node 内置 WebSocket 不发 Origin → 握手后立刻 1006。
 *     所以用 cdp.mjs 自己实现的客户端，带本机同源 Origin。
 *  2. 在 DSH 的沙箱里 Chrome 起不来（sandbox initialization failed → GPU 进程崩溃 → FATAL Goodbye）。
 *     默认先按正常参数起，起不来自动退到 --no-sandbox --disable-gpu 再试一次。
 *  3. 贴吧桌面版（/f?kw=）永远撞「百度安全验证」，移动版 /mo/q/m 反而干净可用。
 *  4. 默认无头（--headless=new）跑在后台：有窗口时每开一个标签页 macOS 都会把它提到最前面，
 *     号主正在用电脑就被打断。无头版的 UA 里写着 HeadlessChrome，会被站点认出来，
 *     所以每个页面都把 UA 和 userAgentData 改回普通 Chrome 的样子。
 *     要看她在干嘛（或者扫码后要在网页上再验证一步），面板「逛逛」里打开「显示浏览器窗口」。
 *
 * 需要：Google Chrome（WEB_BROWSER 可指定路径）、Node ≥ 18（cdp.mjs 不依赖内置 WebSocket）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connectWs } from './cdp.mjs';
import { readConfig } from './store.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const DATA = process.env.YANGYU_DATA || join(here, 'data');
const PROFILE = join(DATA, 'web-browser');

const CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

/** 正常参数；沙箱里起不来就用 fallback */
const ARGS_BASE = [
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-blink-features=AutomationControlled', // 别主动告诉网站「我是自动化的」
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--lang=zh-CN',
  '--mute-audio', // 抖音视频会自动播放，别从号主的音箱里出声
];
const ARGS_HEADLESS = ['--headless=new', '--hide-scrollbars'];

/** 要不要显示窗口：默认不显示。面板里的 web.showWindow，或者环境变量 WEB_SHOW=1/0 */
export function wantWindow() {
  if (process.env.WEB_SHOW === '1') return true;
  if (process.env.WEB_SHOW === '0') return false;
  try { return !!readConfig().web?.showWindow; } catch { return false; }
}
const ARGS_SANDBOXLESS = ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage'];

function findBrowser() {
  const custom = process.env.WEB_BROWSER;
  if (custom) {
    if (!existsSync(custom)) throw new Error(`WEB_BROWSER 指的 ${custom} 不存在`);
    return custom;
  }
  const hit = CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error('没找到 Chrome / Edge / Chromium，装一个，或者用 WEB_BROWSER 环境变量指定路径');
  return hit;
}

function devToolsPort() {
  const f = join(PROFILE, 'DevToolsActivePort');
  if (!existsSync(f)) return null;
  try {
    const port = Number(readFileSync(f, 'utf-8').split('\n')[0]);
    return Number.isFinite(port) && port > 0 ? port : null;
  } catch {
    return null;
  }
}

async function liveWs(port) {
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    return v.webSocketDebuggerUrl || null;
  } catch {
    return null;
  }
}

// ─── 常驻连接 ───────────────────────────────────────────────
// MODE_FILE 必须在 readModePref() 被调用之前定义：以前它写在 launchMode 下面，
// 读文件时撞 TDZ 抛 ReferenceError，又被 try/catch 吞掉，记下的模式永远读不回来。
const MODE_FILE = join(DATA, 'web-browser.mode');

let conn = null;
let connecting = null;
let launchMode = readModePref(); // 'plain' | 'sandboxless'，记住哪种能起来，下次直接用它

function readModePref() {
  const forced = process.env.WEB_MODE;
  if (forced === 'plain' || forced === 'sandboxless') return forced;
  try {
    const m = readFileSync(MODE_FILE, 'utf-8').trim();
    return m === 'plain' || m === 'sandboxless' ? m : null;
  } catch {
    return null;
  }
}
function saveModePref(m) {
  try { mkdirSync(DATA, { recursive: true }); writeFileSync(MODE_FILE, m, 'utf-8'); } catch { /* 记不住就每次试 */ }
}

/** 连上（必要时先把浏览器拉起来），返回 browser 级的 CDP 连接 */
export async function browser() {
  if (conn && !conn.closed) return conn;
  if (connecting) return connecting;
  connecting = (async () => {
    // 已经开着的浏览器直接复用 —— 但有没有窗口得跟现在的设置对得上，
    // 不然号主刚关掉「显示窗口」，那个老窗口还会一直弹
    const port = devToolsPort();
    if (port) {
      const ws = await liveWs(port);
      if (ws) {
        const c = await attach(ws);
        if (await alive(c)) {
          await prepare(c);
          if (c.headless === !wantWindow()) { conn = c; return conn; }
          await c.send('Browser.close').catch(() => {});
          c.close();
          await waitGone(port);
        } else {
          c.close();
        }
      }
    }
    const modes = launchMode ? [launchMode, launchMode === 'plain' ? 'sandboxless' : 'plain'] : ['plain', 'sandboxless'];
    let lastErr = null;
    for (const mode of modes) {
      try {
        const c = await launch(mode);
        if (launchMode !== mode) { launchMode = mode; saveModePref(mode); }
        await prepare(c);
        conn = c;
        return conn;
      } catch (err) {
        lastErr = err;
        clearStaleProfile();
      }
    }
    throw new Error(`浏览器起不来：${lastErr?.message || '未知原因'}`);
  })().finally(() => { connecting = null; });
  return connecting;
}

async function attach(wsUrl) {
  const c = await connectWs(wsUrl);
  c.on('close', () => { if (conn === c) conn = null; });
  return c;
}

/**
 * 记下这个浏览器是不是无头的；无头的话准备一份「普通 Chrome」的 UA，开页面时套上。
 * 只改 UA 字符串不够：navigator.userAgentData.brands 里也会写 HeadlessChrome。
 */
async function prepare(c) {
  const v = await c.send('Browser.getVersion').catch(() => null);
  const ua = v?.userAgent || '';
  c.headless = /HeadlessChrome/.test(ua) || /^HeadlessChrome/.test(v?.product || '');
  c.uaOverride = null;
  if (!c.headless) return;
  const full = (/Chrome\/([\d.]+)/.exec(ua) || [])[1] || '';
  const major = full.split('.')[0] || '';
  c.uaOverride = {
    userAgent: ua.replace('HeadlessChrome', 'Chrome'),
    acceptLanguage: 'zh-CN,zh;q=0.9',
    userAgentMetadata: {
      brands: [
        { brand: 'Google Chrome', version: major },
        { brand: 'Chromium', version: major },
        { brand: 'Not=A?Brand', version: '99' },
      ],
      fullVersion: full,
      platform: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux',
      platformVersion: '',
      architecture: process.arch === 'arm64' ? 'arm' : 'x86',
      model: '',
      mobile: false,
    },
  };
}

/** 等老的浏览器真退出（调试端口不响应了），不然新实例会撞同一个配置目录的锁 */
async function waitGone(port) {
  for (let i = 0; i < 40; i++) {
    if (!(await liveWs(port))) return;
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** 真的发一条命令试试 —— 端口响应不代表浏览器还活着（沙箱里它会在几秒后 FATAL 退出） */
async function alive(c) {
  try {
    const v = await withTimeout(c.send('Browser.getVersion'), 3000, '浏览器没有响应');
    return !!v?.product;
  } catch {
    return false;
  }
}

async function launch(mode) {
  mkdirSync(PROFILE, { recursive: true });
  const args = [
    `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=0', // 随机端口，只监听本机
    ...ARGS_BASE,
    ...(mode === 'sandboxless' ? ARGS_SANDBOXLESS : []),
    ...(wantWindow() ? [] : ARGS_HEADLESS),
    '--window-size=1280,900',
    'about:blank',
  ];
  const child = spawn(findBrowser(), args, { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  let ws = null;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 200));
    const port = devToolsPort();
    if (!port) continue;
    ws = await liveWs(port);
    if (ws) break;
  }
  if (!ws) throw new Error(`浏览器（${mode}）起不来：没有等到调试端口`);
  const c = await attach(ws);
  // 端口开了不代表稳：沙箱里 Chrome 会因为 GPU 进程反复崩溃直接 FATAL 退出。
  // 真发一条命令 + 再等一会儿确认它还活着，才算这个模式可用。
  if (!(await alive(c))) {
    c.close();
    throw new Error(`浏览器（${mode}）起来了但马上就没响应（多半是沙箱限制）`);
  }
  await new Promise((r) => setTimeout(r, 800));
  if (c.closed || !(await alive(c))) {
    c.close();
    throw new Error(`浏览器（${mode}）启动后很快就退出了（多半是沙箱限制）`);
  }
  return c;
}

/** 上次崩死留下的 Singleton* 会让新实例以为「配置目录正被占用」，清掉再起 */
function clearStaleProfile() {
  for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
    try { rmSync(join(PROFILE, f), { force: true }); } catch { /* 清不掉就算了 */ }
  }
}

// ─── 页面 ──────────────────────────────────────────────────
/**
 * 开一个标签页，交给 fn，做完自动关掉。
 * @param {string} url
 * @param {(page: Page) => Promise<any>} fn
 * @param {{keep?: boolean, reuse?: boolean}} opts keep=true 就留着这个标签（登录页这种要给用户看的）
 */
export async function withPage(url, fn, opts = {}) {
  const page = await openPage(url, opts);
  try {
    return await fn(page);
  } finally {
    if (!opts.keep) await page.close().catch(() => {});
  }
}

export async function openPage(url, { timeoutMs = 20000 } = {}) {
  const c = await browser();
  // background：有窗口时也别把新标签页切到前台
  const { targetId } = await c.send('Target.createTarget', { url: 'about:blank', background: true });
  const { sessionId } = await c.send('Target.attachToTarget', { targetId, flatten: true });
  const page = new Page(c, targetId, sessionId);
  if (c.uaOverride) await page.send('Emulation.setUserAgentOverride', c.uaOverride).catch(() => {});
  await page.enable();
  if (url) await page.goto(url, { timeoutMs });
  return page;
}

export class Page {
  constructor(c, targetId, sessionId) {
    this.c = c;
    this.targetId = targetId;
    this.sessionId = sessionId;
  }

  send(method, params = {}) { return this.c.send(method, params, this.sessionId); }

  async enable() {
    await this.send('Page.enable');
    await this.send('Runtime.enable').catch(() => {});
  }

  /** 打开页面并等 load；不是每次都能等到 loadEventFired，超时也当成功（SPA 会一直挂着） */
  async goto(url, { timeoutMs = 20000 } = {}) {
    const loaded = this.c.waitEvent('Page.loadEventFired', timeoutMs).catch(() => null);
    await this.send('Page.navigate', { url });
    await loaded;
    return this;
  }

  /** 在页面里跑一段表达式，返回它的值（自动序列化） */
  async eval(expression, { timeoutMs = 20000, awaitPromise = true } = {}) {
    const r = await withTimeout(
      this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise, userGesture: true }),
      timeoutMs,
      '页面里跑脚本超时',
    );
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || '页面脚本报错');
    return r.result?.value;
  }

  async text() {
    return this.eval('document.body ? document.body.innerText : ""');
  }

  /** 等某个条件在页面里成立（表达式返回真值） */
  async waitFor(expression, { timeoutMs = 20000, interval = 300 } = {}) {
    const end = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < end) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch { /* 页面还在跳，下一轮再看 */ }
      await new Promise((r) => setTimeout(r, interval));
    }
    throw new Error(`等不到页面出现想要的元素：${expression.slice(0, 80)}`);
  }

  /** 点一个元素：先滚到视野里，再点 */
  async click(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      el.scrollIntoView({ block: 'center' });
      el.click();
      return true;
    })()`);
  }

  /** 往输入框里填字（走原生 setter + input 事件，React 那种受控组件才认） */
  async fill(selector, value) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return false;
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      el.focus();
      if (setter) setter.call(el, ${JSON.stringify(value)}); else el.value = ${JSON.stringify(value)};
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    })()`);
  }

  /** 截图（PNG 的 base64），用来把登录二维码直接给她看 */
  async screenshot({ fullPage = false } = {}) {
    if (fullPage) {
      const m = await this.send('Page.getLayoutMetrics').catch(() => null);
      const h = m?.cssContentSize?.height;
      if (h) await this.send('Emulation.setDeviceMetricsOverride', {
        width: Math.round(m.cssContentSize.width), height: Math.round(h), deviceScaleFactor: 1, mobile: false,
      }).catch(() => {});
    }
    const r = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: fullPage });
    return r.data;
  }

  async url() {
    const r = await this.send('Runtime.evaluate', { expression: 'location.href', returnByValue: true }).catch(() => null);
    return r?.result?.value || '';
  }

  async close() {
    await this.c.send('Target.closeTarget', { targetId: this.targetId }).catch(() => {});
  }
}

function withTimeout(p, ms, msg) {
  let t;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise((_, bad) => { t = setTimeout(() => bad(new Error(msg)), ms); }),
  ]);
}

// ─── 状态 ──────────────────────────────────────────────────
export async function status() {
  const port = devToolsPort();
  const ws = port ? await liveWs(port) : null;
  return {
    running: !!ws,
    port: port || null,
    profile: PROFILE,
    launchMode,
    headless: conn && !conn.closed ? !!conn.headless : !wantWindow(),
    login: existsSync(join(PROFILE, 'Default', 'Cookies')),
  };
}

/** 关掉浏览器（她逛完、或者卡住了要重开） */
export async function shutdown() {
  try {
    if (conn && !conn.closed) {
      await conn.send('Browser.close').catch(() => {});
      conn.close();
    }
  } catch { /* 已经关了 */ }
  conn = null;
}

/** 给用户看的登录窗口：把某个站点打开并留在那儿，让他自己扫码 */
export async function openForLogin(url) {
  const page = await openPage(url, { timeoutMs: 30000 });
  const c = await browser();
  await c.send('Target.activateTarget', { targetId: page.targetId }).catch(() => {});
  return page;
}
