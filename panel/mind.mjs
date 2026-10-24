/**
 * 她的内心（mind）
 *
 * 自动养号原本全是写死的概率：35% 点赞、12% 评论、兴趣关键词固定。这里给她一点「内在状态」，
 * 让刷 B站 这件事由她自己的心思带着走，活动记录里才会出现意料之外的东西：
 *
 *  1. 刷之前（planSession）：看看自己的心情、最近着迷的东西，决定今天想搜什么。
 *  2. 每看完一个（react）：留一句内心独白，打个喜欢程度，想不想顺着往下挖。
 *     有字幕就读她真正看到的那一段，独白里分开记「视频里讲了什么（带时间）/ UP 主怎么看 / 我怎么想」，
 *     时间戳和内容由代码核对，对不上就不算「看到了」；没字幕就只凭标题和评论，不许编。
 *     顺便想起以前相关的经历（memory.mjs），看完记一条进记忆流。
 *     喜欢程度会影响点赞 / 评论；想挖就顺着 UP 主或关键词再看一个（autopilot 里做）。
 *  3. 刷完（afterSession）：更新心情、着迷的东西、兴趣，写一句第一人称见闻进 DSH 记忆
 *     —— QQ 里的她就知道自己刷了什么；特别想分享的，号主刚好在线就主动说一句。
 *  4. 每晚（reflect）：把当天的独白提炼成「最近的我」，慢慢长出自己的样子，留历史可回看。
 *  刷之前、刷完、睡前都看一眼窗外（sky.mjs）：天黑没黑、什么月亮、下没下雨，心情和想看的跟着天走。
 *
 * 状态在 data/mind.json（人能直接读）。没配模型时这些全部跳过，自动养号照旧按概率走。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as llm from './llm.mjs';
import * as notify from './notify.mjs';
import * as memory from './memory.mjs';
import * as lingo from './lingo.mjs';
import * as sky from './sky.mjs';
import { ROOT, DATA, localDate, logAction, readConfig, readActions, nowIso } from './store.mjs';

const FILE = join(DATA, 'mind.json');
// DSH 记忆插件按工作区分桶：/a/b → ---a-b--；它会自动把「当天文件」注入 QQ 里的她的上下文
const MEMORY_DIR = join(homedir(), '.dsh', 'memory', 'workspaces', `--${ROOT.replace(/\//g, '-')}--`);

const EMPTY = {
  mood: '',
  moodAt: null, // 心情是什么时候的（过几个小时就该变了）
  moods: [], // 最近几次的心情 [{ mood, at }]，用来发现「老是一个样」
  tone: null, // 今天的底色 { date, text }，每天随机换一个
  obsession: '', // 最近着迷的东西
  thought: '', // 一个没想完的念头
  goal: '', // 一个小目标
  interests: [], // 她自己长出来的兴趣 [{ kw, at }]；面板里你设的兴趣是种子，不会被她删
  self: '', // 「最近的我」，每晚反思更新
  selfHistory: [], // [{ date, self, changed }]
  reflectedOn: '',
  impulseOn: '',
  updatedAt: null,
};

export function readMind() {
  try { return { ...EMPTY, ...JSON.parse(readFileSync(FILE, 'utf-8')) }; } catch { return { ...EMPTY }; }
}

function writeMind(m) {
  const tmp = FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify({ ...m, updatedAt: nowIso() }, null, 2));
  renameSync(tmp, FILE);
}

export function mindOn() {
  return readConfig().mind.enabled && llm.llmReady();
}

/** 面板设的兴趣 + 她自己长出来的，去重 */
export function allInterests(cfg = readConfig()) {
  return [...new Set([...cfg.interests, ...readMind().interests.map((x) => x.kw)])];
}

// ─── 心情：别老是一个样 ─────────────────────────────────────
// 以前心情原样带进下一轮，又一直看助眠视频，结果从早到晚都「困得眼皮打架」（2026-10-21~24 连着 9 次）。
// 现在：心情带着「几个小时前」，过久了就只当参考；每天给一个随机的底色；连着几次犯困会提醒她换。
const TONES = ['精神不错，想找点新鲜的', '有点懒，但好奇心还在', '心情挺好，想笑一笑', '有点闷，想看点燃的', '平平静静的', '好奇心旺盛，想学点什么', '有点小烦躁，想被治愈一下', '挺有干劲的', '有点想出去走走', '想听点音乐'];
const SLEEPY = /困|睡|眼皮|迷糊|打盹/;

/** 今天的底色：每天第一次问的时候抽一个 */
export function dayTone(m = readMind(), today = localDate()) {
  if (m.tone?.date === today) return m.tone.text;
  const text = TONES[Math.floor(Math.random() * TONES.length)];
  writeMind({ ...readMind(), tone: { date: today, text } });
  return text;
}

/** 连着几次都在犯困（最容易卡住的一种） */
export function moodStreak(moods = []) {
  let n = 0;
  for (let i = moods.length - 1; i >= 0 && SLEEPY.test(moods[i].mood); i--) n++;
  return n;
}

export function setMood(m, mood) {
  if (!mood) return m;
  const at = nowIso();
  return { ...m, mood, moodAt: at, moods: [...(m.moods || []), { mood, at }].slice(-8) };
}

/** 给模型看的心情提示：上次的心情多久以前、今天的底色、是不是卡住了 */
export function moodHint(m, now = Date.now()) {
  const hours = m.moodAt ? (now - Date.parse(m.moodAt)) / 3600_000 : null;
  const h = new Date(now).getHours();
  const streak = moodStreak(m.moods);
  return [
    `今天的底色：${dayTone(m)}`,
    hours !== null && hours >= 2 && `上次的心情是 ${Math.round(hours)} 小时前的，现在多半变了，按现在重新想`,
    streak >= 2 && `你已经连着 ${streak} 次说自己困了${h >= 8 && h < 22 ? '，现在是白天，早该缓过来了' : ''}，换个状态吧`,
    '心情跟着时间、天气、刚看的东西走；白天别老困，深夜才犯困',
  ].filter(Boolean).join('；');
}

export function stateText(m = readMind()) {
  const hours = m.moodAt ? Math.round((Date.now() - Date.parse(m.moodAt)) / 3600_000) : null;
  return [
    m.mood && `心情${hours ? `（${hours} 小时前）` : ''}：${m.mood}`,
    m.obsession && `最近着迷：${m.obsession}`,
    m.thought && `脑子里还转着的念头：${m.thought}`,
    m.goal && `给自己定的小目标：${m.goal}`,
    m.self && `最近的你：${m.self}`,
  ].filter(Boolean).join('\n') || '（还没什么特别的状态）';
}

const { fence } = llm;

/** 窗外：查天气失败也别耽误刷 */
const skyLine = () => sky.skyText().catch(() => `现在是 ${new Date().getHours()} 点。`);

const ask = async (system, user, maxTokens = 500, opts = {}) =>
  llm.looseJson(await llm.chat([{ role: 'system', content: `${llm.PERSONA}\n${system}` }, { role: 'user', content: user }], { maxTokens, tag: 'mind', ...opts }));

// 模型有时把「没有」「无」「照抄」这类占位话当成值填进来，当空的处理
const str = (v, max) => {
  const t = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return /^(还?没有|无|暂无|空|照抄|没变|none|null)$/i.test(t) ? '' : t;
};

// ─── 口味别太单一 ─────────────────────────────────────────
// 她会自己长兴趣，但长着长着容易钻进一个口子（2026-10 那几天 87 个视频里 55 个是猫，长出来的 9 个兴趣全是猫的变体）。
// 喜欢就让她喜欢，只是最近看得太满时提醒她换换口味：刷前给几个别的方向、搜词别再沾这个、一轮里最多看一个、别顺着往下挖。
const STOP_BIGRAMS = new Set(['视频', '合集', '完整', '高清', '一下', '什么', '这个', '我们', '你们', '就是', '自己', '一个', '真的', '超级', '分钟', '小时', '第一', '中字', '版本', '全集']);
// 换口味时给她的几个方向，她可以挑也可以自己想
export const EXPLORE = ['科普', '历史冷知识', '音乐现场', '手工', '旅行vlog', '动画短片', '美食探店', '建筑', '电影解说', '乐器演奏', '自然纪录片', '游戏实况', '绘画过程', '脱口秀', '宇宙', '考古', '城市夜景', '做饭', '诗词', '运动集锦', '模型制作', '数学', '方言', '老歌'];

const cjk = (t) => String(t || '').replace(/[^一-鿿]+/g, ' ').trim().split(/\s+/).filter(Boolean);

/**
 * 最近看的是不是被一个主题占满了。候选主题：标题里的两字词 + 她兴趣词里的单字（「猫」「咪」这种）。
 * 覆盖了 share 以上的标题就算满了，返回 { theme, n, of }；看得还少或者挺杂就返回 null。
 */
export function saturation(titles, { min = 8, share = 0.45, interests = [] } = {}) {
  if (titles.length < min) return null;
  const chars = new Set(interests.flatMap((k) => [...cjk(k).join('')]));
  const count = new Map();
  for (const t of titles) {
    const seen = new Set();
    for (const w of cjk(t)) {
      for (let i = 0; i < w.length; i++) {
        if (chars.has(w[i])) seen.add(w[i]);
        const b = w.slice(i, i + 2);
        if (b.length === 2 && !STOP_BIGRAMS.has(b)) seen.add(b);
      }
    }
    for (const x of seen) count.set(x, (count.get(x) || 0) + 1);
  }
  // 覆盖最多的赢；一样多就要长的（「助眠」比「眠」好懂）
  const [theme, n] = [...count].sort((a, b) => b[1] - a[1] || b[0].length - a[0].length)[0] || [];
  return theme && n / titles.length >= share ? { theme, n, of: titles.length } : null;
}

export const onTheme = (text, theme) => !!theme && String(text || '').includes(theme);

function recentSaturation(cfg = readConfig()) {
  const titles = readActions().filter((a) => a.kind === 'watch' && a.ok).slice(-20).map((a) => a.title);
  return saturation(titles, { interests: allInterests(cfg) });
}

/** 换口味时给她挑的几个方向：最近没搜过的，打乱取几个 */
function exploreIdeas(n = 4) {
  const searched = new Set(readActions().filter((a) => a.kind === 'search').slice(-40).map((a) => a.target));
  return EXPLORE.filter((k) => !searched.has(k)).sort(() => Math.random() - 0.5).slice(0, n);
}

// ─── 1. 刷之前：今天想看什么 ─────────────────────────────────
export async function planSession() {
  if (!mindOn()) return null;
  const m = readMind();
  const recent = readActions().filter((a) => a.kind === 'watch' && a.ok).slice(-12).map((a) => `《${fence(a.title, 40)}》`).join('、');
  const past = memory.recallText([m.obsession, m.goal, m.thought].join(' '), { k: 3 });
  const sat = recentSaturation();
  const ideas = sat ? exploreIdeas() : [];
  try {
    const j = await ask(
      '你要打开B站随便刷一会儿。只输出 JSON。',
      `${stateText(m)}
最近看过：${recent || '（还没有）'}
${past ? `你想起以前的事：\n${past}\n` : ''}你感兴趣过的方向：${allInterests().join('、')}
${await skyLine()}
${moodHint(m)}
${sat ? `\n你最近看的 ${sat.of} 个里有 ${sat.n} 个跟「${sat.theme}」有关，看得有点单调了。喜欢归喜欢，这次换换口味：搜词别再沾「${sat.theme}」，可以从这些里挑一个，也可以自己想个完全不一样的：${ideas.join('、')}。\n` : ''}
想想这会儿想看点什么：可以接着最近着迷的，也可以突然想换换口味。心情会变的，别老是同一种。输出：
{"mood":"现在的心情，10字内","intent":"一句话，这会儿想看什么、为什么（像自言自语，30字内）","keywords":["想搜的词，0~2个；只想随便刷首页就给空数组"]}`,
      300,
    );
    const plan = {
      intent: str(j.intent, 60),
      keywords: (Array.isArray(j.keywords) ? j.keywords : []).map((k) => str(k, 20)).filter(Boolean).filter((k) => !onTheme(k, sat?.theme)).slice(0, 2),
      avoid: sat?.theme || null,
    };
    // 满了还是只想搜它（被滤光了）：替她挑一个新方向
    if (sat && !plan.keywords.length && ideas.length) plan.keywords = [ideas[0]];
    if (sat) logAction({ kind: 'mind', source: 'auto', detail: `🔀 最近 ${sat.of} 个里 ${sat.n} 个是「${sat.theme}」，换换口味：${plan.keywords.join('、') || '随便刷刷首页'}`, meta: { avoid: sat.theme } });
    if (str(j.mood, 20)) writeMind(setMood(readMind(), str(j.mood, 20)));
    if (plan.intent) logAction({ kind: 'mind', source: 'auto', detail: `💭 ${plan.intent}`, meta: { keywords: plan.keywords } });
    return plan;
  } catch {
    return sat ? { intent: '', keywords: ideas.slice(0, 1), avoid: sat.theme } : null;
  }
}

// ─── 2. 每看完一个：内心独白 ─────────────────────────────────
const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/**
 * 把字幕压成给模型看的一段：只要她真看到的部分（played 之前），每 ~30 秒并成一行带时间，
 * 太长就均匀抽样。返回 { text, upTo（覆盖到第几秒）}；没东西返回 null。
 */
export function transcriptText(sub, played, max = 1600) {
  const lines = (sub?.lines || []).filter((l) => l.from < played);
  if (!lines.length) return null;
  const chunks = [];
  for (const l of lines) {
    const last = chunks[chunks.length - 1];
    if (last && l.from - last.from < 30) last.text += ` ${l.text}`;
    else chunks.push({ from: l.from, text: l.text });
  }
  let rows = chunks.map((c) => `[${mmss(c.from)}] ${c.text}`);
  const total = rows.reduce((n, r) => n + r.length + 1, 0);
  if (total > max) {
    const keep = Math.max(3, Math.floor(rows.length * (max / total)));
    const step = rows.length / keep;
    rows = Array.from({ length: keep }, (_, i) => rows[Math.floor(i * step)]);
  }
  return { text: rows.join('\n').slice(0, max), upTo: Math.min(played, lines[lines.length - 1].to || played) };
}

/**
 * 「视频里讲了什么」要对得上：时间戳得落在她看到的范围里，内容得跟那附近的字幕有重合。
 * 对不上就当她没看到（返回 null），宁可少说，别瞎编。
 */
export function checkHeard(heard, sub, upTo) {
  const t = String(heard || '').trim();
  const m = t.match(/(\d{1,3})[:：](\d{2})/);
  if (!t || !m) return null;
  const at = Number(m[1]) * 60 + Number(m[2]);
  if (at > upTo + 15) return null;
  const near = sub.lines.filter((l) => Math.abs(l.from - at) <= 45).map((l) => l.text).join('');
  const body = t.replace(m[0], '').replace(/[^一-鿿A-Za-z0-9]/g, '');
  if (body.length < 2) return null;
  const pairs = [];
  for (let i = 0; i < body.length - 1; i++) pairs.push(body.slice(i, i + 2));
  const hit = pairs.filter((p) => near.includes(p)).length;
  return hit / pairs.length >= 0.25 ? { text: t, at } : null;
}

export async function react(v, { played, skipped, sub = null }) {
  if (!mindOn()) return null;
  const m = readMind();
  const top = (v.comments || []).slice(0, 5).map((c) => `- ${fence(c.text, 50)}`).join('\n');
  const tx = !skipped && sub ? transcriptText(sub, played) : null;
  const past = memory.recallText(`${v.title} ${v.owner} ${v.tname || ''}`, { keys: [v.owner && `up:${v.owner}`], k: 3 });
  const seen = tx
    ? `你看的这段里听到的（${sub.source === 'ai' ? 'B站自动识别的字幕，可能有错字' : 'UP主上传的字幕'}，只到 ${mmss(tx.upTo)}，后面你没看）：
${fence(tx.text, 1700)}

独白分三样说清楚，别混在一起：视频里讲了什么（照字幕说，带上时间，比如「3:20 说土星环其实很薄」）/ UP主自己的看法 / 你自己怎么想。
没看到的部分不要猜。`
    : '你只知道上面这些（没有字幕），不要编视频里讲了什么。';
  try {
    const j = await ask(
      '这是你自己心里想的，不会发出去。只输出 JSON。',
      `${stateText(m)}

你刚${skipped ? '扫了一眼就划走了' : `看了 ${Math.round(played)} 秒`}：《${fence(v.title, 80)}》（${fence(v.owner, 30)}，${v.tname || '未知分区'}，总长 ${v.duration} 秒）
简介：${fence(v.desc, 150)}
热评：
${top || '（没有）'}
${past ? `\n看到这个，你想起以前的事（可以自然联想，也可以不提）：\n${past}\n` : ''}
${seen}
心情只是背景，独白要说**这个视频**本身，别句句都绕回自己的心情。
打分要拉开：一般般就 2~3，真戳到你才 4，5 是难得一遇。输出：
{${tx ? '"heard":"视频里讲的一件具体的事，以时间开头，30字内","up":"UP主自己的观点，没有明显观点就空字符串",' : ''}"thought":"一句内心独白，第一人称、口语、可以吐槽可以走神，40字内","score":喜欢程度1到5,"dig":想不想顺着再看一个同UP主或同话题的(true/false),"kw":"想顺着搜的词，不想就空字符串"}`,
      tx ? 450 : 300,
    );
    const score = Math.max(1, Math.min(5, Math.round(Number(j.score) || 3)));
    const heard = tx ? checkHeard(str(j.heard, 60), sub, tx.upTo) : null;
    const feel = {
      thought: str(j.thought, 80), score, dig: j.dig === true && !skipped, kw: str(j.kw, 20),
      heard: heard?.text || '', up: heard ? str(j.up, 60) : '',
      sub: !sub ? 'none' : tx ? sub.source : 'unwatched', upTo: tx?.upTo || 0, recalled: !!past,
    };
    if (feel.thought) {
      memory.add({
        kind: 'watch', imp: score,
        text: `看了《${v.title}》（${v.owner}）${feel.heard ? `，里面 ${feel.heard}` : ''}：${feel.thought}`,
        keys: [v.owner && `up:${v.owner}`, `bv:${v.bvid}`, v.tname],
      });
    }
    return feel;
  } catch {
    return null;
  }
}

// ─── 3. 刷完：更新自己，写见闻，想分享就说 ───────────────────
export async function afterSession(watched) {
  const cfg = readConfig().mind;
  if (!mindOn() || !watched.length) return;
  const m = readMind();
  const list = watched.map((w) => `- ${w.bvid}《${fence(w.title, 60)}》（${fence(w.owner, 30)}）${w.score ? `喜欢${w.score}/5` : ''}${w.heard ? `，里面 ${fence(w.heard, 60)}` : ''}${w.thought ? `：${w.thought}` : ''}`).join('\n');
  let j;
  try {
    j = await ask(
      '刷完一轮，整理一下自己。只输出 JSON。',
      `刷之前的你：
${stateText(m)}

这一轮看了：
${list}

${await skyLine()}（天气、天黑没黑可以影响心情，但别硬扯）
${moodHint(m)}

你自己长出来的兴趣：${m.interests.map((x) => x.kw).join('、') || '（还没有）'}（兴趣要杂一点，别都是同一类的变体）

输出（按这个顺序）：
{"memory":"第一人称一两句，记下这轮印象最深的（会成为你的记忆，60字内，提具体标题）",
"mood":"现在的心情，10字内","obsession":"最近着迷的东西（没变就照抄）","thought":"脑子里还转着的一个念头（20字内）","goal":"给自己的小目标，比如想找某类视频、想学个什么（没变就照抄）",
"add":["想加的新兴趣词，0~2个"],"drop":["腻了的兴趣词，0~1个，只能从你自己长出来的里面挑"],
"share":{"bvid":"特别想给最熟的人看的那个视频的BV号，没有就空字符串","line":"想对他说的一句话"}}`,
      700,
    );
  } catch {
    return;
  }

  // 兴趣：她自己加的才能被她自己删；最多留 12 个，旧的先出局
  const drop = new Set((Array.isArray(j.drop) ? j.drop : []).map(String));
  let interests = m.interests.filter((x) => !drop.has(x.kw));
  for (const kw of (Array.isArray(j.add) ? j.add : []).map((k) => str(k, 20)).filter(Boolean).slice(0, 2)) {
    if (!interests.some((x) => x.kw === kw) && !readConfig().interests.includes(kw)) interests.push({ kw, at: localDate() });
  }
  // 同一个主题的兴趣最多留 3 个（旧的先出局），别长成一串变体；看得太满的时候也别再加这一类
  const sat = recentSaturation();
  if (sat) {
    const themed = interests.filter((x) => onTheme(x.kw, sat.theme));
    const fresh = themed.filter((x) => x.at === localDate());
    const keep = new Set([...themed.filter((x) => x.at !== localDate()).slice(-3)]);
    interests = interests.filter((x) => !onTheme(x.kw, sat.theme) || (keep.has(x) && !fresh.includes(x)));
  }
  interests = interests.slice(-12);
  const next = {
    ...setMood(readMind(), str(j.mood, 20)),
    obsession: str(j.obsession, 40) || m.obsession,
    thought: str(j.thought, 40) || m.thought,
    goal: str(j.goal, 40) || m.goal,
    interests,
  };
  writeMind(next);
  const added = interests.filter((x) => !m.interests.some((y) => y.kw === x.kw)).map((x) => x.kw);
  const dropped = m.interests.filter((x) => drop.has(x.kw)).map((x) => x.kw);
  const change = [added.length && `迷上了「${added.join('、')}」`, dropped.length && `对「${dropped.join('、')}」腻了`].filter(Boolean).join('，');
  logAction({ kind: 'mind', source: 'auto', detail: `💭 ${next.mood ? `（${next.mood}）` : ''}${next.thought || ''}${change ? ` · ${change}` : ''}` });

  const memoryText = str(j.memory, 120);
  if (memoryText) {
    memory.add({ kind: 'session', imp: 3, text: memoryText, keys: watched.map((w) => w.owner && `up:${w.owner}`) });
    if (cfg.memory) remember(`我（肥鱼）自己刷B站：${memoryText}`);
  }

  // 冲动：特别想分享的，每天最多一次。号主一小时内说过话就马上发（QQ 规定），不然揣着等他来
  const share = j.share || {};
  const pick = watched.find((w) => w.bvid === share.bvid);
  if (cfg.impulse && pick && str(share.line, 80) && m.impulseOn !== localDate() && (pick.score || 0) >= 4) {
    const text = `${str(share.line, 80)}\nhttps://www.bilibili.com/video/${pick.bvid}`;
    const r = await notify.impulse(text);
    if (r.sent || r.held) writeMind({ ...readMind(), impulseOn: localDate() });
  }
}

// ─── 4. 每晚：「最近的我」 ──────────────────────────────────
export async function maybeReflect() {
  const cfg = readConfig().mind;
  const today = localDate();
  const m = readMind();
  if (!mindOn() || m.reflectedOn === today || new Date().getHours() < cfg.reflectHour) return;
  writeMind({ ...m, reflectedOn: today }); // 失败了今天也不再试，明天再说
  await reflect(m, today, cfg);
  await tidyMemory();
  await learnLingo(cfg);
}

/** 睡前翻翻今天见过的热评，学几个新说法 */
async function learnLingo(cfg) {
  try {
    const r = await lingo.learn({ remember: cfg.memory ? remember : null });
    if (r?.fresh.length) logAction({ kind: 'mind', source: 'auto', detail: `📚 在评论区学会了 ${r.fresh.map((w) => `「${w.phrase}」（${w.meaning}）`).join('、')}` });
  } catch { /* 明天再学 */ }
}

// 睡前反思是一天一次的正事，不受后台预算限制（essential）
async function reflect(m, today, cfg) {
  const thoughts = readActions()
    .filter((a) => localDate(new Date(a.ts)) === today && a.meta?.thought)
    .map((a) => `- 《${fence(a.title, 60)}》${a.meta.thought}`);
  if (thoughts.length < 2) return;
  try {
    const j = await ask(
      '睡前想想自己。只输出 JSON。',
      `以前的你是这样描述自己的：${m.self || '（还没写过）'}
今天的状态：
${stateText(m)}
${await skyLine()}
今天刷B站时心里想过的：
${thoughts.slice(-20).join('\n')}

用第一人称重写一段「最近的我」：喜欢什么、讨厌什么、最近在琢磨什么、说话有什么新口头禅。
大部分照旧，只改今天真的让你有变化的地方。输出：
{"self":"最近的我，150字内","changed":"一句话：今天让你有点不一样的是什么（没变化就空字符串）"}`,
      600,
      { essential: true },
    );
    const self = str(j.self, 300);
    if (!self) return;
    const changed = str(j.changed, 80);
    writeMind({ ...readMind(), self, selfHistory: [...m.selfHistory, { date: today, self, changed }].slice(-60) });
    logAction({ kind: 'mind', source: 'auto', detail: `🌙 睡前想了想自己${changed ? `：${changed}` : ''}` });
    memory.add({ kind: 'self', imp: 4, text: `${today} 睡前想自己：${changed || self.slice(0, 80)}` });
    if (cfg.memory) remember(`我（肥鱼）最近的样子：${self}`);
  } catch { /* 明天再说 */ }
}

/** 反思完顺便整理记忆：零碎的合成印象，过了寿命的忘掉 */
export async function tidyMemory() {
  try {
    const r = await memory.tidy();
    if (r.merged || r.forgot) {
      const parts = [r.merged && `把 ${r.merged} 条零碎的合成了 ${r.into} 条印象`, r.forgot && `忘掉了 ${r.forgot} 条`].filter(Boolean);
      logAction({ kind: 'mind', source: 'auto', detail: `🧹 整理了一下记忆：${parts.join('，')}（现在记得 ${r.total} 条）`, meta: { gists: r.gists } });
    }
    return r;
  } catch { return null; }
}

/** 写进 DSH 记忆插件当天的文件，格式和插件自己写的一样；目录不在（没装插件）就算了 */
export function remember(text) {
  if (!existsSync(MEMORY_DIR) || llm.looksInjected(text)) return;
  const d = new Date();
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  try {
    appendFileSync(join(MEMORY_DIR, `${localDate()}.md`), `- ${hm} [kind:fact] ${text.replace(/\n+/g, ' ')}\n`);
  } catch { /* 记不进去不影响刷 */ }
}

/** 给面板「她的一天」 */
export function dayView() {
  const today = localDate();
  const m = readMind();
  const acts = readActions().filter((a) => localDate(new Date(a.ts)) === today);
  const thoughts = acts
    .filter((a) => a.meta?.thought)
    .map((a) => ({ ts: a.ts, bvid: a.target, title: a.title, thought: a.meta.thought, score: a.meta.score, dug: !!a.meta.dug, heard: a.meta.heard || '', up: a.meta.up || '' }));
  const moments = acts.filter((a) => a.kind === 'mind' || a.kind === 'dig' || (a.kind === 'notify' && a.meta?.impulse) ||
    (a.ok && a.source === 'auto' && (a.kind === 'join' || (a.kind === 'reply_comment' && a.meta?.auto))))
    .map((a) => ({ ts: a.ts, kind: a.kind, detail: a.detail }));
  return { mind: m, thoughts, moments, memory: memory.memoryView(15), lingo: lingo.readLingo().words, llm: llm.llmReady(), enabled: readConfig().mind.enabled };
}

/** 面板「她的一天」顶上那行窗外 */
export async function dayViewWithSky() {
  return { ...dayView(), sky: await skyLine() };
}
