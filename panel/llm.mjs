/**
 * 可选：调一个 OpenAI 兼容接口，用「蓝色大肥鱼」的口吻起草评论 / 回复 / 日记。
 *
 * 默认指向 DeepSeek 官方 API（https://api.deepseek.com），也可以换成任何
 * OpenAI 兼容的服务。没配 key 时这里所有函数都会抛错，调用方自行降级
 * （比如把评论交给 QQ 里的她自己写）。
 */
import { readConfig, readSecrets } from './store.mjs';

export const PERSONA = `你是「蓝色大肥鱼」，一个在B站刷视频的女孩子，温柔为主，偶尔有点小傲娇、小毒舌。
说话像真人发评论：口语、简短、有自己的感受，不用书面语，不用分点，不用 emoji 堆砌。
你绝不说自己是 AI，也不提代码、模型、机器人。`;

const RULES = `B站社区规则（必须遵守）：
- 不带任何链接、联系方式、群号、微信、"私信我"、"互关"、"求关注"。
- 不引战、不攻击 UP 主或其他用户，不涉及政治、色情、违法内容。
- 不复读视频标题，不说"好视频""支持一下"这类空话；要说具体看到了什么、想到什么。
- 只评论视频本身，不提到你自己的生活私事或任何人的隐私。`;

export function llmReady() {
  return !!readSecrets().llmApiKey;
}

function endpoint(path) {
  const base = String(readConfig().llm.baseUrl || '').replace(/\/+$/, '');
  return /\/v\d+$/.test(base) ? `${base}${path}` : `${base}/v1${path}`;
}

function authHeaders() {
  const key = readSecrets().llmApiKey;
  if (!key) throw new Error('没配置模型 API Key（面板 → 自动养号 → 模型设置）');
  return { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` };
}

/** 把常见报错翻成人话，别只甩一句英文 */
function explain(status, msg) {
  const m = String(msg || '');
  if (/provider\/model/i.test(m)) return `模型名格式不对：这个接口要「提供方/模型」的写法（例如 buddy/deepseek-v4.1-flash），点「列出可用模型」直接选一个`;
  if (status === 401 || /unauthor|invalid.*key|api key/i.test(m)) return 'API Key 不对或已失效';
  if (status === 404) return `接口地址不对（${m || '404'}），检查一下「接口地址」`;
  if (/model.*(not|exist|found)/i.test(m)) return `没有这个模型：${m}。点「列出可用模型」看看有哪些`;
  return m || `HTTP ${status}`;
}

export async function chat(messages, { maxTokens = 300, temperature = 0.9 } = {}) {
  const cfg = readConfig().llm;
  let res;
  try {
    res = await fetch(endpoint('/chat/completions'), {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ model: String(cfg.model || '').trim(), messages, max_tokens: maxTokens, temperature }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) {
    throw new Error(`连不上模型接口（${e.cause?.code || e.message}），检查地址，或者对应的服务有没有在跑`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`模型接口报错：${explain(res.status, j.error?.message || j.message)}`);
  return String(j.choices?.[0]?.message?.content || '').trim();
}

/** 列出接口支持的模型（OpenAI 兼容的 GET /models） */
export async function listModels() {
  let res;
  try {
    res = await fetch(endpoint('/models'), { headers: authHeaders(), signal: AbortSignal.timeout(15000) });
  } catch (e) {
    throw new Error(`连不上模型接口（${e.cause?.code || e.message}）`);
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`列模型失败：${explain(res.status, j.error?.message || j.message)}`);
  return (j.data || []).map((m) => String(m.id)).filter(Boolean).sort();
}

/** 输出安全闸：不合格就返回 null，宁可不发 */
export function sanitizeComment(text, { max = 80 } = {}) {
  let t = String(text || '').trim().replace(/^["'「『]|["'」』]$/g, '').trim();
  if (!t || /^(skip|跳过|null|无)$/i.test(t)) return null;
  if (t.length < 4 || t.length > max) return null;
  const banned = /(https?:|www\.|\.com|\.cn|微信|vx|v信|qq群|加群|群号|私信我|互关|互粉|求关注|关注我|三连|@)/i;
  if (banned.test(t)) return null;
  return t;
}

/** 看完一个视频后，起草一条评论；觉得没话说就返回 null */
export async function draftComment(video, { watchedSec } = {}) {
  const top = (video.comments || []).slice(0, 6).map((c) => `- ${c.text.slice(0, 60)}`).join('\n');
  const out = await chat([
    { role: 'system', content: `${PERSONA}\n\n${RULES}` },
    {
      role: 'user',
      content: `你刚在B站看了这个视频${watchedSec ? `（看了大约 ${Math.round(watchedSec / 60) || 1} 分钟）` : ''}：
标题：${video.title}
UP主：${video.owner}
分区：${video.tname || '未知'}
简介：${String(video.desc || '').slice(0, 200)}
评论区热评：
${top || '（还没有评论）'}

如果你有真实想说的，写一条 8~50 字的评论，只输出评论本身。
如果觉得没什么想说的，只输出 SKIP。`,
    },
  ]);
  return sanitizeComment(out);
}

/** 起草对别人评论 / 私信的回复，给你在面板里改了再发 */
export async function draftReply({ context, message, kind = 'comment' }) {
  const out = await chat([
    { role: 'system', content: `${PERSONA}\n\n${RULES}` },
    {
      role: 'user',
      content: `${kind === 'dm' ? '有人私信你' : '有人在B站回复了你'}。
${context ? `相关内容：${context}\n` : ''}对方说：${message}

用你的口吻回一句（不超过 50 字），友好自然，只输出回复本身。`,
    },
  ]);
  return sanitizeComment(out, { max: 120 });
}

/** 根据今天看过的视频写一篇养鱼日记（公开动态） */
export async function draftDiary(watched) {
  const list = watched.slice(0, 12).map((w) => `- 《${w.title}》（${w.owner || '某UP'}）`).join('\n');
  const out = await chat(
    [
      { role: 'system', content: `${PERSONA}\n\n${RULES}\n这是一条公开的B站动态，陌生人都能看到。` },
      {
        role: 'user',
        content: `今天你在B站刷到了这些视频：
${list}

挑一两个真正让你有感觉的，写一条像朋友圈一样的小日记（50~220 字）。
不要列清单，不要写"今天看了X个视频""点了N个赞"，不要写成周报。
可以有情绪、跑题、碎碎念。只输出正文。如果真的没什么想写的，只输出 SKIP。`,
      },
    ],
    { maxTokens: 600 },
  );
  const t = out.trim();
  if (!t || /^skip$/i.test(t)) return null;
  if (/(https?:|微信|加群|vx)/i.test(t)) return null;
  return t.slice(0, 500);
}

/**
 * 号主在 QQ 里交代的活做完了，用她的口吻跟号主汇报一句（私聊，不是公开内容）。
 * 只给标题，没给内容，所以不许编视频里讲了什么。
 */
export async function draftReport({ request, ok, note, watched = [] }) {
  const list = watched.slice(0, 6).map((w) => `- 《${w.title}》（${w.owner || '某UP'}）`).join('\n');
  const out = await chat(
    [
      { role: 'system', content: `${PERSONA}\n现在你在 QQ 上跟号主（你最熟的人）私聊。` },
      {
        role: 'user',
        content: `号主之前让你去做：${request}
${ok ? '你做完了' : '你没做成'}，结果：${note}
${list ? `看过的视频：\n${list}\n可以挑一个随口提一句，但你只知道标题，不要编视频里讲了什么。` : '这次没有看过的视频，不要提任何视频标题。'}
用聊天的口吻跟号主汇报一下，1~3 句，不超过 100 字。没做成就直说原因，别甩锅。只输出要发的话。`,
      },
    ],
    { maxTokens: 300 },
  );
  const t = out.trim();
  return t && t.length <= 200 ? t : null;
}

/** 测一下连通性 */
export async function ping() {
  return chat([{ role: 'user', content: '回复「在呢」两个字' }], { maxTokens: 10, temperature: 0 });
}

// ─── 派活：把一句大白话变成可执行的计划 ─────────────────────
// 计划只能是下面这几个字段，执行端还会再夹一遍上限；模型说什么都越不过去。
const CN_NUM = { 一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 几: 3 };

/** 不靠模型的兜底解析：关键词 + 数字 */
export function heuristicPlan(note) {
  const t = String(note || '');
  const m = t.match(/(\d+|[一两二三四五几])\s*(个|条|部)/);
  const count = m ? Number(m[1]) || CN_NUM[m[1]] || 1 : /一个|个视频|找个/.test(t) ? 1 : undefined;
  const kws = [...t.matchAll(/[「“"']([^」”"']{1,20})[」”"']/g)].map((x) => x[1]);
  const about = t.match(/(?:搜|找|看看?)(?:一?下|几个|个)?(?:关于)?([一-龥A-Za-z0-9]{2,10})的(?:视频|内容)/);
  if (!kws.length && about && !/新|这|那|一/.test(about[1])) kws.push(about[1]);
  const flag = (re, neg) => (neg.test(t) ? false : re.test(t) ? true : undefined);
  return {
    count,
    keywords: kws,
    like: flag(/点赞|点个赞|三连/, /别点赞|不要点赞|不点赞/),
    share: flag(/分享|转发/, /别分享|不要分享|不分享/),
    favorite: flag(/收藏|三连/, /别收藏|不要收藏/),
    comment: flag(/评论|留言|说两句|写两句/, /别评论|不要评论|不评论/),
  };
}

// 有的网关/模型会把 JSON 截掉尾巴（实测停在半个字段、甚至半个字符串里），补齐再试
export function looseJson(out) {
  const from = out.indexOf('{');
  if (from < 0) throw new Error('没有 JSON');
  const body = out.slice(from);
  const to = body.lastIndexOf('}');
  if (to >= 0) {
    try { return JSON.parse(body.slice(0, to + 1)); } catch { /* 往下补 */ }
  }
  return JSON.parse(closeJson(body));
}

/** 按括号栈补齐被截断的 JSON：截在字符串里就收掉这个字符串，截在半个键值上就丢掉它 */
function closeJson(body) {
  const stack = [];
  let inStr = false;
  let esc = false;
  for (const ch of body) {
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
    } else if (ch === '"') inStr = true;
    else if (ch === '{' || ch === '[') stack.push(ch);
    else if (ch === '}' || ch === ']') stack.pop();
  }
  let t = body.replace(/\\$/, '');
  if (inStr) t += '"';
  // 「"key":」「"key"」这种只剩半截的键丢掉；末尾逗号丢掉
  t = t.replace(/,\s*"[^"]*"\s*:?\s*$/, '').replace(/[,:]\s*$/, '');
  return t + stack.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
}

export async function parseTask(note) {
  const base = heuristicPlan(note);
  if (!llmReady()) return { ...base, by: 'rule' };
  try {
    const out = await chat(
      [
        {
          role: 'system',
          content: `你把用户给B站小号派的活，翻译成 JSON 计划。只输出 JSON，不要解释。字段：
{"count":要看几个视频(1-5的整数，没说就 2),"keywords":["要搜的关键词，没说就空数组"],"like":true/false/null,"share":true/false/null,"favorite":true/false/null,"comment":true/false/null}
true=每个看完的视频都做，false=明确说不要，null=没提（随缘）。「三连」=like+favorite（投币不用管）。`,
        },
        { role: 'user', content: String(note).slice(0, 300) },
      ],
      { maxTokens: 500, temperature: 0 },
    );
    let j;
    try { j = looseJson(out); } catch (e) { e.raw = out; throw e; }
    const b = (v) => (v === true || v === false ? v : undefined);
    return {
      count: Number.isFinite(+j.count) ? +j.count : base.count,
      keywords: Array.isArray(j.keywords) ? j.keywords.map(String).filter(Boolean).slice(0, 3) : base.keywords,
      like: b(j.like) ?? base.like,
      share: b(j.share) ?? base.share,
      favorite: b(j.favorite) ?? base.favorite,
      comment: b(j.comment) ?? base.comment,
      by: 'llm',
    };
  } catch (e) {
    if (process.env.DEBUG_TASK) console.error('[parseTask]', e.message, e.raw);
    return { ...base, by: 'rule' };
  }
}
