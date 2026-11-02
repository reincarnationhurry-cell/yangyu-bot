// B站 直播：认房间、挑房间、自己去看的节奏、看一场的整条路。全部假接口，不联网
import { DATA } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// bili.mjs 加载时就定了凭证路径：先放一份假的
process.env.BILIBILI_COOKIE_FILE = join(DATA, 'cookie.json');
writeFileSync(process.env.BILIBILI_COOKIE_FILE, JSON.stringify({ sessdata: 'x', bili_jct: 'y', dede_user_id: '1' }));
writeFileSync(join(DATA, 'device.json'), JSON.stringify({ buvid3: 'b3', b_nut: '1', at: Date.now() }));

const live = await import('../bililive.mjs');
const store = await import('../store.mjs');
const memory = await import('../memory.mjs');

test('roomFrom：认直播间链接和「房间号 123」', () => {
  assert.equal(live.roomFrom('去看 https://live.bilibili.com/21144080?x=1'), '21144080');
  assert.equal(live.roomFrom('看看房间号 5271'), '5271');
  assert.equal(live.roomFrom('直播间：732'), '732');
  assert.equal(live.roomFrom('去看猫的直播'), '');
});

test('keywordFrom：「去看 XX 的直播」挑出 XX，没点名就空着', () => {
  assert.equal(live.keywordFrom('去看看老番茄的直播'), '老番茄');
  assert.equal(live.keywordFrom('帮我看一下「N只猫做主播」的直播'), 'N只猫做主播');
  assert.equal(live.keywordFrom('去看会儿直播'), '');
  assert.equal(live.keywordFrom('随便看看直播吧'), '');
});

const room = (id, title, area = '', live_ = true) => ({ roomid: id, uid: '1', uname: `主播${id}`, title, area, live: live_, keyframe: '' });
const fakeApi = (over = {}) => ({
  liveRoom: async (id) => room(String(id), `房间${id}`),
  searchLive: async () => [],
  liveFollowing: async () => [],
  liveRecommend: async () => [room('1', 'KPL 总决赛', '王者荣耀'), room('2', '猫猫睡觉', '萌宠'), room('3', '聊天', '颜值')],
  ...over,
});

test('pickRoom：点名的没在播要说清楚；搜不到要说清楚', async () => {
  await assert.rejects(live.pickRoom({ room: '9' }, { api: fakeApi({ liveRoom: async () => room('9', 'x', '', false) }), interests: [] }), /没在播/);
  await assert.rejects(live.pickRoom({ keyword: '不存在' }, { api: fakeApi(), interests: [] }), /没找到正在播/);
});

test('pickRoom：关注的人没在播 → 推荐里挑跟兴趣沾边的', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await live.pickRoom({}, { api: fakeApi(), interests: ['猫'] });
    assert.equal(r.roomid, '2');
    assert.match(r.why, /感兴趣/);
  }
  const f = await live.pickRoom({}, { api: fakeApi({ liveFollowing: async () => [room('7', '关注的')] }), interests: ['猫'] });
  assert.equal(f.roomid, '7');
});

test('due：关着不去；骰子没中不去；今天看够了不去；刚看过不去', () => {
  const noon = new Date(); noon.setHours(14, 0, 0, 0);
  const now = noon.getTime();
  const on = { enabled: true, perDay: 1, minutes: 5 };
  const hit = { rand: () => 0, log: () => [] };
  assert.equal(live.due(now, { ...on, enabled: false }, hit), false);
  assert.equal(live.due(now, on, { rand: () => 0.99, log: () => [] }), false);
  assert.equal(live.due(now, on, hit), true);
  const early = new Date(noon); early.setHours(3);
  assert.equal(live.due(early.getTime(), on, hit), false, '半夜不看');
  const today = [{ ts: new Date(now - 3 * 3600_000).toISOString(), kind: 'live', meta: { minutes: 5 } }];
  assert.equal(live.due(now, on, { rand: () => 0, log: () => today }), false, '一天一场看过了');
  assert.equal(live.due(now, { ...on, perDay: 3 }, { rand: () => 0, log: () => [{ ...today[0], ts: new Date(now - 30 * 60_000).toISOString() }] }), false, '半小时前刚看过');
});

test('watch：点进去、收弹幕、叫停后记一句印象进记忆，面板看得到在看谁', async () => {
  const realFetch = globalThis.fetch;
  const hits = [];
  const ok = (data) => new Response(JSON.stringify({ code: 0, data }), { headers: { 'Content-Type': 'application/json' } });
  globalThis.fetch = async (url) => {
    const u = String(url);
    hits.push(u);
    if (u.includes('/room/v1/Room/get_info')) return ok({ room_id: 5271, uid: 7, title: '猫猫睡觉', live_status: 1, area_name: '萌宠', keyframe: '' });
    if (u.includes('/Master/info')) return ok({ info: { uname: '猫主播' } });
    if (u.includes('roomEntryAction')) return ok({});
    if (u.includes('dM/gethistory')) return ok({ room: [{ nickname: 'a', text: '好可爱', timeline: '1' }, { nickname: 'b', text: '呼噜声', timeline: '2' }] });
    throw new Error('没想到会请求 ' + u);
  };
  try {
    const ctl = new AbortController();
    const p = live.watch({ request: '去看房间号 5271', minutes: 3, signal: ctl.signal });
    // 等她点进去、拉到第一批弹幕
    for (let i = 0; i < 100 && !(live.view().watching?.danmaku.length); i++) await new Promise((r) => setTimeout(r, 20));
    const v = live.view().watching;
    assert.equal(v.uname, '猫主播');
    assert.equal(v.danmaku.length, 2);
    await assert.rejects(live.watch({}), /正在看/, '一次只看一场');
    ctl.abort();
    const r = await p;
    assert.equal(r.ok, true);
    assert.equal(r.stopped, true);
    assert.match(r.summary, /猫主播/);
    assert.ok(hits.some((u) => u.includes('roomEntryAction')), '点进直播间要进观看历史');
    assert.equal(live.isBusy(), false);
    assert.ok(memory.memoryView(5).recent.some((e) => e.text.startsWith('看直播：')), '看完记进她自己的记忆');
    assert.ok(store.readActions().some((a) => a.kind === 'live' && a.meta?.danmaku === 2));
    assert.equal(live.view().recent.length, 1);
  } finally {
    globalThis.fetch = realFetch;
  }
});
