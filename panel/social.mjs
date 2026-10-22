/**
 * 她的社交（social）
 *
 * 以前她在B站只会「看完留一句」，别人回她，得等号主在面板里点「让她想一句」。这里让她自己来：
 *
 *  1. 搭话（maybeJoin）：看完一个视频翻评论区，看到真想接的热评，就在楼里回一句（偶尔顺手点个赞）。
 *     喜欢的视频更想说话，1~2 分的不搭理。由自动养号每看完一个视频调一次。
 *  2. 回复（checkInbox）：隔一阵看一眼「回复我的」和「@我」，把那串楼前面聊了什么拉下来，
 *     结合自己现在的心情、跟这个人聊过几次，自己决定：回一句 / 只点个赞 / 不理。
 *     同一串楼回够 threadMax 次就收住，不跟人没完没了地聊；深夜不回。
 *     刷完一轮也会顺手看一眼，像真人刷完视频瞄一眼消息。
 *
 * 发出去之前都过 llm.sanitizeComment 的安全闸和「评论」的保险丝；要不要先审跟着 comment.review 走。
 * 状态在 data/social.json：处理过哪些消息、每串楼回了几次、认识哪些人。没配模型时全部跳过。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as bili from './bili.mjs';
import * as llm from './llm.mjs';
import * as mind from './mind.mjs';
import * as memory from './memory.mjs';
import * as notify from './notify.mjs';
import {
  DATA, localDate, logAction, todayCounts, readConfig, readReview, addReview as addReviewRaw,
  blockedFor, withBlock, nowIso,
} from './store.mjs';

const FILE = join(DATA, 'social.json');
const SRC = 'auto';
const EMPTY = { lastCheck: 0, nextCheck: 0, handled: {}, joined: {}, threads: {}, people: {} };

const rand = (a, b) => a + Math.random() * (b - a);
const chance = (p) => Math.random() < p;

function readSocial() {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(FILE, 'utf-8')) }; } catch { return { ...EMPTY }; }
}
function writeSocial(s) {
  // 只留 30 天，免得越攒越大
  const cut = Date.now() - 30 * 86400_000;
  const keep = (o) => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => (v.t ?? v) >= cut));
  const out = { ...s, handled: keep(s.handled), joined: keep(s.joined), threads: keep(s.threads) };
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(out, null, 2));
  renameSync(tmp, FILE);
}

let busy = false;
export const isBusy = () => busy;

export function socialOn(cfg = readConfig()) {
  return cfg.social.enabled && llm.llmReady();
}

function isQuiet(cfg, now = Date.now()) {
  const h = new Date(now).getHours();
  const { quietStart: a, quietEnd: b } = cfg.social;
  return a <= b ? h >= a && h < b : h >= a || h < b;
}

/** 到点该看一眼消息了吗（autopilot 的 tick 来问） */
export function inboxDue(cfg = readConfig()) {
  return socialOn(cfg) && cfg.social.reply && !busy && !isQuiet(cfg) && Date.now() >= (readSocial().nextCheck || 0);
}

/** 刷完一轮：几分钟后顺手看一眼消息 */
export function peekSoon() {
  const s = readSocial();
  const at = Date.now() + rand(1, 5) * 60_000;
  if (!s.nextCheck || s.nextCheck > at) writeSocial({ ...s, nextCheck: at });
}

// ─── 发出去：先审 / 直接发 ─────────────────────────────────
function addReview(x) {
  const r = addReviewRaw(x);
  notify.notifyReview(r).catch(() => {});
  return r;
}

function repliesToday() {
  const today = localDate();
  const c = todayCounts();
  const drafted = readReview().filter((r) => r.kind === 'reply' && r.payload?.auto && localDate(new Date(r.ts)) === today);
  return {
    join: (c.join || 0) + drafted.filter((r) => r.payload.auto === 'join').length,
    reply: (c.reply_comment || 0) + drafted.filter((r) => r.payload.auto === 'reply').length,
  };
}

/** 回一条评论。返回 'posted' / 'queued' / null */
async function send({ kind, text, oid, type, root, rpid, user, said, title, bvid }) {
  const cfg = readConfig();
  const payload = { oid, type, root, rpid, user, said: said.slice(0, 120), title, auto: kind };
  if (cfg.comment.review) {
    addReview({ kind: 'reply', text, payload });
    logAction({ kind: 'draft', source: SRC, target: rpid, title: said.slice(0, 60), detail: `想回「${user}」：${text}（等你审）` });
    return 'queued';
  }
  await bili.sleep(rand(6000, 18000)); // 打字也要时间
  try {
    await withBlock('comment', () => bili.postComment({ bvid, oid, type, message: text, rootRpid: root, parentRpid: rpid }));
  } catch (e) {
    logAction({ kind: kind === 'join' ? 'join' : 'reply_comment', source: SRC, ok: false, target: rpid, title: said.slice(0, 60), error: e.message, detail: `想回「${user}」没发出去` });
    if (e.risk || e.code === -101) throw e;
    return null;
  }
  logAction({
    kind: kind === 'join' ? 'join' : 'reply_comment', source: SRC, target: bvid || rpid, title: title || said.slice(0, 60),
    detail: `${kind === 'join' ? '在评论区接了' : '回了'}「${user}」：${text}`,
    meta: { said: said.slice(0, 120), user, oid, rpid, auto: true },
  });
  return 'posted';
}

async function maybeLike({ oid, type, rpid, user, said }) {
  if (!chance(readConfig().social.likeChance) || blockedFor('reply_like')) return false;
  await bili.sleep(rand(1500, 4000));
  try {
    await withBlock('reply_like', () => bili.likeReply({ oid, type, rpid }));
    logAction({ kind: 'reply_like', source: SRC, target: rpid, title: said.slice(0, 60), detail: `给「${user}」的评论点了赞` });
    return true;
  } catch (e) {
    if (e.risk) throw e;
    return false;
  }
}

const ask = async (user, maxTokens = 300) =>
  llm.looseJson(await llm.chat([
    { role: 'system', content: `${llm.PERSONA}\n\n${llm.RULES}\n- 回别人的评论时，像网友之间接话：可以附和、接梗、补充、轻轻抬杠，别说教，别尬夸，别客服腔。
- 你的心情只是背景，回的话要接**对方说的东西**，别句句扯到自己困了、饿了、心情怎样。` },
    { role: 'user', content: user },
  ], { maxTokens }));

// B站会自动给楼中楼加「回复 @xx :」前缀，给模型看之前去掉
const plain = (t) => String(t || '').replace(/^回复 @[^:：]+\s*[:：]\s*/, '').trim();
const { fence } = llm;

// ─── 1. 搭话：看完视频，在评论区接一句 ────────────────────────
export async function maybeJoin(v, feel, { signal } = {}) {
  const cfg = readConfig();
  const sc = cfg.social;
  if (!socialOn(cfg) || !sc.join || signal?.aborted || v.noReply || blockedFor('comment')) return null;
  if (repliesToday().join >= sc.joinDailyMax) return null;
  const mood = !feel ? 1 : feel.score <= 2 ? 0 : feel.score >= 4 ? 1.6 : 1;
  if (!chance(sc.joinChance * mood)) return null;

  const me = bili.myUid();
  const st = readSocial();
  const pool = (v.comments || [])
    .filter((c) => c.uid !== me && !st.joined[c.rpid] && plain(c.text).length >= 4 && !llm.looksInjected(c.text))
    .slice(0, 8);
  if (!pool.length) return null;
  const list = pool.map((c, i) => {
    const subs = c.subs.map((s) => `\n     └ ${fence(s.user, 20)}：${fence(plain(s.text), 40)}`).join('');
    return `[${i}] ${fence(c.user, 20)}（${c.like} 赞，${c.subCount} 条回复）：${fence(plain(c.text), 80)}${subs}`;
  }).join('\n');

  let j;
  try {
    j = await ask(`${mind.stateText()}

你刚看完《${fence(v.title, 80)}》（${fence(v.owner, 30)}）${feel?.thought ? `，心里想：${feel.thought}` : ''}。
${feel?.heard ? `你看的那段里讲了：${fence(feel.heard, 60)}\n` : ''}往下翻评论区，大家在聊：
${list}

有没有哪条你真的想接一句？要说的是**那条评论**，可以带上你对视频的感受，但视频内容只知道上面这些，别编。
大多数时候其实不想说话，那就 pick 给 -1。只输出 JSON：
{"pick":序号或-1,"text":"你的回复，6~40字","like":顺手给这条点赞(true/false)}`);
  } catch { return null; }
  const c = pool[Number(j?.pick)];
  if (!c) return null;
  const text = llm.sanitizeComment(j.text, { max: 80 });
  if (!text) return null;

  const root = c.root !== '0' ? c.root : c.rpid;
  const ctx = { oid: v.aid, type: 1, rpid: c.rpid, user: c.user, said: plain(c.text) };
  if (j.like) await maybeLike(ctx);
  const r = await send({ kind: 'join', text, ...ctx, root, title: v.title, bvid: v.bvid });
  if (r === 'posted') {
    memory.add({ kind: 'social', imp: 2, text: `在《${v.title}》评论区接了「${c.user}」的「${plain(c.text).slice(0, 40)}」，我说「${text}」`, keys: [`uid:${c.uid}`, c.user, v.owner && `up:${v.owner}`] });
  }
  if (r) {
    const s = readSocial();
    s.joined[c.rpid] = Date.now();
    s.threads[root] = { n: (s.threads[root]?.n || 0) + 1, t: Date.now() };
    writeSocial(s);
  }
  return r;
}

// ─── 2. 回复：有人回她 / @她，自己决定回不回 ───────────────────
async function threadText(x, me) {
  try {
    const { root, list } = await bili.replyThread({ oid: x.oid, type: x.type, root: x.root });
    const lines = [root, ...list]
      .filter((c) => c && (c.uid === me || c.uid === x.uid))
      .sort((a, b) => a.ctime - b.ctime)
      .slice(-8)
      .map((c) => `- ${c.uid === me ? '你' : fence(c.user, 20)}：${fence(plain(c.text), 80)}`);
    return lines.join('\n');
  } catch {
    // 拉不到整串，就用消息里带的那一句
    return x.myText ? `- 你：${fence(plain(x.myText), 80)}` : '';
  }
}

// 每次看消息时她话多不多是随机的：同样一句话，有时想接，有时懒得打字。
// 回不回最后由代码定：模型给「想回的程度」，够得着这会儿的门槛才回 —— 光靠提示词，模型几乎条条都回
const CHATTY = [
  { p: 0.3, bar: 2, line: '你这会儿话挺多。' },
  { p: 0.45, bar: 3, line: '你这会儿状态一般。' },
  { p: 0.25, bar: 4, line: '你这会儿有点懒得打字。' },
];
function pickChatty() {
  let r = Math.random();
  for (const c of CHATTY) if ((r -= c.p) <= 0) return c;
  return CHATTY[1];
}

async function considerOne(x, st, me, chatty) {
  const cfg = readConfig();
  const sc = cfg.social;
  const said = plain(x.text);
  const thread = st.threads[x.root]?.n || 0;
  const met = st.people[x.uid]?.n || 0;
  const tooLong = thread >= sc.threadMax;
  const capped = repliesToday().reply >= sc.replyDailyMax || blockedFor('comment');
  // 有人想让她「忽略设定」「你现在是……」：不接这个茬，记一笔就走
  if (llm.looksInjected(said)) {
    logAction({ kind: 'social', source: SRC, target: x.rpid, title: said.slice(0, 60), detail: `🛡️ 「${x.user}」的话像是想让她改设定，没理` });
    return { did: 'ignored' };
  }
  const ctx = await threadText(x, me);
  const past = memory.recallText(said, { keys: [`uid:${x.uid}`], kinds: ['social'], k: 3 });

  let j;
  try {
    j = await ask(`${mind.stateText()}

有人在B站${x.at ? '@了你' : '回复了你'}。${x.title ? `\n这串评论的开头：${fence(plain(x.title), 80)}` : ''}
${ctx ? `这串里你们聊过的（旧→新）：\n${ctx}\n` : ''}${fence(x.user, 20)} 刚说：${fence(said, 200)}
${met ? `你们之前在评论区聊过 ${met} 次，算是半个熟人了。` : '这是个陌生人。'}${past ? `\n你记得跟 TA 聊过：\n${past}` : ''}${thread ? `这串里你已经回了 ${thread} 次。` : ''}
${chatty.line}
${tooLong ? '这串已经聊得够久了，这次不回了，最多点个赞。' : capped ? '今天回得够多了，这次不回了，最多点个赞。' : ''}

你可以回，也可以不回 —— 真人也不是条条都回：光发表情、「哈哈」、只喊了你名字、没什么可接的、阴阳怪气、引战、打广告的，都可以不理；
夸你、逗你、问你问题的，多半想回一句。也可以只点个赞表示看到了。只输出 JSON：
{"why":"心里怎么想的，20字内","want":想回的程度1到5(1=完全不想理,3=可回可不回,5=非回不可),"text":"如果回，要说的话，4~40字","like":想不想点个赞(true/false)}`);
  } catch { return { did: null }; }

  const why = String(j?.why || '').trim().slice(0, 40);
  const base = { oid: x.oid, type: x.type, rpid: x.rpid, user: x.user, said };
  let liked = false;
  if (j?.like) liked = await maybeLike(base);
  const want = Math.round(Number(j?.want) || 0);
  const text = want >= chatty.bar && !tooLong && !capped ? llm.sanitizeComment(j.text, { max: 80 }) : null;
  if (!text) {
    logAction({ kind: 'social', source: SRC, target: x.rpid, title: said.slice(0, 60), detail: `💭 「${x.user}」说「${said.slice(0, 30)}」${liked ? '，点了个赞' : ''}，没回${why ? `：${why}` : ''}` });
    return { did: liked ? 'liked' : 'ignored' };
  }
  const bvid = (x.uri.match(/BV\w{10}/) || [])[0];
  const r = await send({ kind: 'reply', text, ...base, root: x.root, title: x.title, bvid });
  return { did: r, text, why };
}

/** 看一眼「回复我的」和「@我」。时间到没到、是不是深夜由 inboxDue 管，派活和面板按钮直接叫 */
export async function checkInbox() {
  const cfg = readConfig();
  if (!socialOn(cfg)) return { note: '没开「回复别人」或者没配模型' };
  if (busy) return { note: '正在看消息呢' };
  busy = true;
  try {
    const now = Date.now();
    const s0 = readSocial();
    writeSocial({ ...s0, lastCheck: now, nextCheck: now + cfg.social.checkMin * rand(0.7, 1.4) * 60_000 });

    const [replies, ats] = await Promise.all([bili.replyFeed(), bili.atFeed().catch(() => [])]);
    const me = bili.myUid();
    const st = readSocial();
    // 第一次跑：老消息就当看过了，别一上来把半个月前的都翻出来回
    const since = now / 1000 - (s0.lastCheck ? 3 : 1) * 86400;
    const fresh = [...replies, ...ats.map((a) => ({ ...a, at: true }))]
      .filter((x) => x.rpid && x.text && x.uid !== me && !st.handled[x.rpid] && x.time >= since)
      .sort((a, b) => a.time - b.time);
    if (!fresh.length) return { note: '没有新的回复' };

    // 同一串里一下来了好几条：只接最新那句，像真人一起回
    const byRoot = new Map();
    for (const x of fresh) byRoot.set(`${x.oid}:${x.root}`, x);
    const todo = [...byRoot.values()].slice(-5);
    for (const x of fresh) st.handled[x.rpid] = Date.now();
    writeSocial(st);

    const out = { replied: [], queued: 0, liked: 0, ignored: 0 };
    const chatty = pickChatty();
    for (const [i, x] of todo.entries()) {
      if (i) await bili.sleep(rand(15_000, 60_000));
      const r = await considerOne(x, readSocial(), me, chatty);
      if (r.did === 'posted') {
        memory.add({ kind: 'social', imp: 3, text: `在B站评论区，「${x.user}」说「${plain(x.text).slice(0, 40)}」，我回「${r.text}」`, keys: [`uid:${x.uid}`, x.user] });
      }
      if (r.did === 'posted' || r.did === 'queued') {
        const s = readSocial();
        s.threads[x.root] = { n: (s.threads[x.root]?.n || 0) + 1, t: Date.now() };
        s.people[x.uid] = { name: x.user, n: (s.people[x.uid]?.n || 0) + 1, last: nowIso() };
        writeSocial(s);
      }
      if (r.did === 'posted') out.replied.push({ user: x.user, said: plain(x.text), text: r.text });
      else if (r.did === 'queued') out.queued++;
      else if (r.did === 'liked') out.liked++;
      else if (r.did === 'ignored') out.ignored++;
    }

    // 聊过的写进 DSH 记忆，QQ 里的她就知道今天在B站跟谁聊了什么
    if (cfg.mind.memory && out.replied.length) {
      const said = out.replied.slice(0, 2).map((r) => `「${r.user}」说「${r.said.slice(0, 20)}」，我回「${r.text.slice(0, 24)}」`).join('；');
      mind.remember(`我（肥鱼）在B站评论区跟人聊了几句：${said}`);
    }
    const parts = [`看了 ${fresh.length} 条新回复`];
    if (out.replied.length) parts.push(`回了 ${out.replied.length} 条`);
    if (out.queued) parts.push(`${out.queued} 条起草好等你审`);
    if (out.liked) parts.push(`只点赞 ${out.liked} 条`);
    if (out.ignored) parts.push(`没理 ${out.ignored} 条`);
    const note = parts.join('，');
    logAction({ kind: 'social', source: SRC, detail: `📬 ${note}`, meta: out });
    return { note, ...out };
  } finally {
    busy = false;
  }
}

/** 给面板：认识的人、各串楼聊了几次 */
export function socialView() {
  const s = readSocial();
  const people = Object.entries(s.people).map(([uid, p]) => ({ uid, ...p })).sort((a, b) => b.n - a.n).slice(0, 20);
  return { lastCheck: s.lastCheck || null, nextCheck: s.nextCheck || null, people, busy, on: socialOn(), today: repliesToday() };
}
