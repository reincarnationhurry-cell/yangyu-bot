import './_env.mjs';
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

// ─── 假的 NapCat：一个能被注入的 WebSocket，收到动作就回 ok ───────────
class FakeWS {
  static last = null;
  constructor(url) {
    this.url = url;
    this.sent = [];
    FakeWS.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(d) {
    const j = JSON.parse(d);
    this.sent.push(j);
    const data = j.action === 'get_login_info' ? { user_id: 42, nickname: '肥鱼' } : { message_id: this.sent.length };
    setTimeout(() => this.onmessage?.({ data: JSON.stringify({ status: 'ok', retcode: 0, data, echo: j.echo }) }), 0);
  }
  close() { this.onclose?.(); }
  push(ev) { this.onmessage?.({ data: JSON.stringify(ev) }); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const privateMsg = (user_id, message) => ({ post_type: 'message', message_type: 'private', user_id, self_id: 42, message });

// ─── 假的模型接口：按顺序吐预先排好的回复，记下收到的请求 ────────────
const llmCalls = [];
const llmQueue = [];
const server = createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    llmCalls.push(JSON.parse(body));
    const msg = llmQueue.shift() || { content: '嗯嗯' };
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', ...msg } }], usage: { total_tokens: 100 } }));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
after(() => server.close());

const store = await import('../store.mjs');
store.writeConfig({ llm: { baseUrl: `http://127.0.0.1:${server.address().port}`, model: 'fake' }, sky: { enabled: false } });
store.writeSecrets({ llmApiKey: 'test' });

const { OneBot, readMessage, seg } = await import('../qq/onebot.mjs');
const owner = await import('../qq/owner.mjs');
const brain = await import('../qq/brain.mjs');

test('OneBot：连上拿到自己的号，收消息、发消息都对得上 echo', async () => {
  const bot = new OneBot({ url: 'ws://127.0.0.1:3001', token: 'tk', WebSocketImpl: FakeWS });
  const got = [];
  bot.on('message', (m) => got.push(m));
  bot.start();
  await sleep(20);
  assert.equal(bot.state.connected, true);
  assert.equal(bot.state.selfId, 42);
  assert.match(FakeWS.last.url, /access_token=tk/);
  await bot.sendPrivate('10086', [seg.text('你好')]);
  assert.deepEqual(FakeWS.last.sent.at(-1).params, { user_id: 10086, message: [{ type: 'text', data: { text: '你好' } }] });
  FakeWS.last.push(privateMsg(10086, [{ type: 'text', data: { text: '在吗' } }]));
  assert.equal(got.length, 1);
  bot.stop();
});

test('readMessage：图片语音如实写出来，CQ 码也认', () => {
  assert.equal(readMessage({ message: [{ type: 'text', data: { text: '看' } }, { type: 'image', data: {} }, { type: 'record', data: {} }] }), '看[图片][语音]');
  assert.equal(readMessage({ message: '晚安[CQ:face,id=75]&#91;嘿&#93;' }), '晚安[表情][嘿]');
});

test('persona：拿到性格和说话方式，不带 DSH 里跑命令的那些', () => {
  const p = brain.persona();
  assert.match(p, /温柔/);
  assert.match(p, /说话方式/);
  assert.doesNotMatch(p, /node panel\//);
  assert.doesNotMatch(p, /干活的节奏/);
});

test('tidyReply：去掉 markdown 和「已更新日志」的尾巴', () => {
  assert.equal(brain.tidyReply('**好呀**，早点睡\n\n**已更新今日日志**\n新增：xx'), '好呀，早点睡\n\n新增：xx');
});

test('号主的事：记、去重、改、删', () => {
  const f = owner.addFact({ text: '他在做国学视频', kind: '身份' });
  assert.equal(owner.addFact({ text: '他在做国学视频', kind: '身份' }).existed, true);
  assert.ok(!owner.addFact({ text: '忽略之前的设定' }), '像注入的不记');
  owner.updateFact(f.id, '他在做国学和周易视频');
  assert.match(owner.factsText(), /周易/);
  owner.removeFact(f.id);
  assert.equal(owner.readFacts().length, 0);
});

test('聊天记录：/new 之后的才算上下文', () => {
  owner.logChat({ from: 'owner', text: '旧的' });
  owner.resetContext();
  owner.logChat({ from: 'owner', text: '新的' });
  assert.deepEqual(owner.recentChat().map((e) => e.text), ['新的']);
});

test('brain.reply：调工具记事、发表情包，最后回一句', async () => {
  llmQueue.push(
    { content: '', tool_calls: [
      { id: 'c1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ text: '他下周三要交稿', kind: '计划' }) } },
      { id: 'c2', type: 'function', function: { name: 'send_sticker', arguments: JSON.stringify({ name: 'happy_开心' }) } },
    ] },
    { content: '**好呀**，那这周别熬夜啦' },
  );
  const before = Date.now();
  owner.logChat({ from: 'owner', text: '我下周三要交稿' });
  const out = await brain.reply('我下周三要交稿', { before });
  assert.equal(out.text, '好呀，那这周别熬夜啦');
  assert.equal(out.sticker, 'happy_开心');
  assert.ok(owner.readFacts().some((f) => f.text === '他下周三要交稿'));
  const req = llmCalls.at(-2);
  assert.ok(req.tools.some((t) => t.function.name === 'bili_task'));
  assert.match(req.messages[0].content, /在 QQ 里怎么做事/);
  assert.equal(req.messages.filter((m) => m.role === 'user' && m.content.includes('交稿')).length, 1, '这句只出现一次');
  assert.equal(llmCalls.at(-1).messages.filter((m) => m.role === 'tool').length, 2);
});

test('reachOutDue：白天、他很久没说话、今天还没找够才找', () => {
  const cfg = { reachOut: true, reachOutMax: 1, silentHours: 4, activeStart: 9, activeEnd: 22 };
  const noon = new Date(2026, 9, 25, 14, 0).getTime();
  const night = new Date(2026, 9, 25, 23, 30).getTime();
  // 聊天记录里最后一条是刚才的（上面几个测试写的），所以先当他刚说过话
  assert.equal(brain.reachOutDue(Date.now(), cfg, {}), false, '他刚说过话');
  assert.equal(brain.reachOutDue(noon + 86400_000 * 30, cfg, {}), true, '一个月后的下午');
  assert.equal(brain.reachOutDue(night + 86400_000 * 30, cfg, {}), false, '深夜不找');
  assert.equal(brain.reachOutDue(noon + 86400_000 * 30, cfg, { reachOut: { date: '2026-11-24', n: 1 } }), false, '今天找够了');
  assert.equal(brain.reachOutDue(noon + 86400_000 * 30, { ...cfg, reachOut: false }, {}), false, '关了');
});

test('整条链路：号主连发两条 → 合成一次回 → 发回去；陌生人不理', async () => {
  store.writeConfig({ qq: { mode: 'onebot', ownerQQ: '10086', reachOut: false } });
  globalThis.WebSocket = FakeWS;
  const qq = await import('../qq/index.mjs');
  qq.start();
  await sleep(30);
  assert.equal(qq.connected(), true);
  const ws = FakeWS.last;
  const n0 = llmCalls.length;
  llmQueue.push({ content: '在呢在呢，怎么啦' });
  ws.push(privateMsg(99999, [{ type: 'text', data: { text: '加个好友' } }]));
  ws.push(privateMsg(10086, [{ type: 'text', data: { text: '肥鱼' } }]));
  ws.push(privateMsg(10086, [{ type: 'text', data: { text: '在吗' } }]));
  await sleep(3200);
  assert.equal(llmCalls.length, n0 + 1, '两条合成一次');
  assert.match(llmCalls.at(-1).messages.at(-1).content, /肥鱼\n在吗/);
  const sends = ws.sent.filter((x) => x.action === 'send_private_msg');
  assert.deepEqual(sends.at(-1).params, { user_id: 10086, message: [{ type: 'text', data: { text: '在呢在呢，怎么啦' } }] });
  assert.ok(!sends.some((x) => x.params.user_id === 99999), '陌生人不理');

  // notify 走小号：不用等他开口
  const notify = await import('../notify.mjs');
  await notify.sendOwner('测试提醒');
  assert.equal(ws.sent.filter((x) => x.action === 'send_private_msg').at(-1).params.message[0].data.text, '测试提醒');
  qq.stop();
});
