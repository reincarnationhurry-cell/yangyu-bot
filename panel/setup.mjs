/**
 * 「上手」：第一次打开面板时的检查单
 *
 * 一项一项看：Node 版本、模型、她是谁、聊天线路、B站 号、浏览器（贴吧 / 抖音要）、Docker（QQ 小号要）、语音。
 * 每项给出 ok / 缺什么 / 去哪儿配。只读，不改任何东西；查不到的（网络、docker 卡住）算没好，不抛错。
 */
import * as llm from './llm.mjs';
import * as bili from './bili.mjs';
import * as web from './web.mjs';
import { isBundled } from './chrome.mjs';
import * as webvisit from './webvisit.mjs';
import * as voice from './qq/voice.mjs';
import * as napcat from './qq/napcat.mjs';
import * as qq from './qq/index.mjs';
import { readConfig, who, DEFAULT_CONFIG } from './store.mjs';

const soft = (p, ms = 8000) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('超时')), ms))]);

export async function checks() {
  const cfg = readConfig();
  const out = [];
  const add = (id, name, ok, detail, fix = '', go = '', optional = false) => out.push({ id, name, ok: !!ok, detail, fix, go, optional });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', 'Node.js', major >= 18, `v${process.versions.node}`, '装 Node.js 18 或更新的版本');

  add('llm', '模型（她的脑子）', llm.llmReady(), llm.llmReady() ? `${cfg.llm.active || cfg.llm.model}（${cfg.llm.baseUrl}）` : '还没填 API Key',
    '「自动养号」页最下面「模型」那一节：选 DeepSeek，填 API Key', 'autopilot');

  const me = who();
  const renamed = JSON.stringify(me) !== JSON.stringify(DEFAULT_CONFIG.persona);
  add('persona', '她是谁', renamed, `${me.nick}（${me.short}）${renamed ? '' : '，用的是默认人设'}`,
    '想换个人设：「自动养号」页「她是谁」改名字，项目根目录 AGENTS.md 改性格', 'autopilot', true);

  const st = qq.status();
  const line = { official: 'QQ 官方机器人（经 DSH）', onebot: 'QQ 小号（NapCat）', telegram: 'Telegram' }[st.mode] || st.mode;
  add('chat', '聊天线路', st.mode === 'official' || st.connected,
    st.mode === 'official' ? `${line}；面板右下角的聊天框随时能用` : `${line}${st.connected ? ' 已连上' : ' 没连上'}`,
    st.mode === 'official' ? '' : '「自动养号」页「QQ 连接」那一节，按提示扫码 / 填 token', 'autopilot');

  if (st.mode === 'onebot') {
    const nap = await soft(napcat.status()).catch(() => ({ docker: false }));
    add('docker', 'Docker（跑 QQ 小号）', nap.docker && nap.running, !nap.docker ? '没装 docker' : nap.running ? '小号容器在跑' : '小号容器没在跑',
      !nap.docker ? '装 OrbStack（macOS）或 Docker Desktop / Docker Engine' : '「QQ 连接」里点「切成小号」会自己拉起容器', 'autopilot');
  }

  const acc = await soft(bili.getAccountStatus()).catch(() => null);
  add('bili', 'B站 账号', acc?.loggedIn, acc?.loggedIn ? `${acc.uname}（Lv${acc.level ?? '?'}）` : '没登录（或者查不到）',
    '「总览」页点「扫码登录」，用专门给她的那个号扫', 'overview');

  const browser = web.browserPath();
  const sharesChrome = process.platform === 'darwin' && browser && !isBundled(browser) && !process.env.WEB_BROWSER;
  add('browser', '浏览器（逛贴吧 / 刷抖音）', browser, !browser ? '没找到 Chrome / Edge / Chromium'
    : sharesChrome ? `${browser}（和你的 Chrome 是同一个 app，她在后台跑时你的 Chrome 可能打不开；跑 node panel/install-chrome.mjs 给她单独装一份）` : browser,
    '跑 node panel/install-chrome.mjs，或者装一个 Chrome，或者用环境变量 WEB_BROWSER 指定路径', 'web', true);
  if (browser) {
    const ls = await soft(webvisit.loginState(), 20000).catch(() => null);
    const names = ls ? ['tieba', 'douyin'].filter((k) => ls[k]?.ok).map((k) => ({ tieba: '贴吧', douyin: '抖音' })[k]) : [];
    add('weblogin', '贴吧 / 抖音 登录', names.length === 2, names.length ? `已登录：${names.join('、')}` : '都没登录', '「逛逛」页扫码登录', 'web', true);
  }

  const v = voice.canSpeak();
  const speak = v.edge || (v.say && v.ffmpeg);
  add('voice', '语音', speak, [v.edge && 'edge-tts', v.ffmpeg && 'ffmpeg', v.say && 'say'].filter(Boolean).join('、') || '都没有',
    '装 ffmpeg 和 edge-tts（pipx install edge-tts）；没有也行，语音会改成打字', '', true);
  add('hear', '听语音', voice.canHear(), voice.canHear() ? 'mlx_whisper' : '没装听写（她收到语音会说没听清）',
    'Apple 芯片的 Mac：pipx install mlx-whisper', '', true);

  const need = out.filter((c) => !c.optional && !c.ok).length;
  return { list: out, ready: need === 0, need };
}
