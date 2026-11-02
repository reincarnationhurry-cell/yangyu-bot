// 贴吧模块的回归测试：全部不开浏览器。
// 解析函数是「贴吧改版」的第一道防线，必须能在没有网络的机器上跑，
// 所以 DOM 解析都走注入的假 document（tieba.mjs 里的 parseThreads / parseThreadDetail）。
import './_env.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const tieba = await import('../tieba.mjs');

// ─── 假 DOM ────────────────────────────────────────────────
/**
 * 极简的 querySelector，只为这两个解析函数服务。
 * 真实 DOM 里 querySelector 支持后代/属性/组合选择器，这里用几个正则把它糊出来，
 * 够用就行——目标是「喂一份贴吧的 HTML 结构，看解析结果对不对」，
 * 不是重写 jsdom。
 */
function fakeDoc(html, { bodyText = '', title = '' } = {}) {
  const nodes = [...parseNodes(html)];
  const el = (tag, attrs, cls, text, children) => ({
    tagName: String(tag).toUpperCase(),
    className: cls || '',
    attrs: attrs || {},
    text: text || '',
    children: children || [],
    get innerText() {
      const own = this.text || '';
      const kids = this.children.map((c) => c.innerText).filter(Boolean).join('\n');
      return [own, kids].filter(Boolean).join('\n');
    },
    getAttribute(k) {
      return k === 'class' ? this.className : (this.attrs[k] ?? null);
    },
    querySelector(sel) {
      return select(this, sel)[0] || null;
    },
    querySelectorAll(sel) {
      return select(this, sel);
    },
  });

  // 选择器只支持我们这两个解析函数真正用到的语法：
  //   .cls / tag / tag.cls / [attr] / a[href*="x"] / ".a .b"（后代）
  // 实现方式是「先全局收集所有节点，再按最后一段匹配，然后逐段往前找祖先」，
  // 比手写递归好懂，也不会有祖先/兄弟跨层漏掉的问题。
  const allNodes = [];
  const collect = (n) => { allNodes.push(n); n.children.forEach(collect); };
  const kids = nodes.map((n) => toEl(n, el));
  kids.forEach((n) => collect(n));
  const root = el('html', {}, '', '', kids);

  function matches(n, part) {
    const m = /^([a-zA-Z]*)((?:\.\w[\w-]*)*)((?:\[[^\]]+\])*)$/.exec(part);
    if (!m) return false;
    const [, tag, classes, attrs] = m;
    if (tag && n.tagName !== tag.toUpperCase()) return false;
    for (const c of classes.split('.').filter(Boolean)) {
      if (!(` ${n.className} `.includes(` ${c} `))) return false;
    }
    for (const a of attrs.match(/\[[^\]]+\]/g) || []) {
      const am = /^\[([\w-]+)(?:([*^$~|]?=)"?([^"\]]*)"?)?\]$/.exec(a);
      if (!am) return false;
      const [, key, op, val] = am;
      const have = n.getAttribute(key);
      if (have == null) return false;
      if (op === '*=' && !String(have).includes(val)) return false;
      if (op === '=' && String(have) !== val) return false;
    }
    return true;
  }

  function select(scope, sel) {
    // 解析函数大量使用「逗号分隔的候选选择器」(.pb-comment-item, .l_post)，
    // 这里必须支持，否则兜底逻辑在测试里根本走不到，会出现「线上能用、测试全红」的假象。
    const groups = String(sel).split(',').map((s) => s.trim()).filter(Boolean);
    const out = [];
    for (const group of groups) {
      const parts = group.split(/\s+/).filter(Boolean);
      const last = parts[parts.length - 1];
      // scope 里所有后代（scope 是 root 时就是全部）
      const pool = scope === root ? allNodes : (() => {
        const sub = [];
        const walk = (n) => { if (n !== scope) sub.push(n); n.children.forEach(walk); };
        scope.children.forEach(walk);
        return sub;
      })();
      for (const n of pool) {
        if (!matches(n, last)) continue;
        // 前面每段都要在祖先链上（简化版：依次往上找）
        let anc = parents.get(n);
        let ok = true;
        for (let i = parts.length - 2; i >= 0; i--) {
          let hit = null;
          while (anc) { if (matches(anc, parts[i])) { hit = anc; break; } anc = parents.get(anc); }
          if (!hit) { ok = false; break; }
          anc = parents.get(hit);
        }
        if (ok) out.push(n);
      }
    }
    return [...new Set(out)];
  }

  const parents = new Map();
  const linkParents = (n) => { for (const c of n.children) { parents.set(c, n); linkParents(c); } };
  linkParents(root);

  return {
    title,
    body: { innerText: bodyText },
    querySelector: (s) => select(root, s)[0] || null,
    querySelectorAll: (s) => select(root, s),
  };
}

/** 把一段写死的 HTML 串解析成节点树（只认 div/ul/li/a/span/img，够用了） */
function parseNodes(html) {
  const out = [];
  const stack = [];
  const re = /<(\/?)([a-zA-Z]+)((?:\s+[\w-]+(?:="[^"]*")?)*)\s*\/?>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[4] != null) {
      const t = m[4].replace(/\u00a0/g, ' ');
      if (t.trim() && stack.length) stack[stack.length - 1].text += t;
      continue;
    }
    const [, close, tag, attrStr] = m;
    if (close) { stack.pop(); continue; }
    const attrs = {};
    for (const a of attrStr.match(/[\w-]+(?:="[^"]*")?/g) || []) {
      const [k, v] = a.split('=');
      attrs[k] = v ? v.replace(/^"|"$/g, '') : '';
    }
    const node = { tag, attrs, cls: attrs.class || '', text: '', children: [] };
    if (stack.length) stack[stack.length - 1].children.push(node);
    else out.push(node);
    if (!/^(img|br|input)$/i.test(tag)) stack.push(node);
  }
  return out;
}

function toEl(n, el) {
  return el(n.tag, n.attrs, n.cls, n.text, n.children.map((c) => toEl(c, el)));
}

// 贴吧吧首页的真实结构（2026-11 实测，猫吧），含一条置顶 + 一条普通帖
const FORUM_HTML = `
<ul class="threads_list">
  <li class="tl_top scale-1px-bottom" data-tid="11072143936">
    <a href="/p/11072143936?lp=5028&amp;mo_device=1" class="j_common ti_item no_border top" data-tid="11072143936">
      <div class="ti_title"><span class="ti_title_icon ti_icon_zhiding">置顶</span><span>国庆回血计划活动开始了</span></div>
    </a>
  </li>
  <li class="tl_shadow tl_shadow_new" data-tid="11153406284">
    <div class="ti_infos clearfix">
      <div class="ti_author_time"><div class="ti_author_icons"><span class="ti_author">tscd2001</span></div><span class="ti_time">16:11</span></div>
    </div>
    <a href="/p/11153406284?lp=5028&amp;mo_device=1" class="j_common ti_item" data-tid="11153406284">
      <div class="ti_title"><span>一直喂的猫被物业抓走</span></div>
      <div class="ti_zan_reply clearfix"><div class="ti_func_btn btn_reply"><span class="btn_icon">125</span></div></div>
    </a>
  </li>
  <li class="tl_shadow tl_shadow_new" data-tid="11130090550">
    <div class="ti_infos clearfix">
      <div class="ti_author_time"><div class="ti_author_icons"><span class="ti_author">竹合合竹和竹合</span></div><span class="ti_time">16:00</span></div>
    </div>
    <a href="/p/11130090550?lp=5028&amp;mo_device=1" class="j_common ti_item">
      <div class="ti_title"><span>猫咪喜欢上桌吃饭怎么办</span></div>
      <div class="ti_zan_reply clearfix"><div class="ti_func_btn btn_reply"><span class="btn_icon">142</span></div></div>
    </a>
  </li>
</ul>`;

// 帖子页真实结构（2026-11 实测）：.pb-content-item 是楼中楼，.pb-comment-item 才是楼
const THREAD_HTML = `
<div class="pb-page-wrapper">
  <div class="head-line user-info"><a class="head-name">竹合合竹和竹合</a></div>
  <div class="pb-title">猫咪喜欢上桌吃饭怎么办</div>
  <div class="pb-content-wrap">
    <div class="richtext-item"><span class="pb-text-wrapper"><span>一吃饭它就跳上桌，这个菜闻闻那个菜闻闻。</span></span></div>
  </div>
  <div class="forum-name"><span class="name">猫</span></div>
</div>
<div class="pc-pb-first-floor-interactive">1 142 433 3</div>
<div class="pb-comment-item" data-id="154062835021">
  <div class="head-line user-info"><a class="head-name">三无无子</a></div>
  <div class="comment-content no-extra-margin">
    <div class="pb-rich-text"><div class="pb-content-item"><span class="pb-text-wrapper"><span>给它肘下去</span></span></div></div>
    <div class="pc-pb-comments-desc"><div class="comment-desc-left"><span>10-23</span><span> 山东</span></div>
      <div class="comment-desc-right"><span class="zan-container">98</span></div></div>
  </div>
  <div class="lzl-wrapper">
    <div class="pb-lzl-item"><a class="head-name">胶胶原</a><div class="pb-rich-text"><div class="pb-content-item">正确的</div></div></div>
    <div class="pb-lzl-item"><a class="head-name">流氓精英</a><div class="pb-rich-text"><div class="pb-content-item">ip正确</div></div></div>
  </div>
</div>
<div class="pb-comment-item" data-id="154062622278">
  <div class="head-line user-info"><a class="head-name">布布🐵</a></div>
  <div class="comment-content no-extra-margin">
    <div class="pb-rich-text"><div class="pb-content-item"><span class="pb-text-wrapper"><span>直接赶下去</span></span></div></div>
    <div class="pc-pb-comments-desc"><div class="comment-desc-left"><span>10-23</span><span> 江苏</span></div>
      <div class="comment-desc-right"><span class="zan-container">83</span></div></div>
  </div>
</div>`;

// ─── 纯函数：URL 拼接 ──────────────────────────────────────
test('parseTid：数字 / 路径 / 完整链接都能认，乱给要报中文错', () => {
  assert.equal(tieba.parseTid('11130090550'), '11130090550');
  assert.equal(tieba.parseTid('https://tieba.baidu.com/p/11130090550?lp=5028&mo_device=1'), '11130090550');
  assert.equal(tieba.parseTid('/p/11130090550'), '11130090550');
  assert.equal(tieba.parseTid('  https://tieba.baidu.com/p/11130090550  '), '11130090550');
  assert.throws(() => tieba.parseTid(''), (e) => e instanceof tieba.TiebaError && e.code === 'BAD_TID');
  assert.throws(() => tieba.parseTid('不知道什么'), (e) => /看不出这是哪个帖子/.test(e.message));
});

test('forumUrl：走移动版入口（桌面版必撞安全验证），翻页用 pn 偏移', () => {
  assert.equal(tieba.forumUrl('猫'), 'https://tieba.baidu.com/mo/q/m?kw=%E7%8C%AB');
  assert.equal(tieba.forumUrl('猫吧'), 'https://tieba.baidu.com/mo/q/m?kw=%E7%8C%AB', '带「吧」后缀要剥掉');
  // 第 1 页 = 偏移 20，第 2 页 = 40；贴吧的 pn 是条数偏移不是页码
  assert.equal(tieba.forumUrl('猫', 1), 'https://tieba.baidu.com/mo/q/m?kw=%E7%8C%AB&pn=20');
  assert.equal(tieba.forumUrl('猫', 2), 'https://tieba.baidu.com/mo/q/m?kw=%E7%8C%AB&pn=40');
  assert.ok(tieba.forumUrl('猫').startsWith('https://tieba.baidu.com/mo/q/m'), '绝不能用 /f?kw=');
  assert.throws(() => tieba.forumUrl(''), (e) => e.code === 'BAD_FORUM');
});

test('threadUrl / searchUrl：统一入口', () => {
  assert.equal(tieba.threadUrl('11130090550'), 'https://tieba.baidu.com/p/11130090550?lp=5028&mo_device=1');
  assert.equal(tieba.searchUrl('猫'), 'https://tieba.baidu.com/f/search/res?qw=%E7%8C%AB');
  assert.throws(() => tieba.searchUrl('  '), (e) => e.code === 'BAD_KEYWORD');
});

// ─── 纯函数：计数解析 ──────────────────────────────────────
test('parseCount：贴吧的 "295W" 是西文 W，不是「万」', () => {
  assert.equal(tieba.parseCount('142'), 142);
  assert.equal(tieba.parseCount('1.4万'), 14000);
  assert.equal(tieba.parseCount('295W'), 2_950_000);
  assert.equal(tieba.parseCount('4408.3W'), 44_083_000);
  assert.equal(tieba.parseCount('3.2亿'), 320_000_000);
  assert.equal(tieba.parseCount('--'), 0, '没有数字要给 0，不能是 NaN');
  assert.equal(tieba.parseCount(''), 0);
  assert.equal(tieba.parseCount(null), 0);
});

// ─── 纯函数：节流 ─────────────────────────────────────────
test('waitMsFor：还没到点要等，到了点/从没做过都不用等', () => {
  assert.equal(tieba.waitMsFor(null, 1000, 30_000), 0, '第一次不用等');
  assert.equal(tieba.waitMsFor(1000, 1000, 30_000), 30_000);
  assert.equal(tieba.waitMsFor(1000, 5000, 30_000), 26_000);
  assert.equal(tieba.waitMsFor(1000, 31_000, 30_000), 0);
  assert.equal(tieba.waitMsFor(1000, 99_999, 30_000), 0, '过了很久也不能是负数');
});

test('LIMITS：回帖至少 30 秒一条（硬要求），关注更慢', () => {
  assert.ok(tieba.LIMITS.reply >= 30_000, `回帖间隔 ${tieba.LIMITS.reply} 必须 ≥ 30 秒`);
  assert.ok(tieba.LIMITS.follow >= tieba.LIMITS.reply);
});

test('throttleLeft：没做过时是 0，做过之后要等满间隔', () => {
  tieba.resetThrottle();
  assert.equal(tieba.throttleLeft('reply'), 0);
  // 用真实节流路径不好测（要等 30 秒），这里验证水位读的是同一套 LIMITS
  assert.equal(tieba.LIMITS.reply, 30_000, '上限就是 30 秒，别偷偷调小');
  tieba.resetThrottle();
});

// ─── DOM 解析：吧内帖子列表 ────────────────────────────────
test('parseThreads：置顶、作者、回复数、标题都能读出来', () => {
  const doc = fakeDoc(FORUM_HTML);
  const list = tieba.parseThreads(doc);
  assert.equal(list.length, 3);

  const [top, norm, third] = list;
  assert.equal(top.tid, '11072143936');
  assert.equal(top.title, '国庆回血计划活动开始了', '「置顶」角标不能混进标题');
  assert.equal(top.isTop, true);
  assert.equal(top.url, '/p/11072143936');

  assert.equal(norm.tid, '11153406284');
  assert.equal(norm.title, '一直喂的猫被物业抓走');
  assert.equal(norm.replyCount, 125);
  assert.equal(norm.isTop, false);
  assert.equal(norm.author, 'tscd2001');
  assert.equal(norm.lastReplyAt, '16:11');

  // 最后一条：li 上没有 data-tid，得从 href 里抠出来
  assert.equal(third.tid, '11130090550');
  assert.equal(third.replyCount, 142);
  assert.equal(third.author, '竹合合竹和竹合');
});

test('parseThreads：tid 重复要去重（置顶贴翻页时会出现两遍）', () => {
  const dup = FORUM_HTML.replace('</ul>', `
    <li class="tl_shadow" data-tid="11153406284">
      <a href="/p/11153406284?lp=5028" class="ti_item"><div class="ti_title"><span>重复的那条</span></div></a>
    </li></ul>`);
  const list = tieba.parseThreads(fakeDoc(dup));
  assert.equal(list.filter((x) => x.tid === '11153406284').length, 1);
});

test('parseThreads：旧版结构 li.medias_wrap 也能兜住（贴吧改版不整块崩）', () => {
  const old = `<ul class="threads_list">
    <li class="medias_wrap ordinary_thread" data-tid="123456789">
      <a href="/p/123456789?lp=5028">旧版标题第一行\n66</a>
    </li></ul>`;
  const list = tieba.parseThreads(fakeDoc(old));
  assert.equal(list.length, 1);
  assert.equal(list[0].tid, '123456789');
  assert.equal(list[0].replyCount, 66, '回复数黏在链接文本末尾时也要认');
  assert.ok(!/\d+$/.test(list[0].title), '标题末尾不能留着回复数');
});

test('parseThreads：空页面给空数组，不炸', () => {
  assert.deepEqual(tieba.parseThreads(fakeDoc('<div>什么都没有</div>')), []);
  assert.deepEqual(tieba.parseThreads(null), [], '没传 doc 也要安全');
});

// ─── DOM 解析：帖子详情 ────────────────────────────────────
test('parseThreadDetail：标题 / 吧名 / 楼主 / 正文', () => {
  const d = tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '全部回复 (142)' }));
  assert.equal(d.title, '猫咪喜欢上桌吃饭怎么办');
  assert.equal(d.forumName, '猫');
  assert.equal(d.author, '竹合合竹和竹合');
  assert.equal(d.content, '一吃饭它就跳上桌，这个菜闻闻那个菜闻闻。');
});

test('parseThreadDetail：楼层正文不会被楼中楼和时间黏进来', () => {
  const d = tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '全部回复 (142)' }));
  assert.equal(d.floors.length, 2);
  const [f1, f2] = d.floors;
  assert.equal(f1.floor, 1);
  assert.equal(f1.author, '三无无子');
  // 这是最容易错的一处：直接读 .comment-content 的 innerText 会变成
  // "给它肘下去 10-23 山东 98 回复 胶胶原 正确的..."
  assert.equal(f1.text, '给它肘下去');
  assert.equal(f1.time, '10-23');
  assert.equal(f1.location, '山东');
  assert.equal(f1.likeCount, 98);
  assert.equal(f2.author, '布布🐵');
  assert.equal(f2.text, '直接赶下去');
  assert.equal(f2.likeCount, 83);
});

test('parseThreadDetail：楼中楼单独挂在 replies 里', () => {
  const d = tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '全部回复 (142)' }));
  assert.equal(d.floors[0].replies.length, 2);
  assert.deepEqual(d.floors[0].replies[0], { author: '胶胶原', text: '正确的' });
  assert.deepEqual(d.floors[0].replies[1], { author: '流氓精英', text: 'ip正确' });
  assert.equal(d.floors[1].replies.length, 0);
});

test('parseThreadDetail：回复数取「全部回复 (142)」，取不到就用互动条', () => {
  assert.equal(tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '全部回复 (142)' })).replyCount, 142);
  const noHead = tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '' }));
  assert.equal(noHead.replyCount, 433, '退回 .pc-pb-first-floor-interactive 的最大数');
});

test('parseThreadDetail：未登录要标出来（贴吧只放一部分回复）', () => {
  const anon = tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '想说点啥？先登录一下吧~' }));
  assert.equal(anon.loggedInHint, true);
  const logged = tieba.parseThreadDetail(fakeDoc(THREAD_HTML, { bodyText: '全部回复 (142)' }));
  assert.equal(logged.loggedInHint, false);
});

test('parseThreadDetail：空页面给空结构，不炸', () => {
  const d = tieba.parseThreadDetail(fakeDoc('<div>x</div>'));
  assert.equal(d.title, '');
  assert.deepEqual(d.floors, []);
  assert.equal(d.replyCount, 0);
  assert.deepEqual(tieba.parseThreadDetail(null).floors, []);
});

// ─── 写操作的闸门 ─────────────────────────────────────────
test('replyToThread：内容为空要拦下来（还没走到登录检查）', async () => {
  await assert.rejects(tieba.replyToThread('11130090550', '   '), (e) => e.code === 'BAD_TEXT');
  await assert.rejects(tieba.replyToThread('11130090550', ''), (e) => e.code === 'BAD_TEXT');
});

test('replyToThread：超长内容要拦下来', async () => {
  await assert.rejects(
    tieba.replyToThread('11130090550', '猫'.repeat(1001)),
    (e) => e.code === 'TOO_LONG' && /太长/.test(e.message),
  );
});

test('followForum：吧名为空要拦下来', async () => {
  await assert.rejects(tieba.followForum('  '), (e) => e.code === 'BAD_FORUM');
});

test('错误信息都是中文人话，不吐选择器原文', () => {
  const cases = [
    () => tieba.parseTid('xx'),
    () => tieba.forumUrl(''),
    () => tieba.searchUrl(''),
  ];
  for (const fn of cases) {
    try { fn(); assert.fail('应该抛错'); } catch (e) {
      assert.ok(e instanceof tieba.TiebaError, `${e.message} 应该是 TiebaError`);
      assert.match(e.message, /[\u4e00-\u9fa5]/, '消息里得有中文');
      assert.ok(!/querySelector|undefined|Cannot read/.test(e.message), `不许吐实现细节：${e.message}`);
    }
  }
});
