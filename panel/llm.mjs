/**
 * 可选：调一个 OpenAI 兼容接口，用「蓝色大肥鱼」的口吻起草评论 / 回复 / 日记。
 *
 * 默认指向 DeepSeek 官方 API（https://api.deepseek.com），也可以换成任何
 * OpenAI 兼容的服务。没配 key 时这里所有函数都会抛错，调用方自行降级
 * （比如把评论交给 QQ 里的她自己写）。
 */
import { readConfig, readSecrets } from './store.mjs';

const PERSONA = `你是「蓝色大肥鱼」，一个在B站刷视频的女孩子，温柔为主，偶尔有点小傲娇、小毒舌。
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

async function chat(messages, { maxTokens = 300, temperature = 0.9 } = {}) {
  const cfg = readConfig().llm;
  const key = readSecrets().llmApiKey;
  if (!key) throw new Error('没配置模型 API Key（面板 → 自动养号 → 模型设置）');
  const base = String(cfg.baseUrl || '').replace(/\/+$/, '');
  const url = /\/v\d+$/.test(base) ? `${base}/chat/completions` : `${base}/v1/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({ model: cfg.model, messages, max_tokens: maxTokens, temperature }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`模型接口报错：${j.error?.message || res.status}`);
  return String(j.choices?.[0]?.message?.content || '').trim();
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

/** 测一下连通性 */
export async function ping() {
  return chat([{ role: 'user', content: '回复「在呢」两个字' }], { maxTokens: 10, temperature: 0 });
}
