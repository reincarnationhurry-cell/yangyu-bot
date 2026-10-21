/**
 * 「她的浏览器」：一个专用的 Chrome 窗口，直接用养鱼引擎自己的登录态
 *
 * 为什么要有它：点赞 / 分享被 B站 风控拦着时，得在真浏览器里点。
 *  - 用你平时的浏览器点 → 是你自己的号在点，不是她；
 *  - 在浏览器里重新登录她的号 → B站 视为一次新登录，引擎手里的 SESSDATA 会被挤掉（面板「掉登录」）。
 * 这里的做法：开一个独立配置目录的 Chrome（panel/data/bili-browser，和你日常的浏览器互不影响），
 * 通过 DevTools 协议把 cookie.json 里的会话 + 引擎的设备标识（buvid）原样塞进去。
 * 浏览器和引擎用的是同一个会话、同一台「设备」，没有新登录，谁也挤不掉谁。
 *
 * 保护措施：passport.bilibili.com 在这个窗口里被屏蔽（解析不到）。
 * 登录、退出登录、网页端的 cookie 刷新都走这个域名 —— 任何一个发生都会让引擎手里的会话作废。
 * 点赞 / 分享 / 投币 / 评论走 api.bilibili.com，不受影响。
 *
 * 不是绕风控：真浏览器、真人点击，只是不重新登录。浏览器指纹一点没动。
 *
 * 需要：Google Chrome / Edge / Chromium（BILI_BROWSER 可指定可执行文件）；Node ≥ 22（内置 WebSocket）。
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCookie, getDevice } from './bili.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const PROFILE = join(here, 'data', 'bili-browser');

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

function findBrowser() {
  const custom = process.env.BILI_BROWSER;
  if (custom) {
    if (!existsSync(custom)) throw new Error(`BILI_BROWSER 指的 ${custom} 不存在`);
    return custom;
  }
  const hit = CANDIDATES.find((p) => existsSync(p));
  if (!hit) throw new Error('没找到 Chrome / Edge / Chromium。装一个，或者用 BILI_BROWSER 环境变量指定路径');
  return hit;
}

/** 专用窗口已经开着的话，拿它的 DevTools 地址 */
async function existingEndpoint() {
  const f = join(PROFILE, 'DevToolsActivePort');
  if (!existsSync(f)) return null;
  const port = Number(readFileSync(f, 'utf-8').split('\n')[0]);
  if (!port) return null;
  try {
    const v = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.json());
    return v.webSocketDebuggerUrl || null;
  } catch {
    return null; // 文件是上次留下的，浏览器早关了
  }
}

async function launch() {
  mkdirSync(PROFILE, { recursive: true });
  const child = spawn(findBrowser(), [
    `--user-data-dir=${PROFILE}`,
    '--remote-debugging-port=0', // 随机端口，只监听本机；实际端口写在 DevToolsActivePort
    '--no-first-run',
    '--no-default-browser-check',
    '--host-resolver-rules=MAP passport.bilibili.com ~NOTFOUND',
    'about:blank',
  ], { detached: true, stdio: 'ignore' });
  child.on('error', () => {});
  child.unref();
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 250));
    const ws = await existingEndpoint();
    if (ws) return ws;
  }
  throw new Error('浏览器打开了，但连不上它的调试端口。把那个窗口关掉再试一次');
}

/** 极简 CDP 客户端：发一串命令就断开，不常驻 */
async function withCdp(wsUrl, fn) {
  if (typeof WebSocket === 'undefined') throw new Error('要 Node 22 以上才能开她的浏览器（需要内置 WebSocket）');
  const ws = new WebSocket(wsUrl);
  await new Promise((ok, bad) => {
    ws.onopen = ok;
    ws.onerror = () => bad(new Error('连不上浏览器的调试端口'));
  });
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    const p = m.id && pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.error ? p.bad(new Error(m.error.message)) : p.ok(m.result);
  };
  const send = (method, params = {}) => new Promise((ok, bad) => {
    const id = ++seq;
    pending.set(id, { ok, bad });
    ws.send(JSON.stringify({ id, method, params }));
  });
  try {
    return await fn(send);
  } finally {
    ws.close();
  }
}

/** 引擎当前的会话，转成浏览器 cookie。refresh_token 故意不给：给了网页就可能自己刷新 cookie，把引擎那份作废 */
async function sessionCookies() {
  const ck = loadCookie();
  const expires = Math.floor(Date.now() / 1000) + 30 * 86400; // 每次打开都会重新塞一遍，过期时间无所谓
  const base = { domain: '.bilibili.com', path: '/', secure: true, sameSite: 'Lax', expires };
  const list = [
    { name: 'SESSDATA', value: ck.sessdata, httpOnly: true },
    { name: 'bili_jct', value: ck.bili_jct || '' },
    { name: 'DedeUserID', value: ck.dede_user_id || '' },
  ];
  for (const [k, v] of Object.entries(ck.extra || {})) if (/^\w+$/.test(k) && v) list.push({ name: k, value: String(v) });
  try {
    // 和引擎用同一个设备标识：在 B站 眼里还是同一台机器
    const d = await getDevice();
    list.push({ name: 'buvid3', value: d.buvid3 }, { name: 'b_nut', value: d.b_nut });
    if (d.buvid4) list.push({ name: 'buvid4', value: encodeURIComponent(d.buvid4) });
  } catch { /* 拿不到就让网页自己领 */ }
  return list.filter((c) => c.value).map((c) => ({ ...base, ...c }));
}

/** 在她的浏览器里打开一个 B站 页面 */
export async function openAsHer(url) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || !/(^|\.)bilibili\.com$/.test(u.hostname)) throw new Error('只打开 B站 的页面');
  const cookies = await sessionCookies();
  const wsUrl = (await existingEndpoint()) || (await launch());
  await withCdp(wsUrl, async (send) => {
    await send('Storage.setCookies', { cookies });
    const { targetId } = await send('Target.createTarget', { url: u.href });
    await send('Target.activateTarget', { targetId }).catch(() => {});
  });
  return { ok: true };
}
