import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
const health = await import('../health.mjs');

const plugin = (version, list) => ({ version, range: list.join(' || '), exact: list });
const NOW = Date.parse('2026-10-24T12:00:00Z');

test('diagnose：版本对得上、网关这次启动后就绪了 → 没事', () => {
  const r = health.diagnose({ host: '0.2.1-rc.3', plugin: plugin('1.0.15', ['0.2.1-rc.2', '0.2.1-rc.3']), startedAt: NOW - 3600_000, gateway: { ready: NOW - 3500_000 }, now: NOW });
  assert.equal(r.ok, true);
});

test('diagnose：DSH 升到插件不认的版本 → 报版本问题，告诉你怎么修', () => {
  const r = health.diagnose({ host: '0.2.1-rc.3', plugin: plugin('1.0.8', ['0.2.1-rc.1', '0.2.1-rc.2']), startedAt: NOW - 3600_000, gateway: { ready: NOW - 7200_000 }, now: NOW });
  assert.deepEqual(r.problems.map((p) => p.code), ['version', 'gateway']);
  assert.match(r.problems[0].text, /0\.2\.1-rc\.3.*1\.0\.8.*0\.2\.1-rc\.2/);
  assert.match(r.problems[0].fix, /插件市场/);
});

test('diagnose：DSH 刚启动不急着报；没开 DSH 不报网关', () => {
  assert.equal(health.diagnose({ host: '0.2.1-rc.3', plugin: plugin('1.0.15', ['0.2.1-rc.3']), startedAt: NOW - 60_000, gateway: { ready: null }, now: NOW }).ok, true);
  assert.equal(health.diagnose({ host: '0.2.1-rc.3', plugin: plugin('1.0.15', ['0.2.1-rc.3']), startedAt: null, gateway: { ready: null }, now: NOW }).ok, true);
});

test('diagnose：写成 ^ 范围的不判断版本；没装插件要说', () => {
  assert.equal(health.diagnose({ host: '9.9.9', plugin: { version: '2.0.0', range: '^0.2.0', exact: null }, startedAt: null, now: NOW }).ok, true);
  assert.equal(health.diagnose({ host: '0.2.1', plugin: null, startedAt: null, now: NOW }).problems[0].code, 'no-plugin');
});

test('pluginInfo / lastGatewayReady：读真文件格式', () => {
  const dir = mkdtempSync(join(tmpdir(), 'health-'));
  const pkg = join(dir, 'package.json');
  writeFileSync(pkg, JSON.stringify({ version: '1.0.15', peerDependencies: { '@deepseek-ai/dsh-agent': '0.2.0-rc.1 || 0.2.1-rc.3' } }));
  assert.deepEqual(health.pluginInfo(pkg).exact, ['0.2.0-rc.1', '0.2.1-rc.3']);
  const log = join(dir, 'gateway.log');
  writeFileSync(log, '2026-10-24T12:34:49.123Z [qq] 网关就绪\n2026-10-24T12:40:19.778Z [qq] 已收到 Hello，正在鉴权\n2026-10-24T12:40:20.200Z [qq] 网关就绪\n2026-10-24T13:01:42.676Z [router] 已把 x 挂到工作区\n');
  assert.equal(health.lastGatewayReady(log).ready, Date.parse('2026-10-24T12:40:20.200Z'));
});
