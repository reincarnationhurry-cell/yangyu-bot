/**
 * QQ 接入体检（health）
 *
 * QQ 里的她靠 DSH 桌面版 + 别人写的 dsh-im-connect 插件接进来。插件在 package.json 里把能跑的宿主版本
 * 一个个写死（peerDependencies），DSH 一自动升级、插件还没跟上，宿主就不加载它 —— 设置里「IM 助理」消失，
 * QQ 网关不启动，号主那边只看到她不回了（2026-10-24 就这么掉过一次）。
 *
 * 这里每 5 分钟看一眼，查两件事：
 *  1. 版本对不对得上：DSH.app 的版本在不在插件声明支持的列表里；
 *  2. 网关活没活：DSH 在跑的话，它这次启动之后 gateway.log 里有没有「网关就绪」。
 * 出问题就在面板顶上挂红条，并弹一条 macOS 通知（同一个问题只弹一次）—— QQ 断了，没法在 QQ 里告诉你。
 */
import { readFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { logAction } from './store.mjs';

const HOME = homedir();
const APP = process.env.DSH_APP || '/Applications/DeepSeek Harness.app';
const PLUGIN = join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', '@michengai', 'dsh-im-connect', 'package.json');
const GATEWAY_LOG = join(HOME, '.dsh', 'dsh-im-connect', 'gateway.log');
const HOST_PEER = '@deepseek-ai/dsh-agent';

const sh = (cmd, args) => { try { return execFileSync(cmd, args, { encoding: 'utf-8', timeout: 5000 }).trim(); } catch { return ''; } };

export function hostVersion(app = APP) {
  return sh('/usr/bin/plutil', ['-extract', 'CFBundleShortVersionString', 'raw', join(app, 'Contents', 'Info.plist')]) || null;
}

/** 插件版本 + 它说自己支持哪些宿主版本（"a || b || c" 这种写死的列表；写成 ^x 这类范围就不判断） */
export function pluginInfo(file = PLUGIN) {
  try {
    const j = JSON.parse(readFileSync(file, 'utf-8'));
    const range = String(j.peerDependencies?.[HOST_PEER] || '');
    const list = range.split('||').map((x) => x.trim()).filter(Boolean);
    return { version: j.version, range, exact: list.length > 0 && list.every((x) => /^\d+\.\d+\.\d+(-[\w.]+)?$/.test(x)) ? list : null };
  } catch { return null; }
}

/** DSH 主进程什么时候启动的（没在跑返回 null） */
export function hostStartedAt(app = APP) {
  const pid = sh('/usr/bin/pgrep', ['-xf', `${join(app, 'Contents', 'MacOS')}/.*`]).split('\n')[0]
    || sh('/usr/bin/pgrep', ['-x', 'DeepSeek Harness']).split('\n')[0];
  if (!pid) return null;
  const t = Date.parse(sh('/bin/ps', ['-o', 'lstart=', '-p', pid]));
  return Number.isFinite(t) ? t : null;
}

/** gateway.log 里最后一次「网关就绪」的时间 */
export function lastGatewayReady(log = GATEWAY_LOG) {
  try {
    const st = statSync(log);
    const fd = readFileSync(log, 'utf-8');
    const tail = fd.slice(-60_000).split('\n').reverse();
    const hit = tail.find((l) => l.includes('网关就绪'));
    return { ready: hit ? Date.parse(hit.slice(0, 24)) : null, touched: st.mtimeMs };
  } catch { return { ready: null, touched: null }; }
}

/**
 * 诊断。纯函数，输入都能从外面喂（测试用）。
 * 返回 { ok, problems: [{ code, text, fix }] }
 */
export function diagnose({ host, plugin, startedAt, gateway, now = Date.now() }) {
  const problems = [];
  if (!plugin) {
    problems.push({ code: 'no-plugin', text: '没找到 dsh-im-connect 插件，QQ 接不进来', fix: '在 DSH 插件市场装上 dsh-im-connect' });
  } else if (host && plugin.exact && !plugin.exact.includes(host)) {
    problems.push({
      code: 'version',
      text: `DSH 已经是 ${host}，但 dsh-im-connect ${plugin.version} 只支持到 ${plugin.exact[plugin.exact.length - 1]}，宿主不会加载它`,
      fix: 'DSH 插件市场把 dsh-im-connect 升到最新 → Cmd+Q 完全退出 DSH 再打开；还没出新版就先别升 DSH',
    });
  }
  // DSH 起来 3 分钟了，这次启动之后还没有「网关就绪」
  if (startedAt && now - startedAt > 3 * 60_000 && !(gateway?.ready >= startedAt - 60_000)) {
    problems.push({ code: 'gateway', text: 'DSH 开着，但 QQ 网关这次没起来，她收不到 QQ 消息', fix: '打开 DSH 设置 →「IM 助理」看 QQ 渠道状态；页面不见了多半是插件版本跟不上' });
  }
  return { ok: !problems.length, problems, host, plugin: plugin ? { version: plugin.version } : null, dshRunning: !!startedAt };
}

let last = { ok: true, problems: [], checkedAt: 0 };
const notified = new Set();

/** 现查一次（顺手记录、弹通知） */
export function check({ notify = true } = {}) {
  if (!existsSync(APP)) return (last = { ok: true, problems: [], skipped: '没装 DSH 桌面版', checkedAt: Date.now() });
  const r = diagnose({ host: hostVersion(), plugin: pluginInfo(), startedAt: hostStartedAt(), gateway: lastGatewayReady() });
  for (const p of r.problems) {
    if (notified.has(p.code)) continue;
    notified.add(p.code);
    logAction({ kind: 'health', source: 'auto', ok: false, detail: `QQ 接入出问题了：${p.text}`, error: p.fix });
    if (notify && process.platform === 'darwin') {
      const esc = (s) => s.replace(/["\\]/g, '');
      sh('/usr/bin/osascript', ['-e', `display notification "${esc(p.fix)}" with title "🐟 肥鱼的 QQ 断了" subtitle "${esc(p.text.slice(0, 60))}"`]);
    }
  }
  // 好了就把「已通知」清掉，下次再坏还会提醒
  for (const code of [...notified]) if (!r.problems.some((p) => p.code === code)) notified.delete(code);
  if (!last.ok && r.ok) logAction({ kind: 'health', source: 'auto', detail: 'QQ 接入恢复了' });
  last = { ...r, checkedAt: Date.now() };
  return last;
}

/** 给面板：5 分钟内查过就用上次的 */
export function status() {
  return Date.now() - last.checkedAt < 5 * 60_000 ? last : check();
}
