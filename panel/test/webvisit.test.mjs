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
