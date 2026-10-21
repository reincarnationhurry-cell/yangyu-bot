/**
 * 她的内心（mind）
 *
 * 自动养号原本全是写死的概率：35% 点赞、12% 评论、兴趣关键词固定。这里给她一点「内在状态」，
 * 让刷 B站 这件事由她自己的心思带着走，活动记录里才会出现意料之外的东西：
 *
 *  1. 刷之前（planSession）：看看自己的心情、最近着迷的东西，决定今天想搜什么。
 *  2. 每看完一个（react）：留一句内心独白，打个喜欢程度，想不想顺着往下挖。
 *     喜欢程度会影响点赞 / 评论；想挖就顺着 UP 主或关键词再看一个（autopilot 里做）。
 *  3. 刷完（afterSession）：更新心情、着迷的东西、兴趣，写一句第一人称见闻进 DSH 记忆
 *     —— QQ 里的她就知道自己刷了什么；特别想分享的，号主刚好在线就主动说一句。
 *  4. 每晚（reflect）：把当天的独白提炼成「最近的我」，慢慢长出自己的样子，留历史可回看。
 *
 * 状态在 data/mind.json（人能直接读）。没配模型时这些全部跳过，自动养号照旧按概率走。
 */
import { readFileSync, writeFileSync, renameSync, existsSync, appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import * as llm from './llm.mjs';
import * as notify from './notify.mjs';
import { ROOT, DATA, localDate, logAction, readConfig, readActions, nowIso } from './store.mjs';

const FILE = join(DATA, 'mind.json');
// DSH 记忆插件按工作区分桶：/a/b → ---a-b--；它会自动把「当天文件」注入 QQ 里的她的上下文
const MEMORY_DIR = join(homedir(), '.dsh', 'memory', 'workspaces', `--${ROOT.replace(/\//g, '-')}--`);

const EMPTY = {
  mood: '',
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

function stateText(m) {
  return [
    m.mood && `心情：${m.mood}`,
    m.obsession && `最近着迷：${m.obsession}`,
    m.thought && `脑子里还转着的念头：${m.thought}`,
    m.goal && `给自己定的小目标：${m.goal}`,
    m.self && `最近的你：${m.self}`,
  ].filter(Boolean).join('\n') || '（还没什么特别的状态）';
}

const ask = async (system, user, maxTokens = 500) =>
  llm.looseJson(await llm.chat([{ role: 'system', content: `${llm.PERSONA}\n${system}` }, { role: 'user', content: user }], { maxTokens }));

// 模型有时把「没有」「无」「照抄」这类占位话当成值填进来，当空的处理
const str = (v, max) => {
  const t = typeof v === 'string' ? v.trim().slice(0, max) : '';
  return /^(还?没有|无|暂无|空|照抄|没变|none|null)$/i.test(t) ? '' : t;
};

// ─── 1. 刷之前：今天想看什么 ─────────────────────────────────
export async function planSession() {
  if (!mindOn()) return null;
  const m = readMind();
  const recent = readActions().filter((a) => a.kind === 'watch' && a.ok).slice(-12).map((a) => `《${a.title}》`).join('、');
  try {
    const j = await ask(
      '你要打开B站随便刷一会儿。只输出 JSON。',
      `${stateText(m)}
最近看过：${recent || '（还没有）'}
你感兴趣过的方向：${allInterests().join('、')}
现在是 ${new Date().getHours()} 点。

想想这会儿想看点什么：可以接着最近着迷的，也可以突然想换换口味。输出：
{"mood":"现在的心情，10字内","intent":"一句话，这会儿想看什么、为什么（像自言自语，30字内）","keywords":["想搜的词，0~2个；只想随便刷首页就给空数组"]}`,
      300,
    );
    const plan = {
      intent: str(j.intent, 60),
      keywords: (Array.isArray(j.keywords) ? j.keywords : []).map((k) => str(k, 20)).filter(Boolean).slice(0, 2),
    };
    if (j.mood) writeMind({ ...readMind(), mood: str(j.mood, 20) });
    if (plan.intent) logAction({ kind: 'mind', source: 'auto', detail: `💭 ${plan.intent}`, meta: { keywords: plan.keywords } });
    return plan;
  } catch {
    return null;
  }
}

// ─── 2. 每看完一个：内心独白 ─────────────────────────────────
export async function react(v, { played, skipped }) {
  if (!mindOn()) return null;
  const m = readMind();
  const top = (v.comments || []).slice(0, 5).map((c) => `- ${c.text.slice(0, 50)}`).join('\n');
  try {
    const j = await ask(
      '这是你自己心里想的，不会发出去。只输出 JSON。',
      `${stateText(m)}

你刚${skipped ? '扫了一眼就划走了' : `看了 ${Math.round(played)} 秒`}：《${v.title}》（${v.owner}，${v.tname || '未知分区'}，总长 ${v.duration} 秒）
简介：${String(v.desc || '').slice(0, 150)}
热评：
${top || '（没有）'}

你只知道上面这些，不要编视频里讲了什么。心情只是背景，独白要说**这个视频**本身（标题、UP主、热评里的东西），别句句都绕回自己的心情。
打分要拉开：一般般就 2~3，真戳到你才 4，5 是难得一遇。输出：
{"thought":"一句内心独白，第一人称、口语、可以吐槽可以走神，40字内","score":喜欢程度1到5,"dig":想不想顺着再看一个同UP主或同话题的(true/false),"kw":"想顺着搜的词，不想就空字符串"}`,
      300,
    );
    const score = Math.max(1, Math.min(5, Math.round(Number(j.score) || 3)));
    return { thought: str(j.thought, 80), score, dig: j.dig === true && !skipped, kw: str(j.kw, 20) };
  } catch {
    return null;
  }
}

// ─── 3. 刷完：更新自己，写见闻，想分享就说 ───────────────────
export async function afterSession(watched) {
  const cfg = readConfig().mind;
  if (!mindOn() || !watched.length) return;
  const m = readMind();
  const list = watched.map((w) => `- ${w.bvid}《${w.title}》（${w.owner}）${w.score ? `喜欢${w.score}/5` : ''}${w.thought ? `：${w.thought}` : ''}`).join('\n');
  let j;
  try {
    j = await ask(
      '刷完一轮，整理一下自己。只输出 JSON。',
      `刷之前的你：
${stateText(m)}

这一轮看了：
${list}

你自己长出来的兴趣：${m.interests.map((x) => x.kw).join('、') || '（还没有）'}

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
  interests = interests.slice(-12);
  const next = {
    ...readMind(),
    mood: str(j.mood, 20) || m.mood,
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

  const memory = str(j.memory, 120);
  if (cfg.memory && memory) remember(`我（肥鱼）自己刷B站：${memory}`);

  // 冲动：特别想分享的，号主一小时内说过话才发（QQ 规定），每天最多一次
  const share = j.share || {};
  const pick = watched.find((w) => w.bvid === share.bvid);
  if (cfg.impulse && pick && str(share.line, 80) && m.impulseOn !== localDate() && (pick.score || 0) >= 4) {
    const text = `${str(share.line, 80)}\nhttps://www.bilibili.com/video/${pick.bvid}`;
    const r = await notify.impulse(text);
    if (r.sent) writeMind({ ...readMind(), impulseOn: localDate() });
  }
}

// ─── 4. 每晚：「最近的我」 ──────────────────────────────────
export async function maybeReflect() {
  const cfg = readConfig().mind;
  const today = localDate();
  const m = readMind();
  if (!mindOn() || m.reflectedOn === today || new Date().getHours() < cfg.reflectHour) return;
  const thoughts = readActions()
    .filter((a) => localDate(new Date(a.ts)) === today && a.meta?.thought)
    .map((a) => `- 《${a.title}》${a.meta.thought}`);
  writeMind({ ...m, reflectedOn: today }); // 失败了今天也不再试，明天再说
  if (thoughts.length < 2) return;
  try {
    const j = await ask(
      '睡前想想自己。只输出 JSON。',
      `以前的你是这样描述自己的：${m.self || '（还没写过）'}
今天的状态：
${stateText(m)}
今天刷B站时心里想过的：
${thoughts.slice(-20).join('\n')}

用第一人称重写一段「最近的我」：喜欢什么、讨厌什么、最近在琢磨什么、说话有什么新口头禅。
大部分照旧，只改今天真的让你有变化的地方。输出：
{"self":"最近的我，150字内","changed":"一句话：今天让你有点不一样的是什么（没变化就空字符串）"}`,
      600,
    );
    const self = str(j.self, 300);
    if (!self) return;
    const changed = str(j.changed, 80);
    writeMind({ ...readMind(), self, selfHistory: [...m.selfHistory, { date: today, self, changed }].slice(-60) });
    logAction({ kind: 'mind', source: 'auto', detail: `🌙 睡前想了想自己${changed ? `：${changed}` : ''}` });
    if (cfg.memory) remember(`我（肥鱼）最近的样子：${self}`);
  } catch { /* 明天再说 */ }
}

/** 写进 DSH 记忆插件当天的文件，格式和插件自己写的一样；目录不在（没装插件）就算了 */
function remember(text) {
  if (!existsSync(MEMORY_DIR)) return;
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
    .map((a) => ({ ts: a.ts, bvid: a.target, title: a.title, thought: a.meta.thought, score: a.meta.score, dug: !!a.meta.dug }));
  const moments = acts.filter((a) => a.kind === 'mind' || a.kind === 'dig' || (a.kind === 'notify' && a.meta?.impulse))
    .map((a) => ({ ts: a.ts, kind: a.kind, detail: a.detail }));
  return { mind: m, thoughts, moments, llm: llm.llmReady(), enabled: readConfig().mind.enabled };
}
