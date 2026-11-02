// 找浏览器：自带的 Chrome for Testing 要排在系统 Chrome 前面，几个版本取最新，解压半截的不认
import { DATA } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { cmpVersion, bundledChrome, findChrome, isBundled, bundledArgs, CFT_DIR } from '../chrome.mjs';

const EXEC = 'chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
const fake = (dir, rel) => { mkdirSync(dirname(join(dir, rel)), { recursive: true }); writeFileSync(join(dir, rel), ''); };

test('cmpVersion：按数字比，不按字符串比', () => {
  assert.ok(cmpVersion('156.0.10.1', '156.0.9.1') > 0);
  assert.ok(cmpVersion('99.0.0.0', '156.0.0.0') < 0);
  assert.equal(cmpVersion('156.0.1', '156.0.1'), 0);
});

test('bundledChrome：取最新版本；.part（没解压完）和缺可执行文件的版本都跳过', () => {
  const dir = join(DATA, 'cft');
  fake(dir, join('155.0.1.1', EXEC));
  fake(dir, join('156.0.2.2', EXEC));
  fake(dir, join('157.0.0.0.part', EXEC));
  mkdirSync(join(dir, '158.0.0.0'), { recursive: true });
  assert.equal(bundledChrome(dir), join(dir, '156.0.2.2', EXEC));
  assert.equal(bundledChrome(join(DATA, 'nope')), null);
});

test('findChrome：环境变量优先；指的路径不存在就报错，不偷偷换别的', () => {
  const p = join(DATA, 'my-chrome');
  writeFileSync(p, '');
  process.env.X_CHROME_TEST = p;
  assert.equal(findChrome('X_CHROME_TEST'), p);
  process.env.X_CHROME_TEST = join(DATA, 'missing');
  assert.throws(() => findChrome('X_CHROME_TEST'), /不存在/);
  delete process.env.X_CHROME_TEST;
});

test('只有自带的那份才加 --use-mock-keychain（系统 Chrome 要用钥匙串解开已有的登录态）', () => {
  const mine = join(CFT_DIR, '156.0.2.2', EXEC);
  assert.equal(isBundled(mine), true);
  assert.equal(isBundled('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), false);
  assert.deepEqual(bundledArgs('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'), []);
  if (process.platform === 'darwin') assert.deepEqual(bundledArgs(mine), ['--use-mock-keychain']);
});
