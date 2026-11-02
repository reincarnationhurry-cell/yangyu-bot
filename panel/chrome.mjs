/**
 * 找浏览器：web.mjs（贴吧 / 抖音）和 browser.mjs（B站 窗口）共用
 *
 * 为什么优先用自带的 Chrome for Testing（panel/data/chrome，node panel/install-chrome.mjs 装）：
 * macOS 按 bundle id 认 app。她的无头 Chrome 要是从 /Applications/Google Chrome.app 起的，
 * 就和号主的 Chrome 是「同一个 app」—— 号主点 Dock 图标，系统发现它已经在跑，
 * 只把那个没窗口的后台实例叫到前台，号主自己的 Chrome 怎么都打不开，⌘Q 也退不掉。
 * Chrome for Testing 的 bundle id 是 com.google.chrome.for.testing，两边互不相干。
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const CFT_DIR = join(here, 'data', 'chrome');

/** 解压后每个平台的可执行文件在哪（相对于版本目录） */
const CFT_EXEC = [
  'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
  'chrome-linux64/chrome',
  'chrome-win64/chrome.exe',
  'chrome-win32/chrome.exe',
];

const SYSTEM = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/microsoft-edge',
];

/** 版本号按数字比，156.0.10 > 156.0.9 */
export function cmpVersion(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] || 0) - (y[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** 自带的 Chrome for Testing，有好几个版本就用最新的；没装返回 null */
export function bundledChrome(dir = CFT_DIR) {
  let versions;
  try { versions = readdirSync(dir).filter((v) => /^\d+(\.\d+)+$/.test(v)); } catch { return null; }
  for (const v of versions.sort(cmpVersion).reverse()) {
    const hit = CFT_EXEC.map((p) => join(dir, v, p)).find((p) => existsSync(p));
    if (hit) return hit;
  }
  return null;
}

export function isBundled(path) {
  return !!path && path.startsWith(CFT_DIR);
}

/** 环境变量指定的 > 自带的 Chrome for Testing > 系统里装的 */
export function findChrome(envName) {
  const custom = process.env[envName];
  if (custom) {
    if (!existsSync(custom)) throw new Error(`${envName} 指的 ${custom} 不存在`);
    return custom;
  }
  const hit = bundledChrome() || SYSTEM.find((p) => existsSync(p));
  if (!hit) throw new Error(`没找到 Chrome / Edge / Chromium：跑 node panel/install-chrome.mjs 装一个，或者用 ${envName} 环境变量指定路径`);
  return hit;
}

/**
 * 自带的 Chrome for Testing 要加的参数。
 * --use-mock-keychain：它是个新 app，第一次读钥匙串会弹「想使用你的机密信息」，后台跑着没人点就一直卡着。
 * 代价是 cookie 不再用钥匙串加密 —— 配置目录本来就在 panel/data 里，只给她用。
 */
export function bundledArgs(path) {
  return isBundled(path) && process.platform === 'darwin' ? ['--use-mock-keychain'] : [];
}
