/**
 * 她学说话（lingo）
 *
 * 学 MaiBot 的「黑话学习」：真人在B站泡久了，会不知不觉学会评论区的梗和说法。这里让她也这样：
 *
 *  1. 收集（collect）：每认真看完一个视频，把热评里赞多的几条攒进「今天见过的评论」。
 *  2. 学（learn）：每晚睡前翻一遍，挑出她看得懂、又真在流行的说法（梗、口头禅、新词），记下意思和例句；
 *     已经会的又见到了就算「又碰到一次」。30 天没再碰到的慢慢忘掉，最多记 30 个。
 *  3. 用（lingoText）：她写评论、在评论区接话时，把最近常见的几个说法给她看，合适就自然用一个。
 *     新学会的也写进 DSH 记忆，QQ 里的她也会知道。
 *
 * 只从B站学。号主的口头禅由 QQ 里的她用记忆工具自己记（AGENTS.md），不拿到B站公开评论里用。
 * 脏话、引战、地域黑、擦边的不学。数据在 data/lingo.json。
 */
import { readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as llm from './llm.mjs';
import { DATA, localDate } from './store.mjs';

const FILE = join(DATA, 'lingo.json');
const INBOX_MAX = 80;
const KEEP = 30;
const FORGET_DAYS = 30;
const EMPTY = { inbox: [], words: [], learnedOn: '' };

export function readLingo() {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(FILE, 'utf-8')) }; } catch { return { ...EMPTY, inbox: [], words: [] }; }
}

function writeLingo(l) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(l, null, 2));
  renameSync(tmp, FILE);
}

/** 看完一个视频：热评里赞多的攒起来（只要文字，不要人名） */
export function collect(v) {
  const top = (v.comments || [])
    .filter((c) => c.like >= 20 && c.text.length >= 4 && c.text.length <= 80 && !llm.looksInjected(c.text))
    .sort((a, b) => b.like - a.like)
    .slice(0, 4)
    .map((c) => String(c.text).replace(/^回复 @[^:：]+\s*[:：]\s*/, '').replace(/\[[^\]]{1,8}\]/g, '').trim())
    .filter(Boolean);
  if (!top.length) return;
  const l = readLingo();
  l.inbox = [...l.inbox, ...top.filter((t) => !l.inbox.includes(t))].slice(-INBOX_MAX);
  writeLingo(l);
}

/** 学到的说法要像个说法：不长、不带链接、不像在下指令 */
export function okPhrase(p) {
  const t = String(p || '').trim();
  // 求赞、求关注、求三连这类是引流，学了就违反评论规矩
  return t.length >= 2 && t.length <= 12 && !/(https?:|www\.|微信|加群|@|赞了?我|求赞|点赞|关注|三连|投币)/i.test(t) && !llm.looksInjected(t);
}

const daysSince = (date, today) => (Date.parse(today) - Date.parse(date)) / 86400_000;

/** 合并模型给的结果；纯函数，方便测 */
export function absorb(l, j, today = localDate()) {
  const words = l.words.map((w) => ({ ...w }));
  const fresh = [];
  for (const s of Array.isArray(j?.seen) ? j.seen : []) {
    const w = words.find((x) => x.phrase === String(s).trim());
    if (w) { w.n++; w.last = today; }
  }
  for (const x of Array.isArray(j?.new) ? j.new : []) {
    const phrase = String(x?.phrase || '').trim();
    const meaning = String(x?.meaning || '').trim().slice(0, 40);
    if (!okPhrase(phrase) || !meaning || llm.looksInjected(meaning)) continue;
    const w = words.find((y) => y.phrase === phrase);
    if (w) { w.n++; w.last = today; continue; }
    const example = String(x?.example || '').trim().slice(0, 60);
    const nw = { phrase, meaning, example: llm.looksInjected(example) ? '' : example, at: today, last: today, n: 1 };
    words.push(nw);
    fresh.push(nw);
  }
  const kept = words
    .filter((w) => daysSince(w.last, today) <= FORGET_DAYS)
    .sort((a, b) => (b.last > a.last ? 1 : b.last < a.last ? -1 : b.n - a.n))
    .slice(0, KEEP);
  return { words: kept, fresh: fresh.filter((w) => kept.includes(w)), forgot: words.length - kept.length };
}

/**
 * 每晚学一次（跟着睡前反思跑，一天一次、只调一次模型，所以不占后台预算）。
 * remember：把新学会的写进 DSH 记忆的函数（mind.remember），QQ 里的她也知道
 */
export async function learn({ remember, today = localDate() } = {}) {
  const l = readLingo();
  if (l.learnedOn === today) return null;
  l.learnedOn = today;
  if (l.inbox.length < 5 || !llm.llmReady()) {
    const { words, forgot } = absorb(l, {}, today);
    writeLingo({ ...l, words });
    return { fresh: [], forgot };
  }
  let j;
  try {
    const out = await llm.chat([
      { role: 'system', content: `${llm.PERSONA}\n睡前回想今天在B站评论区见到的话，看看学会了什么新说法。只输出 JSON。` },
      { role: 'user', content: `今天见过的热评：
${l.inbox.map((t) => `- ${llm.fence(t, 80)}`).join('\n')}

你已经会的说法：${l.words.map((w) => `「${w.phrase}」`).join('') || '（还没有）'}

挑出 0~3 个**新的**、网友之间在流行的说法（梗、口头禅、新词、固定句式），你得看得懂它什么意思。
普通词、整句话、人名、脏话、引战、地域黑、擦边、骂人的都不要；求赞、求关注、求三连这类引流句式也不要。已经会的说法今天又见到了，放进 seen。
{"new":[{"phrase":"说法本身，2~12字","meaning":"什么意思、什么时候用，20字内","example":"热评里用它的那句"}],"seen":["今天又见到的已会说法"]}` },
    ], { maxTokens: 500, tag: 'lingo', essential: true });
    j = llm.looseJson(out);
  } catch {
    writeLingo(l); // 今天算学过了，明天接着用攒的
    return null;
  }
  const { words, fresh, forgot } = absorb(l, j, today);
  writeLingo({ ...l, inbox: [], words });
  if (remember) for (const w of fresh) remember(`我（肥鱼）在B站学了个新说法：「${w.phrase}」，${w.meaning}`);
  return { fresh, forgot };
}

/** 给写评论、接话用：最近常碰到的几个说法 */
export function lingoText(k = 4) {
  const words = readLingo().words.slice(0, k);
  if (!words.length) return '';
  return `你最近在B站学会的说法（合适就自然用一个，不合适千万别硬塞，大多数时候不用）：${words.map((w) => `「${w.phrase}」= ${w.meaning}`).join('；')}`;
}
