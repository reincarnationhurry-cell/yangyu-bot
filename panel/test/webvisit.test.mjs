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
