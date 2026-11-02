/**
 * panel/douyin.mjs 的单元测试
 *
 * 三条原则：
 *  1. 不开真浏览器 —— 解析逻辑全在纯函数里，用真机抓下来的原文喂进去就行；
 *     唯一需要「页面」的用例（未登录写操作必须拒绝）用假页面注入。
 *  2. 断言必须咬住真实行为 —— 表里的期望值都是从真机输出抄来的，不是编的。
 *  3. 前置条件不满足就「未执行 + 非零退出」，绝不输出「全部通过」。
 *
 * 跑法：node --test panel/test/douyin.test.mjs
 */
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

let dy = null;
let loadError = null;
try {
  dy = await import('../douyin.mjs');
} catch (e) {
  loadError = e;
}

// ─── 前置条件闸门 ──────────────────────────────────────────
// 模块 import 失败（语法错、依赖缺失）时，下面的 test() 一个都不会注册。
// node:test 在这种情况下会以 0 项断言、退出码 0 结束 —— 那就是「假成功」。
// 所以这里显式记一笔，跑完检查。
const REQUIRED = [
  'hotVideos', 'searchVideos', 'videoDetail', 'videoComments',
  'postComment', 'likeVideo', 'loginQr', 'loginState',
];
const missing = dy ? REQUIRED.filter((k) => typeof dy[k] !== 'function') : REQUIRED;

if (!dy) {
  test('模块加载失败时不能装作通过', () => {
    assert.fail(`panel/douyin.mjs 加载失败，后面的用例都没跑：${loadError?.message}`);
  });
} else if (missing.length) {
  test('导出不全时不能装作通过', () => {
    assert.fail(`缺少导出：${missing.join(', ')}`);
  });
}

// ─── 假 payload（全部来自真机抓取，2026-11-02 未登录）────────
/** /hot 首屏 + 滚动后的真实卡片 innerText，含「热点/在看人数」这种多出来的行 */
const HOT_CARDS = [
  {
    href: '/video/7702025102846519419',
    text: [
      '00:18',
      '4.6万',
      '要抱抱 #要抱抱 #翻唱 #音为有你 #fyp',
      '@Reira_曾若妍',
      '· 3天前',
    ].join('\n'),
  },
  {
    href: '/video/7702797743509351803',
    text: [
      '00:26',
      '3203',
      '上升热点：蔡徐坤怕你感冒但不怕你心动',
      '435.2万人在看',
      '你属于天意那种命中注定 #蔡徐坤 #hugme #翻唱 #cover #音为有你',
      '@Mago',
      '· 1天前',
    ].join('\n'),
  },
  {
    href: '/video/7703155795906640227',
    text: [
      '共创',
      '00:28',
      '1520',
      '倒计时5天 | 抬花轿，遇凤莲 #一汪春水总关情 #汪荃珍从艺50年',
      '@汪荃珍',
      '· 21小时前',
    ].join('\n'),
  },
  // 同一批里重复出现的老视频（列表会重复挂同一张卡）
  { href: '/video/7702025102846519419', text: '00:18\n4.6万\n要抱抱 #要抱抱\n@Reira_曾若妍\n· 3天前' },
  // 不是视频链接的锚点，必须被丢掉
  { href: '/user/MS4wLjABAAAA', text: '某个用户' },
  { href: '/video/', text: '坏链接' },
];

/** 一条一级评论带上楼中楼回复的真实 innerText（子评论会串进来，正文必须只取主评论那行） */
const COMMENT_WITH_REPLY = [
  '鲸屿',
  '...',
  '谁还记得他之前叫把妹王啊',
  '3天前·山东',
  '',
  '758',
  '',
  '分享',
  '回复',
  'Reira_曾若妍',
  '作者',
  '...',
  '3天前·韩国',
  '',
  '268',
  '',
  '分享',
  '回复',
  '展开15条回复',
].join('\n');

/** 没有楼中楼的普通评论 */
const COMMENT_PLAIN = 'chun\n...\n要炖这么久啊，我没这个耐心，我一般用高压锅解决了\n2天前·湖北\n\n0\n\n分享\n回复';

// ─── 纯函数：ID 解析 ──────────────────────────────────────
test('parseVid：认纯 id、各种链接写法，认不出就抛中文错', () => {
  const id = '7702025102846519419';
  assert.equal(dy.parseVid(id), id);
  assert.equal(dy.parseVid(`https://www.douyin.com/video/${id}`), id);
  assert.equal(dy.parseVid(`https://www.douyin.com/video/${id}?previous_page=hot`), id);
  assert.equal(dy.parseVid(`//www.douyin.com/video/${id}`), id);
  assert.equal(dy.parseVid(`  ${id}  `), id);
  // 分享链接里 id 夹在一堆参数中间也能抠出来
  assert.equal(dy.parseVid(`https://v.douyin.com/abc/?modal_id=${id}&x=1`), id);

  // 注意：/discover?modal_id=xxx 里虽然有 19 位数字，但它不是 /video/ 路径。
  // 当前的兜底正则能抠出来，但那是「凑巧」—— 这里只断言它抠出的确实是那个 id。
  assert.equal(dy.parseVid(`https://www.douyin.com/discover?modal_id=${id}`), id);

  for (const bad of ['', null, undefined, '不是链接', 'https://www.douyin.com/user/abc']) {
    assert.throws(() => dy.parseVid(bad), (e) => e instanceof dy.DouyinError && /看不懂|没给/.test(e.message), String(bad));
  }
});

// ─── 纯函数：数字 / 时长 ──────────────────────────────────
test('parseCount：中文短数字换算，认不出返回 null 而不是 0', () => {
  assert.equal(dy.parseCount('3754'), 3754);
  assert.equal(dy.parseCount('4.6万'), 46000);
  assert.equal(dy.parseCount('2.8万'), 28000);
  assert.equal(dy.parseCount('1.2亿'), 120000000);
  assert.equal(dy.parseCount('1,234'), 1234);
  assert.equal(dy.parseCount('0'), 0);
  assert.equal(dy.parseCount(''), null);
  assert.equal(dy.parseCount(null), null);
  assert.equal(dy.parseCount('赞'), null);
  // 关键区别：拿不到 ≠ 0
  assert.notEqual(dy.parseCount(''), 0);
});

test('parseDuration：HH:MM 换算成秒，别的形态不认', () => {
  assert.equal(dy.parseDuration('00:18'), 18);
  assert.equal(dy.parseDuration('01:40'), 100);
  assert.equal(dy.parseDuration('1:40'), 100);
  assert.equal(dy.parseDuration('12:00'), 720);
  assert.equal(dy.parseDuration('3天前'), null);
  assert.equal(dy.parseDuration(''), null);
});

// ─── 纯函数：热榜卡片解析 ──────────────────────────────────
test('parseHotCard：普通卡片，字段各就各位', () => {
  const v = dy.parseHotCard(HOT_CARDS[0]);
  assert.equal(v.vid, '7702025102846519419');
  assert.equal(v.url, 'https://www.douyin.com/video/7702025102846519419');
  assert.equal(v.duration, 18);
  assert.equal(v.author, 'Reira_曾若妍');
  assert.equal(v.publishTime, '3天前');
  assert.match(v.title, /^要抱抱 #要抱抱/);
  // 热榜卡片上的数字是点赞数，不是播放量（实测与详情页 digg 一致）
  assert.equal(v.likeCount, 46000);
  assert.equal(v.playCount, null, '热榜不提供播放量，必须是 null 不能瞎填');
});

test('parseHotCard：「435.2万人在看」不能被当成点赞数', () => {
  const v = dy.parseHotCard(HOT_CARDS[1]);
  assert.equal(v.likeCount, 3203, '拿到的应该是纯数字行，不是「435.2万人在看」');
  assert.equal(v.event, '蔡徐坤怕你感冒但不怕你心动');
  assert.equal(v.duration, 26);
  assert.match(v.title, /你属于天意那种命中注定/);
});

test('parseHotCard：带「共创」前缀的卡片也能解析', () => {
  const v = dy.parseHotCard(HOT_CARDS[2]);
  assert.equal(v.duration, 28);
  assert.equal(v.likeCount, 1520);
  assert.equal(v.author, '汪荃珍');
  assert.match(v.title, /抬花轿/);
});

test('parseHotCard：坏链接返回 null，不抛错', () => {
  assert.equal(dy.parseHotCard({ href: '/user/abc', text: 'x' }), null);
  assert.equal(dy.parseHotCard({ href: '/video/', text: 'x' }), null);
  assert.equal(dy.parseHotCard({}), null);
});

test('parseHotCards：按 vid 去重、丢掉非视频链接', () => {
  const list = dy.parseHotCards(HOT_CARDS);
  assert.equal(list.length, 3, '5 条视频锚点里有 1 条重复、1 条是用户页');
  const ids = list.map((v) => v.vid);
  assert.equal(new Set(ids).size, ids.length, '不能有重复 vid');
  assert.ok(ids.includes('7703155795906640227'));
});

// ─── 纯函数：评论解析 ────────────────────────────────────
test('parseComment：带楼中楼时正文只取主评论，不把子回复串进来', () => {
  const c = dy.parseComment({ author: '鲸屿', raw: COMMENT_WITH_REPLY });
  assert.equal(c.author, '鲸屿');
  assert.equal(c.text, '谁还记得他之前叫把妹王啊');
  assert.equal(c.time, '3天前·山东');
  assert.equal(c.likeCount, 758);
  assert.equal(c.replyCount, 15);
  // 这一条最容易写错的地方：整段 innerText 塞进 text
  assert.ok(!c.text.includes('Reira_曾若妍'), '子评论内容不能混进主评论正文');
  assert.ok(!c.text.includes('分享'));
});

test('parseComment：普通评论，0 赞要如实是 0', () => {
  const c = dy.parseComment({ author: 'chun', raw: COMMENT_PLAIN });
  assert.equal(c.author, 'chun');
  assert.equal(c.text, '要炖这么久啊，我没这个耐心，我一般用高压锅解决了');
  assert.equal(c.time, '2天前·湖北');
  assert.equal(c.likeCount, 0);
  assert.equal(c.replyCount, 0);
});

test('parseComment：作者名带「作者」标记要剥掉；空内容返回 null', () => {
  const c = dy.parseComment({ author: 'Reira_曾若妍\n作者', raw: 'Reira_曾若妍\n作者\n...\n偶尔偶尔\n3天前·韩国\n38\n分享\n回复' });
  assert.equal(c.author, 'Reira_曾若妍');
  assert.equal(c.text, '偶尔偶尔');
  assert.equal(c.likeCount, 38);
  assert.equal(dy.parseComment({ author: '', raw: '' }), null);
});

// ─── 节流 ────────────────────────────────────────────────
test('节流：默认 20/30 秒，第一次永远放行', () => {
  let t = 1_000_000;
  const th = dy.createThrottle({ now: () => t });
  assert.deepEqual(th.check('like'), { ok: true, waitMs: 0 });
  th.mark('like');
  const after = th.check('like');
  assert.equal(after.ok, false);
  assert.equal(after.waitMs, 20000);

  // 时间推进到刚好够
  t += 19999;
  assert.equal(th.check('like').ok, false);
  t += 1;
  assert.equal(th.check('like').ok, true);
});

test('节流：点赞和评论互不影响，评论门槛更高', () => {
  let t = 0;
  const th = dy.createThrottle({ now: () => t });
  th.mark('comment');
  assert.equal(th.check('comment').waitMs, 30000);
  assert.equal(th.check('like').ok, true, '评论冷却不该挡住点赞');
  t = 25000;
  assert.equal(th.check('comment').ok, false);
  t = 30000;
  assert.equal(th.check('comment').ok, true);
});

test('guardThrottle：冷却中抛中文错，且带上还要等几秒', () => {
  let t = 0;
  const th = dy.createThrottle({ now: () => t });
  th.mark('comment');
  t = 25000; // 还差 5 秒
  assert.throws(
    () => dy.guardThrottle('comment', th),
    (e) => e instanceof dy.DouyinError && e.code === 'throttled' && /等\s*5\s*秒/.test(e.message),
  );
  t = 30000;
  assert.doesNotThrow(() => dy.guardThrottle('comment', th));
});

test('节流：reset 能清掉冷却（换账号/重开面板时用）', () => {
  let t = 0;
  const th = dy.createThrottle({ now: () => t });
  th.mark('like');
  assert.equal(th.check('like').ok, false);
  th.reset('like');
  assert.equal(th.check('like').ok, true);
});

// ─── 未登录时写操作必须拒绝（假页面注入，不开浏览器）──────────
/** 一个只够回答 loginState 的假页面：未登录 = 有「登录」按钮、没头像 */
function fakePage({ loggedIn = false } = {}) {
  return {
    closed: false,
    async eval(expr) {
      if (/button, div\[role="button"\], a/.test(expr)) {
        if (/hasLoginBtn/.test(expr)) {
          return { hasLoginBtn: !loggedIn, hasAvatar: loggedIn, nickname: loggedIn ? '在逃肥鱼公主' : '', hasBody: true };
        }
      }
      if (/document\.body\s*\?\s*document\.body\.innerText/.test(expr)) return '正文';
      return null;
    },
    // 假页面的 eval 结果永远不变，通知让业务循环提前收手（真页面不会这样）
    interruptible: true,
    async text() { return '请先登录后发表评论'; },
    async send() { return {}; },
    async close() { this.closed = true; },
  };
}

test('postComment：未登录直接抛「还没登录抖音」，一次 DOM 都不碰', async () => {
  let wrote = false;
  const page = fakePage({ loggedIn: false });
  const spy = {
    ...page,
    async eval(e) {
      if (/comment-input|contenteditable/.test(e)) { wrote = true; }
      return page.eval(e);
    },
  };
  dy.__setPageOpener(async () => spy);
  try {
    await assert.rejects(
      dy.postComment('7702025102846519419', '这条不该发出去'),
      (e) => e instanceof dy.DouyinError && e.loginRequired === true && /还没登录抖音/.test(e.message),
    );
    assert.equal(wrote, false, '未登录时不该去碰评论输入框');
  } finally {
    dy.__setPageOpener(null);
  }
});

test('likeVideo：未登录直接拒绝，不会去点赞', async () => {
  let clicked = false;
  const page = fakePage({ loggedIn: false });
  const spy = {
    ...page,
    async eval(e) { if (/video-player-digg/.test(e)) clicked = true; return page.eval(e); },
  };
  dy.__setPageOpener(async () => spy);
  try {
    await assert.rejects(
      dy.likeVideo('7702025102846519419', true),
      (e) => e.loginRequired === true && /还没登录抖音/.test(e.message),
    );
    assert.equal(clicked, false, '未登录时不该去点赞');
  } finally {
    dy.__setPageOpener(null);
  }
});

test('postComment：空内容 / 超 100 字在开页面之前就被挡掉', async () => {
  let opened = 0;
  dy.__setPageOpener(async () => { opened++; return fakePage(); });
  try {
    await assert.rejects(dy.postComment('7702025102846519419', '   '), (e) => e.code === 'bad-input');
    await assert.rejects(dy.postComment('7702025102846519419', '字'.repeat(101)), (e) => /100 字/.test(e.message));
    assert.equal(opened, 0, '参数校验失败不该浪费一次开浏览器');
  } finally {
    dy.__setPageOpener(null);
  }
});

// ─── 未登录的只读能力不能崩 ────────────────────────────────
test('loginState：未登录识别为 false，登录后带昵称', async () => {
  dy.__setPageOpener(async () => fakePage({ loggedIn: false }));
  try {
    const a = await dy.loginState();
    assert.equal(a.loggedIn, false);
    assert.equal(a.nickname, '');
  } finally {
    dy.__setPageOpener(null);
  }

  dy.__setPageOpener(async () => fakePage({ loggedIn: true }));
  try {
    const b = await dy.loginState();
    assert.equal(b.loggedIn, true);
    assert.equal(b.nickname, '在逃肥鱼公主');
  } finally {
    dy.__setPageOpener(null);
  }
});

test('hotVideos：页面里没有卡片时抛中文错，不返回空数组冒充成功', async () => {
  dy.__setPageOpener(async () => ({
    async eval() { return []; },
    async text() { return ''; },
    interruptible: true,
    async send() { return {}; },
    async close() {},
  }));
  try {
    await assert.rejects(
      dy.hotVideos({ limit: 8 }),
      (e) => e instanceof dy.DouyinError && /热榜这次没给出视频卡片/.test(e.message),
    );
  } finally {
    dy.__setPageOpener(null);
  }
});

test('hotVideos：解析 + 去重 + limit 生效', async () => {
  dy.__setPageOpener(async () => ({
    async eval(expr) {
      if (/querySelectorAll/.test(expr)) return HOT_CARDS;
      return null;
    },
    async text() { return ''; },
    interruptible: true,
    async send() { return {}; },
    async close() {},
  }));
  try {
    const all = await dy.hotVideos({ limit: 10 });
    assert.equal(all.length, 3);
    const two = await dy.hotVideos({ limit: 2 });
    assert.equal(two.length, 2);
    assert.equal(two[0].vid, '7702025102846519419');
  } finally {
    dy.__setPageOpener(null);
  }
});

test('searchVideos：未登录时抛 loginRequired，而不是返回空数组', async () => {
  dy.__setPageOpener(async () => ({
    async eval() { return []; },
    async text() { return '登录后即可搜索更多精彩视频'; },
    interruptible: true,
    async send() { return {}; },
    async close() {},
  }));
  try {
    await assert.rejects(
      dy.searchVideos('猫'),
      (e) => e.loginRequired === true && /登录/.test(e.message),
    );
    // 空关键词连页面都不该开
    await assert.rejects(dy.searchVideos('  '), (e) => e.code === 'bad-input');
  } finally {
    dy.__setPageOpener(null);
  }
});

// ─── 环境 / 导出完整性 ────────────────────────────────────
test('导出的 7 个能力 + loginState 都在，且没有偷偷依赖 npm 包', async () => {
  const { readFileSync } = await import('node:fs');
  const { dirname, join } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'douyin.mjs'), 'utf-8');
  const imports = [...src.matchAll(/^import\s.*?from\s+['"]([^'"]+)['"]/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ['./web.mjs'], `只该依赖本地的 web.mjs，实际：${imports.join(', ')}`);
});
