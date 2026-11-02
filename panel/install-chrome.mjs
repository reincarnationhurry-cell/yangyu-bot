/**
 * 装一份她专用的 Chrome for Testing 到 panel/data/chrome（为什么要它见 chrome.mjs 开头）
 *
 *   node panel/install-chrome.mjs        装最新稳定版；已经是最新就什么都不做
 *
 * 不用 npx @puppeteer/browsers：面板没有 npm 依赖，而且实测它在沙箱里解压会静悄悄只解出一半。
 * 这里直接读官方的版本清单，curl 式下载，macOS 用 ditto 解压（保留 app 包里的符号链接）。
 */
import { spawnSync } from 'node:child_process';
import { createWriteStream, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { CFT_DIR, bundledChrome } from './chrome.mjs';

const LIST = 'https://googlechromelabs.github.io/chrome-for-testing/last-known-good-versions-with-downloads.json';

function platform() {
  const { platform: p, arch } = process;
  if (p === 'darwin') return arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  if (p === 'linux' && arch === 'x64') return 'linux64';
  if (p === 'win32') return arch === 'ia32' ? 'win32' : 'win64';
  return null;
}

function unzip(zip, dest) {
  const [cmd, args] = process.platform === 'darwin' ? ['ditto', ['-x', '-k', zip, dest]]
    : process.platform === 'win32' ? ['tar', ['-xf', zip, '-C', dest]]
    : ['unzip', ['-q', zip, '-d', dest]];
  const r = spawnSync(cmd, args, { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`解压失败（${cmd}）`);
}

async function main() {
  const plat = platform();
  if (!plat) throw new Error(`Chrome for Testing 没有 ${process.platform}/${process.arch} 的版本`);
  const list = await fetch(LIST, { signal: AbortSignal.timeout(20_000) }).then((r) => r.json());
  const stable = list.channels.Stable;
  const url = stable.downloads.chrome.find((d) => d.platform === plat)?.url;
  if (!url) throw new Error(`清单里没有 ${plat} 的下载地址`);

  const dest = join(CFT_DIR, stable.version);
  const have = bundledChrome();
  if (have?.startsWith(dest)) {
    console.log(`已经是最新的 Chrome for Testing ${stable.version}`);
    return;
  }

  mkdirSync(CFT_DIR, { recursive: true });
  const zip = join(CFT_DIR, `${stable.version}.zip`);
  const tmp = `${dest}.part`;
  rmSync(tmp, { recursive: true, force: true });
  console.log(`下载 Chrome for Testing ${stable.version}（约 200MB）…`);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`下载失败：HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(zip));
    mkdirSync(tmp, { recursive: true });
    unzip(zip, tmp);
    renameSync(tmp, dest); // 解压完整了才改名，半截的目录不会被 bundledChrome() 认成可用
  } finally {
    rmSync(zip, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
  if (!bundledChrome()?.startsWith(dest)) throw new Error('解压出来了，但找不到可执行文件');

  // 老版本删掉，省两三百兆。正在跑的老实例不受影响（macOS 上删了也能接着跑到退出）
  for (const v of readdirSync(CFT_DIR)) {
    if (v !== stable.version && /^\d+(\.\d+)+$/.test(v)) rmSync(join(CFT_DIR, v), { recursive: true, force: true });
  }
  console.log(`装好了：${bundledChrome()}`);
}

main().catch((err) => {
  console.error(`装 Chrome for Testing 失败：${err.message}`);
  process.exit(1);
});
