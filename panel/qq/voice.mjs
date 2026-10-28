/**
 * 她的嗓子和耳朵
 *
 * 说：先找本机的 GPT-SoVITS（~/GPT-SoVITS 的 api_v2.py，照着 panel/data/voice/ 里那段参考音频的声音说）；
 *     没开、没放参考音频、出错，就用 edge-tts（微软的神经网络音色，免费、不用密钥，要联网）；
 *     再不行退回 macOS 自带的 say，声音差点但总能发出去。
 * 听：mlx-whisper（本机 Apple 芯片上跑 whisper-large-v3-turbo，不联网）。没装就听不了，消息里还是 [语音]。
 *
 * edge-tts、mlx-whisper 是号主自己用 uv 装的命令行（uv tool install edge-tts / mlx-whisper），面板只调用：
 * launchd 起的面板 PATH 里没有 ~/.local/bin，所以这里自己去找。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ROOT } from '../store.mjs';

const run = promisify(execFile);

/** 音色：名字给她选，值是 edge-tts 的音色 */
export const VOICES = { Xiaoyi: 'zh-CN-XiaoyiNeural', Xiaoxiao: 'zh-CN-XiaoxiaoNeural' };
export const DEFAULT_VOICE = 'Xiaoyi';
const SAY_VOICE = 'Meijia';
const ASR_MODEL = 'mlx-community/whisper-large-v3-turbo';
const GSV_URL = 'http://127.0.0.1:9880/tts';
// 参考音频（3~10 秒、一个人、没背景音）和它一字不差的原文。号主的素材，不进 git
const REF_DIR = join(ROOT, 'panel/data/voice');
const REF_WAV = join(REF_DIR, 'ref.wav');
const REF_TXT = join(REF_DIR, 'ref.txt');

function bin(name) {
  for (const dir of [join(homedir(), '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin']) {
    if (existsSync(join(dir, name))) return join(dir, name);
  }
  return null;
}

const tmp = (fn) => {
  const dir = mkdtempSync(join(tmpdir(), 'yy-voice-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
};

// ─── 说 ────────────────────────────────────────────────────
/** GPT-SoVITS：照参考音频的声音说，返回 wav；没开 / 没参考音频返回 null。头一次要预热，二三十秒 */
async function gptSovits(text, timeoutMs = 45000) {
  if (!existsSync(REF_WAV) || !existsSync(REF_TXT)) return null;
  const r = await fetch(GSV_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text, text_lang: 'zh', ref_audio_path: REF_WAV, prompt_text: readFileSync(REF_TXT, 'utf-8').trim(), prompt_lang: 'zh',
      media_type: 'wav', text_split_method: 'cut5',
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!r.ok) throw new Error(`GPT-SoVITS ${r.status} ${(await r.text()).slice(0, 200)}`);
  return Buffer.from(await r.arrayBuffer());
}

/** 文字 → mp3 的 base64（OneBot record 段直接发） */
export async function voiceB64(text, voice = DEFAULT_VOICE) {
  let wav = null;
  try { wav = await gptSovits(text); } catch (e) { console.error('[voice] GPT-SoVITS 没成，用 edge-tts', e.message); }
  return tmp((dir) => {
    const out = join(dir, 'v.mp3');
    if (wav) {
      writeFileSync(join(dir, 'v.wav'), wav);
      execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, 'v.wav'), '-ar', '24000', '-ac', '1', '-b:a', '64k', out], { timeout: 30000 });
      return readFileSync(out).toString('base64');
    }
    const edge = bin('edge-tts');
    if (edge) {
      try {
        execFileSync(edge, ['--voice', VOICES[voice] || VOICES[DEFAULT_VOICE], '--text', text, '--write-media', out], { timeout: 20000, stdio: 'ignore' });
        return readFileSync(out).toString('base64');
      } catch (e) { console.error('[voice] edge-tts 没成，用 say', e.message); }
    }
    execFileSync('/usr/bin/say', ['-v', SAY_VOICE, '-o', join(dir, 'v.aiff'), text], { timeout: 30000 });
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, 'v.aiff'), '-ar', '24000', '-ac', '1', '-b:a', '64k', out], { timeout: 30000 });
    return readFileSync(out).toString('base64');
  });
}

/** GPT-SoVITS 刚起来时第一句要预热二三十秒：面板起来后先替她说一句，号主要语音时就不用干等 */
export async function warmUp() {
  if (!existsSync(REF_WAV) || !existsSync(REF_TXT)) return false;
  for (let i = 0; i < 10; i++) {
    try { if (await gptSovits('嗯。', 120000)) return true; } catch {}
    await new Promise((res) => setTimeout(res, 30000)); // 它可能比面板起得晚
  }
  return false;
}

/**
 * 一句回复能不能直接念出来：太长（念不完 30 秒）、带链接 / 代码 / 好多数字的不念，返回 null；
 * 能念就去掉颜文字、qwq 这类，返回要念的话
 */
export function speakable(text) {
  const t = String(text || '').trim();
  if (!t || t.length > 80 || /https?:\/\/|www\.|`|BV[0-9A-Za-z]{10}|\d{4,}/.test(t)) return null;
  const said = t
    .replace(/\([^()（）]{0,12}\)|（[^()（）]{0,12}）/g, (m) => (/[\u4e00-\u9fa5]{2,}/.test(m) ? m : '')) // 颜文字；括号里是正经话的留着
    .replace(/\b(qwq|QAQ|x_x|orz|awa|hhh+)\b/gi, '')
    .replace(/[^\u4e00-\u9fa5A-Za-z0-9，。！？、…~～,.!?\s]/g, '')
    .replace(/\s+/g, ' ').trim();
  return /[\u4e00-\u9fa5]/.test(said) ? said : null;
}

/** mp3 → Telegram 语音条要的 ogg opus */
export function toOgg(mp3) {
  return tmp((dir) => {
    writeFileSync(join(dir, 'v.mp3'), mp3);
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', join(dir, 'v.mp3'), '-ac', '1', '-c:a', 'libopus', '-b:a', '32k', join(dir, 'v.ogg')], { timeout: 30000 });
    return readFileSync(join(dir, 'v.ogg'));
  });
}

// ─── 听 ────────────────────────────────────────────────────
export const canHear = () => !!bin('mlx_whisper');

/** 一段音频（QQ 给的 mp3、Telegram 的 ogg 都行，ffmpeg 自己认）→ 听写出来的文字；听不了 / 没听清返回 '' */
export async function transcribe(mp3, ext = 'mp3') {
  const whisper = bin('mlx_whisper');
  if (!whisper) return '';
  const dir = mkdtempSync(join(tmpdir(), 'yy-hear-'));
  try {
    writeFileSync(join(dir, `a.${ext}`), mp3);
    // 模型下过了就别再去 Hugging Face 问一遍
    const cached = existsSync(join(homedir(), '.cache/huggingface/hub', `models--${ASR_MODEL.replace('/', '--')}`));
    await run(whisper, [
      join(dir, `a.${ext}`), '--model', ASR_MODEL, '--language', 'zh', '--initial-prompt', '以下是普通话的句子。',
      '--output-format', 'txt', '--output-dir', dir, '--verbose', 'False',
    ], {
      timeout: 60000,
      env: { ...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}`, ...(cached ? { HF_HUB_OFFLINE: '1' } : {}) },
    });
    return readFileSync(join(dir, 'a.txt'), 'utf-8').replace(/\s+/g, ' ').trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
