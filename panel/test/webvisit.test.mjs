// 贴吧 / 抖音「发出去」这条路的回归测试：全部不开浏览器。
// 守的是三件曾经坏过的事：待审批准后掉进 B站 分支、任务箱的活没人能发、记住的启动模式读不回来。
import { DATA } from './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// 必须在 import web.mjs 之前写好，模块加载时就会读它
mkdirSync(DATA, { recursive: true });
writeFileSync(join(DATA, 'web-browser.mode'), 'sandboxless', 'utf-8');

const web = await import('../web.mjs');
const webvisit = await import('../webvisit.mjs');
const tieba = await import('../tieba.mjs');
const store = await import('../store.mjs');
const auto = await import('../autopilot.mjs');

test('web：记住的启动模式能读回来（以前撞 TDZ 永远是 null）', async () => {
  assert.equal((await web.status()).launchMode, 'sandboxless');
});

test('hasBduss：认百度下发的大写 BDUSS / BDUSS_BFESS，别的域名不认', () => {
  assert.equal(tieba.hasBduss([{ name: 'BDUSS', domain: '.baidu.com' }]), true);
  assert.equal(tieba.hasBduss([{ name: 'BDUSS_BFESS', domain: '.baidu.com' }]), true);
  assert.equal(tieba.hasBduss([{ name: 'bduss', domain: 'tieba.baidu.com' }]), true);
  assert.equal(tieba.hasBduss([{ name: 'BDUSS', domain: '.evilbaidu.com' }]), false);
  assert.equal(tieba.hasBduss([{ name: 'BAIDUID', domain: '.baidu.com' }]), false);
  assert.equal(tieba.hasBduss(undefined), false);
});

test('postDraft：缺内容 / 缺编号 / 不认识的站点都在开浏览器之前就报错', async () => {
  await assert.rejects(webvisit.postDraft('tieba', { tid: '1' }, '  '), /内容是空的/);
  await assert.rejects(webvisit.postDraft('tieba', {}, '说一句'), /缺帖子编号/);
  await assert.rejects(webvisit.postDraft('douyin', {}, '说一句'), /缺视频编号/);
  await assert.rejects(webvisit.postDraft('weibo', {}, '说一句'), /不认识的站点/);
});

test('TASK_SITE：两种任务各自对上站点', () => {
  assert.equal(webvisit.TASK_SITE.tieba_reply, 'tieba');
  assert.equal(webvisit.TASK_SITE.douyin_comment, 'douyin');
  assert.equal(webvisit.TASK_SITE.comment, undefined);
});

test('approveReview：带 site 的待审走 postDraft，不掉进 B站 发评论', async () => {
  // 故意不给 vid：走对了路会报「缺视频编号」；掉进 B站 分支会是 bili 那边的错
  const r = store.addReview({ kind: 'comment', text: '这也太可爱了吧', payload: { site: 'douyin', title: '小猫' } });
  await assert.rejects(auto.approveReview(r.id), /缺视频编号/);
  const r2 = store.addReview({ kind: 'reply', text: '同感，我家猫也这样', payload: { site: 'tieba', forum: '猫', title: '求助' } });
  await assert.rejects(auto.approveReview(r2.id), /缺帖子编号/);
  // 没发成就还留在待审里，号主可以再批一次
  assert.equal(store.readReview().find((x) => x.id === r.id).status, 'pending');
});

const douyin = await import('../douyin.mjs');

test('hasSession：抖音登录会话认 sessionid / sessionid_ss / sid_tt，空值和别的域名不认', () => {
  assert.equal(douyin.hasSession([{ name: 'sessionid', domain: '.douyin.com', value: 'x' }]), true);
  assert.equal(douyin.hasSession([{ name: 'sid_tt', domain: 'www.douyin.com', value: 'x' }]), true);
  assert.equal(douyin.hasSession([{ name: 'sessionid', domain: '.douyin.com', value: '' }]), false);
  assert.equal(douyin.hasSession([{ name: 'sessionid', domain: '.notdouyin.com', value: 'x' }]), false);
  assert.equal(douyin.hasSession([{ name: 'ttwid', domain: '.douyin.com', value: 'x' }]), false);
});

test('douyin.loginQr({keep})：成功时标签页留着并交回去，默认照旧关掉', async () => {
  const mkPage = () => ({
    closed: false,
    interruptible: true,
    async eval(expr) {
      if (expr.includes('/video/')) return true;
      if (expr.includes('getBoundingClientRect')) return null;
      return true; // 登录框已经在了
    },
    async screenshot() { return 'PNG'; },
    async send() { return {}; },
    async close() { this.closed = true; },
  });
  let page = mkPage();
  douyin.__setPageOpener(async () => page);
  try {
    const kept = await douyin.loginQr({ keep: true });
    assert.equal(kept.page, page);
    assert.equal(page.closed, false, '扫码要靠这个标签页，不能关');
    page = mkPage();
    const plain = await douyin.loginQr();
    assert.equal(plain.page, undefined);
    assert.equal(page.closed, true);
  } finally {
    douyin.__setPageOpener(null);
  }
});

test('loginPoll / loginQr：只认 tieba / douyin', async () => {
  await assert.rejects(webvisit.loginPoll('weibo'), /站点只能是/);
  await assert.rejects(webvisit.loginQr('weibo'), /站点只能是/);
});

// ─── 中低优先级那批 ────────────────────────────────────────
const { CdpConnection } = await import('../cdp.mjs');
const { EventEmitter } = await import('node:events');
const fakeSocket = () => Object.assign(new EventEmitter(), { written: [], write(b) { this.written.push(b); }, end() {} });

test('cdp.send：浏览器不回话时按时超时，不会永远挂着', async () => {
  const c = new CdpConnection(fakeSocket());
  const t0 = Date.now();
  await assert.rejects(c.send('Browser.getVersion', {}, undefined, { timeoutMs: 80 }), /没回应/);
  assert.ok(Date.now() - t0 < 1000);
  assert.equal(c.pending.size, 0, '超时的请求要从 pending 里清掉');
});

test('cdp.waitEvent：给了 sessionId 只认自己标签页的事件', async () => {
  const c = new CdpConnection(fakeSocket());
  const p = c.waitEvent('Page.loadEventFired', 1000, 'mine');
  c.emit('event', { method: 'Page.loadEventFired', sessionId: 'other', params: { who: 'other' } });
  c.emit('event', { method: 'Page.loadEventFired', sessionId: 'mine', params: { who: 'mine' } });
  assert.deepEqual(await p, { who: 'mine' });
});

test('persistentStamps：落盘，换一个实例（等于换进程）也读得到', () => {
  const a = store.persistentStamps('selftest');
  a.clear();
  assert.equal(a.has('reply'), false);
  a.set('reply', 123);
  const b = store.persistentStamps('selftest');
  assert.equal(b.has('reply'), true);
  assert.equal(b.get('reply'), 123);
  b.delete('reply');
  assert.equal(a.has('reply'), false);
});

test('saidToday：发出去的 + 待审里的 + 任务箱里的都占名额，别的站点不算', () => {
  const before = webvisit.saidToday('tieba');
  store.addReview({ kind: 'reply', text: '同感', payload: { site: 'tieba', tid: '1' } });
  store.addTask({ type: 'tieba_reply', payload: { tid: '2', draft: '哈哈' }, note: 'x', source: 'auto' });
  store.addReview({ kind: 'comment', text: '好看', payload: { site: 'douyin', vid: '3' } });
  store.logAction({ kind: 'tb_reply', source: 'auto', target: '4', detail: '发了' });
  assert.equal(webvisit.saidToday('tieba'), before + 3);
});

test('run：面板点的那一轮也能叫停（以前只有定时那轮能停）；叫停不算失败', async () => {
  const cfg = store.readConfig();
  store.writeConfig({ web: { tieba: { enabled: true, forums: ['猫'] } } });
  try {
    // run 在第一个 await 之前就装好了叫停开关，所以紧接着 stop() 能在开浏览器之前拦住
    const p = webvisit.run({ site: 'tieba', reason: '测试' });
    webvisit.stop();
    const r = await p;
    assert.equal(r.stopped, true, `应该是被叫停，实际 ${JSON.stringify(r)}`);
    assert.equal(webvisit.isBusy(), false);
    assert.equal((await web.status()).running, false, '叫停在开浏览器之前，不该拉起 Chrome');
  } finally {
    store.writeConfig({ web: cfg.web });
  }
});
