import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const sky = await import('../sky.mjs');

// 深圳；时间都用带时区的字符串，跟跑测试的机器在哪无关（日出日落按本地「这一天」找，所以只比时刻差）
const SZ = [22.54, 114.06];
const near = (a, b, min) => Math.abs(a.getTime() - b.getTime()) <= min * 60_000;

test('sunTimes：深圳 2026-10-21 日出 06:24、日落 17:52，误差两分钟内', { skip: new Date().getTimezoneOffset() !== -480 && '只在东八区跑' }, () => {
  const t = sky.sunTimes(new Date('2026-10-21T12:00:00+08:00'), ...SZ);
  assert.ok(near(t.rise, new Date('2026-10-21T06:24:00+08:00'), 2), String(t.rise));
  assert.ok(near(t.set, new Date('2026-10-21T17:52:00+08:00'), 2), String(t.set));
});

test('sunAltitude：中午在头顶附近，半夜在地平线下很深', () => {
  assert.ok(sky.sunAltitude(new Date('2026-10-21T12:07:00+08:00'), ...SZ) > 50);
  assert.ok(sky.sunAltitude(new Date('2026-10-22T00:07:00+08:00'), ...SZ) < -60);
});

test('moonPhase：日食那刻是新月，2026-10-26 满月，上弦附近一半亮', () => {
  assert.equal(sky.moonPhase(new Date('2024-04-08T18:21:00Z')).name, '新月');
  const full = sky.moonPhase(new Date('2026-10-26T04:11:00Z'));
  assert.equal(full.name, '满月');
  assert.ok(full.lit > 0.99);
  assert.equal(sky.moonPhase(new Date('2026-10-24T12:53:00Z')).name, '盈凸月', '离满月还有一天半');
  const q = sky.moonPhase(new Date('2026-10-18T16:13:00Z')); // 上弦
  assert.ok(Math.abs(q.lit - 0.5) < 0.05, String(q.lit));
});

test('weatherName：常见代码', () => {
  assert.equal(sky.weatherName(0), '晴');
  assert.equal(sky.weatherName(63), '中雨');
  assert.equal(sky.weatherName(95), '雷雨');
  assert.equal(sky.weatherName(42), '');
});

const fakeWeather = (calls) => async () => {
  calls.n++;
  return { json: async () => ({ current: { temperature_2m: 18.4, apparent_temperature: 15.6, relative_humidity_2m: 80, weather_code: 61 } }) };
};

test('skyText：有地点就说天气、日落、月亮；天气一小时只查一次', async () => {
  const calls = { n: 0 };
  const cfg = { lat: SZ[0], lon: SZ[1], label: '深圳' };
  const now = new Date('2026-10-21T21:45:00+08:00');
  const t = await sky.skyText({ now, cfg, fetchFn: fakeWeather(calls) });
  assert.match(t, /深圳/);
  assert.match(t, /小雨，18°C（体感 16°）/);
  assert.match(t, /落山/);
  assert.match(t, /盈凸月/);
  await sky.skyText({ now: new Date(now.getTime() + 20 * 60_000), cfg, fetchFn: fakeWeather(calls) });
  assert.equal(calls.n, 1);
});

test('skyText：天气查不到也照样说时间；没地点只说时间', async () => {
  const boom = async () => { throw new Error('offline'); };
  const t = await sky.skyText({ now: new Date('2026-10-21T12:00:00+08:00'), cfg: { lat: 30, lon: 120 }, fetchFn: boom });
  assert.match(t, /^现在是 10月21日/);
  assert.match(t, /太阳还挂着/);
  const bare = await sky.skyText({ now: new Date(2026, 9, 21, 9, 30), cfg: { place: '' } });
  assert.equal(bare, '现在是 10月21日 周三 上午 09:30。');
});

test('partOfDay：天刚黑、深夜', () => {
  assert.equal(sky.partOfDay(new Date(2026, 9, 21, 18, 5), -3), '天刚黑');
  assert.equal(sky.partOfDay(new Date(2026, 9, 21, 23, 30), -60), '深夜');
  assert.equal(sky.partOfDay(new Date(2026, 9, 21, 5, 50), -3), '天快亮了');
});
