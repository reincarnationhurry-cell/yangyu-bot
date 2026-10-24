import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const mind = await import('../mind.mjs');

const cats = ['超治愈!橘猫睡觉呼噜声', '小奶猫拱被窝', '猫咪白噪音一小时', '妙脆角猫的迁徙', '长毛猫咀嚼音', '是把头埋在小猫肚子上的感觉', '1000只猫vs1000只狗', '猫咪打呼噜长视频'];
const other = ['宇宙有多大', '手工皮具教程', '三体结局解说', '做饭不翻车', '历史冷知识', '钢琴即兴现场', '城市夜景延时', '云南旅行vlog'];

test('saturation：一半以上是猫就认出「猫」，哪怕标题里写法不一样', () => {
  const r = mind.saturation([...cats, ...other.slice(0, 4)], { interests: ['猫', '天文'] });
  assert.equal(r.theme, '猫');
  assert.equal(r.n, 8);
});

test('saturation：看得杂、看得少都不算满', () => {
  assert.equal(mind.saturation([...cats.slice(0, 2), ...other], { interests: ['猫'] }), null);
  assert.equal(mind.saturation(cats.slice(0, 5), { interests: ['猫'] }), null, '少于 8 个不判断');
});

test('saturation：不在兴趣里的主题也能从两字词认出来', () => {
  const sleepy = ['雨声助眠', '助眠白噪音', '海浪助眠一小时', '助眠钢琴', '壁炉助眠', '助眠ASMR', '火车助眠', '森林助眠', '科普', '做饭'];
  assert.equal(mind.saturation(sleepy).theme, '助眠');
});

test('onTheme / EXPLORE：换口味的方向里没有猫', () => {
  assert.ok(mind.onTheme('猫咪助眠', '猫'));
  assert.ok(!mind.onTheme('宇宙', '猫'));
  assert.ok(!mind.onTheme('宇宙', null));
  assert.ok(mind.EXPLORE.length >= 10 && !mind.EXPLORE.some((k) => k.includes('猫')));
});

test('心情：连着犯困会被提醒，老心情带着几小时前', () => {
  const at = (h) => new Date(Date.parse('2026-10-24T06:00:00Z') - h * 3600_000).toISOString();
  const moods = [{ mood: '挺开心', at: at(9) }, { mood: '困困的', at: at(6) }, { mood: '困到眼皮打架', at: at(3) }];
  assert.equal(mind.moodStreak(moods), 2);
  assert.equal(mind.moodStreak([...moods, { mood: '精神了', at: at(1) }]), 0);
  const hint = mind.moodHint({ moodAt: at(3), moods, tone: { date: '2099-01-01', text: 'x' } }, Date.parse('2026-10-24T06:00:00Z'));
  assert.match(hint, /3 小时前/);
  assert.match(hint, /连着 2 次说自己困了/);
  const m = mind.setMood({ moods }, '好奇');
  assert.equal(m.mood, '好奇');
  assert.equal(m.moods.length, 4);
});
