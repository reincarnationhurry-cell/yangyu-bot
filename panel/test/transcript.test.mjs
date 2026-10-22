import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const mind = await import('../mind.mjs');

const sub = {
  source: 'ai',
  lines: [
    { from: 2, to: 5, text: '土星看起来像太阳系中最美丽的目的地' },
    { from: 6, to: 9, text: '金色云层和巨大的星环' },
    { from: 40, to: 44, text: '信息要一个多小时才能传回地球' },
    { from: 216, to: 220, text: '惠更斯号是唯一一次在外太阳系着陆' },
    { from: 900, to: 905, text: '这一段她还没看到' },
  ],
};

test('transcriptText：只要看到的部分，按半分钟并行，带时间', () => {
  const tx = mind.transcriptText(sub, 240);
  assert.ok(tx.text.startsWith('[0:02] 土星看起来像太阳系中最美丽的目的地 金色云层和巨大的星环'));
  assert.ok(tx.text.includes('[3:36] 惠更斯号'));
  assert.ok(!tx.text.includes('还没看到'));
  assert.equal(tx.upTo, 220);
  assert.equal(mind.transcriptText(sub, 1), null);
});

test('transcriptText：太长就均匀抽样', () => {
  const long = { lines: Array.from({ length: 400 }, (_, i) => ({ from: i * 31, to: i * 31 + 5, text: `第${i}段字幕内容内容内容` })) };
  const tx = mind.transcriptText(long, 1e6, 600);
  assert.ok(tx.text.length <= 600);
  assert.ok(tx.text.includes('[0:00]'));
});

test('checkHeard：对得上字幕的才算看到', () => {
  assert.ok(mind.checkHeard('3:36 说惠更斯号是唯一一次在外太阳系着陆', sub, 240));
  assert.ok(mind.checkHeard('0:40 讲信息要一个多小时才能传回来', sub, 240));
});

test('checkHeard：编的、超出范围的、没时间的都不认', () => {
  assert.equal(mind.checkHeard('3:36 说猫咪喜欢吃小鱼干', sub, 240), null);
  assert.equal(mind.checkHeard('15:00 这一段她还没看到', sub, 240), null);
  assert.equal(mind.checkHeard('讲了惠更斯号着陆', sub, 240), null);
  assert.equal(mind.checkHeard('', sub, 240), null);
});
