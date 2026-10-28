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

const { OneBot, readMessage, recordSegments, seg } = await import('../qq/onebot.mjs');
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

test('recordSegments：段数组和 CQ 码里的语音都拿得到 file', () => {
  assert.deepEqual(recordSegments({ message: [{ type: 'text', data: { text: '听' } }, { type: 'record', data: { file: 'a.amr' } }] }), [{ file: 'a.amr' }]);
  assert.deepEqual(recordSegments({ message: '[CQ:record,file=b.amr,file_size=12]' }), [{ file: 'b.amr' }]);
  assert.deepEqual(recordSegments({ message: [{ type: 'image', data: {} }] }), []);
});

test('speakable：短的话去掉颜文字再念，长的、带链接的不念', async () => {
  const { speakable } = await import('../qq/voice.mjs');
  assert.equal(speakable('好啦好啦 (￣▽￣) 我在呢qwq'), '好啦好啦 我在呢');
  assert.equal(speakable('嘿嘿(๑•̀ㅂ•́)و✧ 今天也加油！'), '嘿嘿 今天也加油！');
  assert.equal(speakable('我刚刚（偷偷）看了一眼'), '我刚刚偷偷看了一眼'); // 括号里的正经话留着，括号本身不念
  assert.equal(speakable('你看这个 https://b23.tv/abc'), null);
  assert.equal(speakable('BV1xx411c7mD 这个超好笑'), null);
  assert.equal(speakable('长'.repeat(81)), null);
  assert.equal(speakable('(￣▽￣)'), null);
  assert.equal(speakable(''), null);
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

// ─── 一键切线路（2026-10-28 加的：面板上那两个按钮）───────────────
test('setMode：切官方会停容器，切小号会起容器，都改配置并重连', async () => {
  const store2 = await import('../store.mjs');
  const qq2 = await import('../qq/index.mjs');
  const calls = [];
  // 假容器模块：不真调 docker，只记下谁被调了
  const fakeNap = {
    up: async () => { calls.push('up'); return { ok: true }; },
    down: async () => { calls.push('down'); return { ok: true }; },
    status: async () => ({ docker: true, exists: true, running: true, state: 'running', detail: 'Up 1 min' }),
    qr: async () => null,
  };

  store2.writeConfig({ qq: { mode: 'official' } });
  // 切到小号：应该起容器
  const toSmall = await qq2.setMode('onebot', { nap: fakeNap });
  assert.equal(toSmall.changed, true);
  assert.equal(store2.readConfig().qq.mode, 'onebot');
  assert.deepEqual(calls, ['up'], '切小号要拉容器');

  // 再切一次同样的：什么都不做
  const again = await qq2.setMode('onebot', { nap: fakeNap });
  assert.equal(again.changed, false);
  assert.deepEqual(calls, ['up'], '线路没变就别动容器');

  // 切回官方：应该停容器
  const toOfficial = await qq2.setMode('official', { nap: fakeNap });
  assert.equal(toOfficial.changed, true);
  assert.equal(toSmall.mode, 'onebot');
  assert.equal(toOfficial.mode, 'official');
  assert.deepEqual(calls, ['up', 'down'], '切官方要停容器，不然它在后台反复重登');

  // 不认识的线路要报错
  await assert.rejects(() => qq2.setMode('wechat', { nap: fakeNap }), /不认识的线路/);

  // 切到 Telegram：也要停容器（从小号切过去时）
  calls.length = 0;
  await qq2.setMode('onebot', { nap: fakeNap });
  await qq2.setMode('telegram', { nap: fakeNap });
  assert.equal(store2.readConfig().qq.mode, 'telegram');
  assert.deepEqual(calls, ['up', 'down'], '切 Telegram 也要停容器');
  qq2.stop();
});

test('setMode：停容器失败也不挡切换，只是记一句', async () => {
  const store2 = await import('../store.mjs');
  const qq2 = await import('../qq/index.mjs');
  const fakeNap = { up: async () => ({ ok: true }), down: async () => { throw new Error('docker 没响应'); }, status: async () => ({}), qr: async () => null };
  store2.writeConfig({ qq: { mode: 'onebot' } });
  const r = await qq2.setMode('official', { nap: fakeNap });
  assert.equal(store2.readConfig().qq.mode, 'official', '容器停不掉，但线路照样切');
  assert.match(r.napcatNote, /没停成/);
});

test('panelStatus：带上容器状态和二维码，拿不到码不报错', async () => {
  const store2 = await import('../store.mjs');
  const qq2 = await import('../qq/index.mjs');
  store2.writeConfig({ qq: { mode: 'onebot' } });
  const r = await qq2.panelStatus({
    nap: {
      status: async () => ({ docker: true, exists: true, running: true, state: 'running', detail: 'Up 2 min' }),
      qr: async () => ({ dataUrl: 'data:image/png;base64,AAAA', at: Date.now(), bytes: 4 }),
    },
  });
  assert.equal(r.mode, 'onebot');
  assert.equal(r.container.running, true);
  assert.match(r.qr.dataUrl, /^data:image\/png;base64,/);
  // 容器模块整个抛错时，面板状态也不该跟着挂
  const fallback = await qq2.panelStatus({ nap: { status: async () => { throw new Error('boom'); }, qr: async () => { throw new Error('boom'); } } });
  assert.equal(fallback.container.docker, false);
  assert.equal(fallback.qr, null);
});

test('parsePs：认得容器跑没跑', async () => {
  const nap = await import('../qq/napcat.mjs');
  assert.deepEqual(nap.parsePs('napcat\trunning\tUp 4 hours'), { name: 'napcat', state: 'running', running: true, detail: 'Up 4 hours' });
  assert.equal(nap.parsePs('napcat\texited\tExited (0) 2 days ago').running, false);
  assert.equal(nap.parsePs(''), null);
  assert.equal(nap.parsePs('   '), null);
});

test('parseLoginLog：认出「反复登不进去」', async () => {
  const nap = await import('../qq/napcat.mjs');
  const stuck = [
    '10-28 12:02:47 [error] [Core] [Login] Login Error,ErrType:  1  ErrCode: 3',
    '10-28 12:04:49 [error] [Core] [Login] Login Error,ErrType:  1  ErrCode: 3',
    '10-28 12:06:52 [error] [Core] [Login] Login Error,ErrType:  1  ErrCode: 3',
  ].join('\n');
  assert.deepEqual(nap.parseLoginLog(stuck), { errors: 3, failing: true });
  // 失败过、后来又扫上去了：不算卡住
  const recovered = stuck + '\n10-28 12:09:01 [info] [Core] [Login] 登录成功';
  assert.equal(nap.parseLoginLog(recovered).failing, false);
  // 只有一两次失败：再等等，别急着停
  assert.equal(nap.parseLoginLog(stuck.split('\n')[0]).failing, false);
  assert.equal(nap.parseLoginLog('一切正常').failing, false);
});

// ─── Telegram（2026-10-28：小号老被踢，换成号主自己建的 bot）───────────
/** 假的 Bot API：getUpdates 每次吐一批排好的消息，没有就挂一会儿；记下发出去的东西 */
function fakeTelegram() {
  const sent = [];
  const updates = [];
  let id = 0;
  const fetchImpl = async (url, opts = {}) => {
    const method = url.split('/').pop();
    if (url.includes('/file/bot')) return new Response(Buffer.from('OggS-fake'));
    const body = opts.body instanceof FormData ? Object.fromEntries(opts.body) : JSON.parse(opts.body || '{}');
    let result = true;
    if (method === 'getMe') result = { id: 7, username: 'feiyu_bot' };
    else if (method === 'getUpdates') {
      if (!updates.length) await new Promise((r) => { const t = setTimeout(r, 50); opts.signal?.addEventListener('abort', () => clearTimeout(t)); });
      if (opts.signal?.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      result = updates.splice(0).filter((u) => u.update_id >= (body.offset || 0));
    } else if (method === 'getFile') result = { file_path: 'voice/a.oga' };
    else sent.push({ method, body });
    return new Response(JSON.stringify({ ok: true, result }));
  };
  const push = (from, text, extra = {}) => updates.push({ update_id: ++id, message: { message_id: id, chat: { id: from.id, type: 'private' }, from, text, ...extra } });
  return { sent, push, fetchImpl };
}

test('readTgMessage：图、语音、贴纸如实写出来，配的文字跟在后面', async () => {
  const { readTgMessage, photoIds } = await import('../qq/telegram.mjs');
  assert.equal(readTgMessage({ text: '在吗' }), '在吗');
  assert.equal(readTgMessage({ photo: [{ file_id: 's' }, { file_id: 'b' }], caption: '看这个' }), '[图片]看这个');
  assert.deepEqual(photoIds({ photo: [{ file_id: 's' }, { file_id: 'b' }] }), ['b'], '取最大的那张');
  assert.equal(readTgMessage({ voice: { file_id: 'v' } }), '[语音]');
  assert.equal(readTgMessage({ sticker: { emoji: '😂' } }), '[表情包😂]');
});

test('Telegram 整条链路：第一个私聊的认成号主 → 回他；别人不理；能主动发', async () => {
  const { Telegram } = await import('../qq/telegram.mjs');
  const fake = fakeTelegram();
  // 让 index.mjs 里 new 出来的 Telegram 用假接口
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts) => (String(url).startsWith('https://api.telegram.org') ? fake.fetchImpl(String(url), opts) : realFetch(url, opts));
  try {
    store.writeConfig({ qq: { mode: 'telegram', reachOut: false, voiceChance: 0, tg: { ownerId: '', ownerName: '' } } });
    store.writeSecrets({ telegramToken: '123:abc' });
    const qq = await import('../qq/index.mjs');
    qq.start();
    await sleep(80);
    assert.equal(qq.connected(), true);
    assert.equal(qq.status().selfId, '@feiyu_bot');

    const me = { id: 555, first_name: '号主', username: 'boss' };
    const n0 = llmCalls.length;
    llmQueue.push({ content: '诶，你来啦' });
    fake.push(me, '/start');
    await sleep(150);
    assert.equal(store.readConfig().qq.tg.ownerId, '555', '第一个私聊的就是号主');
    assert.match(qq.status().tgOwner, /@boss/);
    fake.push({ id: 999, first_name: '路人' }, '你好');
    await sleep(3000);
    assert.equal(llmCalls.length, n0 + 1, '路人不理');
    const texts = fake.sent.filter((x) => x.method === 'sendMessage');
    assert.deepEqual(texts.at(-1).body, { chat_id: '555', text: '诶，你来啦' });
    assert.ok(!fake.sent.some((x) => String(x.body.chat_id) === '999'));

    const notify = await import('../notify.mjs');
    await notify.sendOwner('测试提醒');
    assert.equal(fake.sent.filter((x) => x.method === 'sendMessage').at(-1).body.text, '测试提醒');

    // 解绑以后：不知道发给谁，主动发要报错，不能乱发
    qq.unbindTg();
    await assert.rejects(() => qq.sendOwner('hi'), /先给 bot 发一句话/);
    qq.stop();
  } finally {
    globalThis.fetch = realFetch;
  }
  // token 错了要说人话
  const bad = new Telegram({ token: 'x', fetchImpl: async () => new Response(JSON.stringify({ ok: false, description: 'Unauthorized' }), { status: 401 }) });
  await assert.rejects(() => bad.call('getMe'), /token 不对/);
});
