// 提醒：存、到点、重复、错过；她的工具；没连 QQ 时说在面板里。人设名字能改。
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const remind = await import('../remind.mjs');
const brain = await import('../qq/brain.mjs');
const qq = await import('../qq/index.mjs');
const owner = await import('../qq/owner.mjs');
const store = await import('../store.mjs');
const llm = await import('../llm.mjs');

const at = (y, mo, d, h, mi) => new Date(y, mo - 1, d, h, mi).getTime();
const clear = () => { for (const r of remind.upcoming()) remind.cancelReminder(r.id); };

test('parseWhen：认 YYYY-MM-DD HH:mm，认不出来 / 不存在的日期是 NaN', () => {
  assert.equal(remind.parseWhen('2026-11-03 08:00'), at(2026, 11, 3, 8, 0));
  assert.equal(remind.parseWhen('2026-11-03T08:05'), at(2026, 11, 3, 8, 5));
  assert.ok(Number.isNaN(remind.parseWhen('明天早上')));
  assert.ok(Number.isNaN(remind.parseWhen('2026-02-30 08:00')));
});

test('nextAt：每天 / 工作日跳周末 / 每周', () => {
  const fri = at(2026, 11, 6, 8, 0); // 周五
  assert.equal(remind.nextAt(fri, 'daily'), at(2026, 11, 7, 8, 0));
  assert.equal(remind.nextAt(fri, 'weekdays'), at(2026, 11, 9, 8, 0));
  assert.equal(remind.nextAt(fri, 'weekly'), at(2026, 11, 13, 8, 0));
});

test('addReminder：过去的单次拒绝；过去的重复推到下一次；重复定同一个不加两遍', () => {
  clear();
  const now = at(2026, 11, 2, 21, 0);
  assert.throws(() => remind.addReminder({ when: '2026-11-02 08:00', text: '起床' }, now), /过去/);
  assert.throws(() => remind.addReminder({ when: '2026-11-03 08:00', text: ' ' }, now), /提醒什么/);
  const r = remind.addReminder({ when: '2026-11-02 08:00', text: '起床', repeat: 'daily' }, now);
  assert.equal(r.at, at(2026, 11, 3, 8, 0));
  const again = remind.addReminder({ when: '2026-11-03 08:00', text: '起床', repeat: 'daily' }, now);
  assert.equal(again.existed, true);
  assert.equal(remind.upcoming().length, 1);
  clear();
});

test('takeDue：到点的拿出来；单次的做完，重复的挪到下一次；晚太久的算错过', () => {
  clear();
  const now = at(2026, 11, 2, 21, 0);
  const once = remind.addReminder({ when: '2026-11-02 22:00', text: '吃药' }, now);
  const daily = remind.addReminder({ when: '2026-11-02 22:30', text: '睡觉', repeat: 'daily' }, now);
  const stale = remind.addReminder({ when: '2026-11-02 23:00', text: '半夜那个' }, now);
  assert.deepEqual(remind.takeDue(at(2026, 11, 2, 21, 50)), []);
  const due = remind.takeDue(at(2026, 11, 3, 2, 0)); // 面板停了一阵：23:00 的晚了 3 小时还算，都发
  assert.deepEqual(due.map((r) => r.id).sort(), [once.id, daily.id, stale.id].sort());
  assert.deepEqual(remind.upcoming().map((r) => [r.id, r.at]), [[daily.id, at(2026, 11, 3, 22, 30)]]);
  const late = remind.addReminder({ when: '2026-11-03 09:00', text: '交周报' }, at(2026, 11, 3, 8, 0));
  assert.deepEqual(remind.takeDue(at(2026, 11, 3, 16, 0)).map((r) => r.id), [], '晚了 7 小时，不发了');
  assert.equal(remind.upcoming().some((r) => r.id === late.id), false);
  clear();
});

test('她的工具：set_reminder / reminders / cancel_reminder；工具说明里带着现在的时间', async () => {
  clear();
  const def = brain.toolDefs().find((t) => t.function.name === 'set_reminder');
  assert.match(def.function.description, /现在是 \d{4}-\d{2}-\d{2} 周./);
  const d = new Date(Date.now() + 86400_000);
  const when = `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} 08:00`;
  assert.match(await brain.runTool('set_reminder', { when, text: '起床' }, {}), /定好了.*起床/);
  assert.match(await brain.runTool('set_reminder', { when: '明早', text: '起床' }, {}), /没定上/);
  const list = await brain.runTool('reminders', {}, {});
  const id = /#(\w+)/.exec(list)[1];
  assert.match(await brain.runTool('cancel_reminder', { id }, {}), /取消了/);
  assert.equal(await brain.runTool('reminders', {}, {}), '现在没有提醒');
});

test('到点了没连 QQ：说在面板聊天框里（没模型就平铺）', async () => {
  clear();
  const now = Date.now();
  const d = new Date(now - 60_000);
  remind.addReminder({ when: `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, text: '喝水', repeat: 'daily' }, now - 120_000);
  assert.equal(await qq.fireReminders(now), 1);
  const e = owner.readChat().at(-1);
  assert.equal(e.kind, 'remind');
  assert.equal(e.via, 'panel');
  assert.match(e.text, /喝水/);
  assert.equal(await qq.fireReminders(now), 0, '同一个不提醒两遍');
  clear();
});

test('人设名字：从配置里读，清空了回到默认', () => {
  const before = store.readConfig().persona;
  try {
    store.writeConfig({ persona: { nick: '小橘', short: '橘子' } });
    assert.match(llm.PERSONA(), /「小橘」/);
    assert.equal(llm.selfTag(), '我（橘子）');
    store.writeConfig({ persona: { nick: '  ' } });
    assert.equal(store.who().nick, '蓝色大肥鱼');
  } finally {
    store.writeConfig({ persona: before });
  }
});
