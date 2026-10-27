/**
 * 她的嗓子和耳朵
 *
 * 说：edge-tts（微软的神经网络音色，免费、不用密钥，要联网）。连不上就退回 macOS 自带的 say，声音差点但总能发出去。
 * 听：mlx-whisper（本机 Apple 芯片上跑 whisper-large-v3-turbo，不联网）。没装就听不了，消息里还是 [语音]。
 *
 * 两个都是号主自己用 uv 装的命令行（uv tool install edge-tts / mlx-whisper），面板只调用：
 * launchd 起的面板 PATH 里没有 ~/.local/bin，所以这里自己去找。
 */
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);

/** 音色：名字给她选，值是 edge-tts 的音色 */
export const VOICES = { Xiaoyi: 'zh-CN-XiaoyiNeural', Xiaoxiao: 'zh-CN-XiaoxiaoNeural' };
export const DEFAULT_VOICE = 'Xiaoyi';
const SAY_VOICE = 'Meijia';
const ASR_MODEL = 'mlx-community/whisper-large-v3-turbo';

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
/** 文字 → mp3 的 base64（OneBot record 段直接发） */
export function voiceB64(text, voice = DEFAULT_VOICE) {
  return tmp((dir) => {
    const out = join(dir, 'v.mp3');
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

// ─── 听 ────────────────────────────────────────────────────
export const canHear = () => !!bin('mlx_whisper');

/** mp3 → 听写出来的文字；听不了 / 没听清返回 '' */
export async function transcribe(mp3) {
  const whisper = bin('mlx_whisper');
  if (!whisper) return '';
  const dir = mkdtempSync(join(tmpdir(), 'yy-hear-'));
  try {
    writeFileSync(join(dir, 'a.mp3'), mp3);
    // 模型下过了就别再去 Hugging Face 问一遍
    const cached = existsSync(join(homedir(), '.cache/huggingface/hub', `models--${ASR_MODEL.replace('/', '--')}`));
    await run(whisper, [
      join(dir, 'a.mp3'), '--model', ASR_MODEL, '--language', 'zh', '--initial-prompt', '以下是普通话的句子。',
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
