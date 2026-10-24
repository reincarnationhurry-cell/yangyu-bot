import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const store = await import('../store.mjs');
const notify = await import('../notify.mjs');

const CLI = fileURLToPath(new URL('../pause.mjs', import.meta.url));
const run = (...args) => execFileSync(process.execPath, [CLI, ...args], { env: process.env, encoding: 'utf-8' });

test('setPause：不说多久就等他说好了，但最多 24 小时', () => {
  const now = Date.now();
  const p = store.setPause({ reason: '打游戏' }, now);
  assert.equal(p.untilResume, true);
  assert.equal(p.until, now + store.PAUSE_MAX_HOURS * 3600_000);
  assert.ok(store.readPause(now + 3600_000));
  assert.equal(store.readPause(p.until + 1), null, '过了上限自己恢复');
  store.clearPause();
  assert.equal(store.readPause(), null);
});

test('setPause：说了几小时就停几小时，超过 24 的按 24', () => {
  const now = Date.now();
  assert.equal(store.setPause({ hours: 2 }, now).until, now + 2 * 3600_000);
  assert.equal(store.setPause({ hours: 99 }, now).until, now + 24 * 3600_000);
  store.clearPause();
});

test('叫停时不主动找他：冲动分享不发，待审提醒先排着', async () => {
  store.writeConfig({ notify: { enabled: true, quietStart: 0, quietEnd: 0, kinds: { comment: true } } });
  store.setPause({ reason: '开会' });
  assert.equal((await notify.impulse('快看这个')).why, 'paused');
  const r = store.addReview({ kind: 'comment', text: '想发的评论' });
  assert.equal((await notify.notifyReview(r)).why, 'paused');
  assert.equal(notify.status().pending, 1, '排着，等他说好了再开口时补上');
  store.clearPause();
});

test('pause.mjs CLI：停、看、恢复', () => {
  assert.match(run('打游戏'), /停了/);
  assert.match(run(), /停着呢（打游戏）/);
  assert.match(run('off'), /恢复了/);
  assert.match(run(), /没停/);
  assert.match(run('开会', '--hours', '2'), /停了，到/);
  run('off');
});
