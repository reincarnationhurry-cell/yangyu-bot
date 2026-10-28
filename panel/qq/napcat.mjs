/**
 * NapCat 容器（Docker 版 QQ 小号）：起停、状态、登录二维码、日志。
 *
 * 面板「自动养号 → QQ 连接」切线路时用它：
 *   切到小号 → docker compose up -d 把容器拉起来（小号登在里面的 QQ 里），再要一张二维码给你扫
 *   切回官方 → docker compose down 停掉它。不停的话它每 2 分钟重登一次、次次失败，
 *              对账号更糟（2026-10-28 实测：连着重登一天，QQ 安全中心把号标成「身份验证信息已失效、部分功能受限」）。
 *
 * Docker 和镜像都是号主自己装、自己拉的，这里只调 docker compose，不替号主下载安装。
 * docker 在 /usr/local/bin（OrbStack 的软链），launchd 那条窄 PATH 里有它。
 * 只读、只起停自己这一个容器，不碰别的容器。
 */
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logAction } from '../store.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DIR = join(HERE, 'napcat');
export const WEBUI = 'http://127.0.0.1:6099/webui';
const DOCKER = process.env.DOCKER_BIN || '/usr/local/bin/docker';
const CONTAINER = 'napcat';
const QR_IN_CONTAINER = '/app/napcat/cache/qrcode.png';
const QR_HOST = join(DIR, 'data', 'cache', 'qrcode.png'); // 以后要是把 cache 挂出来，就直接读这个
export const QR_TTL_MS = 3 * 60_000; // NapCat 大约每 2 分钟换一张

export const dockerInstalled = () => existsSync(DOCKER);

function run(args, { timeoutMs = 120_000, cwd = DIR } = {}) {
  return new Promise((resolve) => {
    execFile(DOCKER, args, { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: String(stdout || ''), err: String(stderr || err?.message || '') });
    });
  });
}

/** 把命令输出收成一行能塞进报错的短句 */
const tail = (s) => String(s || '').trim().split('\n').map((x) => x.trim()).filter(Boolean).slice(-3).join(' / ');

/** `docker ps --format` 的一行（名字 \t 状态 \t 详情）→ 对象。给测试用的纯函数 */
export function parsePs(line) {
  const parts = String(line || '').trim().split('\t');
  if (!parts[0]) return null;
  const state = parts[1] || '';
  return { name: parts[0], state, running: state === 'running', detail: parts[2] || '' };
}

/** 容器现在什么样：没装 docker / 没建过 / 跑着 / 停着 */
export async function status() {
  const st = { docker: dockerInstalled(), exists: false, running: false, state: '', detail: '' };
  if (!st.docker) return st;
  const r = await run(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{.Names}}\t{{.State}}\t{{.Status}}'], { timeoutMs: 20000 });
  const info = parsePs(r.out.trim().split('\n')[0]);
  if (info) Object.assign(st, { exists: true, running: info.running, state: info.state, detail: info.detail });
  return st;
}

/** 拉起小号容器（第一次会拉镜像，慢一点正常） */
export async function up() {
  if (!dockerInstalled()) throw new Error('没找到 docker 命令：先装 OrbStack（https://orbstack.dev）或 Docker Desktop，打开一次再来');
  if (!existsSync(join(DIR, 'docker-compose.yml'))) throw new Error(`没找到 ${join(DIR, 'docker-compose.yml')}`);
  const before = await status();
  if (before.running) return { ok: true, already: true };
  const r = await run(['compose', 'up', '-d'], { timeoutMs: 300_000 });
  if (!r.ok) throw new Error(`小号容器没起来：${tail(r.err) || tail(r.out)}`);
  logAction({ kind: 'qq', source: 'auto', detail: `拉起了小号（NapCat 容器）${before.exists ? '' : '，第一次要拉镜像，慢一点正常'}` });
  return { ok: true, already: false };
}

/** 停掉小号容器。切回官方就停，免得它在后台反复重登 */
export async function down() {
  if (!dockerInstalled()) return { ok: true, skipped: true };
  const before = await status();
  if (!before.exists) return { ok: true, skipped: true };
  const r = await run(['compose', 'down'], { timeoutMs: 120_000 });
  if (!r.ok) throw new Error(`小号容器没停成：${tail(r.err) || tail(r.out)}`);
  logAction({ kind: 'qq', source: 'auto', detail: '停掉了小号（NapCat 容器）：官方线路用不着它，留着它会在后台反复重登' });
  return { ok: true };
}

/** 重启容器换一张新二维码（停着就先拉起来） */
export async function restart() {
  if (!dockerInstalled()) throw new Error('没找到 docker 命令');
  const before = await status();
  if (!before.running) return up();
  const r = await run(['compose', 'restart'], { timeoutMs: 120_000 });
  if (!r.ok) throw new Error(`重启失败：${tail(r.err) || tail(r.out)}`);
  logAction({ kind: 'qq', source: 'auto', detail: '重启了小号容器，重新要一张登录二维码' });
  return { ok: true };
}

/**
 * 登录二维码：NapCat 把码存进容器里的 /app/napcat/cache/qrcode.png，用 docker cp 掏出来。
 * 装在容器里的 Linux 版 QQ 没在等登录（已经登进去了）时没有这个文件，返回 null。
 * 返回 { dataUrl, at, ageMs, bytes }。
 */
export async function qr() {
  if (!dockerInstalled()) return null;
  let buf = null;
  let at = 0;
  if (existsSync(QR_HOST)) {
    try { buf = readFileSync(QR_HOST); at = statSync(QR_HOST).mtimeMs; } catch { buf = null; }
  }
  if (!buf?.length) {
    const box = join(tmpdir(), 'yangyu-qr');
    mkdirSync(box, { recursive: true });
    const tmp = join(box, 'qrcode.png');
    const r = await run(['cp', `${CONTAINER}:${QR_IN_CONTAINER}`, tmp], { timeoutMs: 20000 });
    if (r.ok) { try { buf = readFileSync(tmp); at = statSync(tmp).mtimeMs; } catch { buf = null; } }
  }
  if (!buf?.length) return null;
  return { dataUrl: `data:image/png;base64,${buf.toString('base64')}`, at, bytes: buf.length };
}

/** 容器日志（大多写在 stderr 上，两路合一起） */
export async function logs(limit = 120) {
  if (!dockerInstalled()) return '';
  const n = Math.min(Math.max(Number(limit) || 120, 10), 500);
  const st = await status();
  if (!st.exists) return '';
  const r = await run(['logs', '--tail', String(n), CONTAINER], { timeoutMs: 30000 });
  return [r.out, r.err].filter(Boolean).join('\n').trim();
}

/**
 * 容器里的 QQ 是不是在反复登录失败。
 *
 * NapCat 登不进去时会一直重试：每 2 分钟打一行 `[Core] [Login] Login Error, ErrType: 1 ErrCode: 3`，
 * 再重存一张二维码。2026-10-28 就是这么挂了一整天，账号被风控得更狠。
 * 「连续失败」= 近期日志里有多次 Login Error，且后面没有登录成功的迹象（扫码成功会有登录成功的行）。
 *
 * 纯函数部分单独拆出来（parseLoginLog）好测。
 */
export function parseLoginLog(text) {
  const lines = String(text || '').split('\n');
  let lastError = -1;
  let lastOk = -1;
  let errors = 0;
  lines.forEach((l, i) => {
    if (!/\[Login\]|登录/.test(l)) return;
    if (/Login Error/i.test(l) || /登录失败|Error.*ErrCode/.test(l)) { lastError = i; errors++; }
    if (/登录成功|Login Success|已登录|online/i.test(l)) lastOk = i;
  });
  return { errors, failing: errors >= 3 && lastError > lastOk };
}

export async function loginFailing(limit = 80) {
  const st = await status();
  if (!st.running) return { failing: false, errors: 0, running: false };
  const text = await logs(limit).catch(() => '');
  return { ...parseLoginLog(text), running: true };
}

/** 连续失败够久就把容器停掉：停掉才是不继续伤号的做法 */
export async function stopIfLoginStuck({ strikes = 6 } = {}) {
  const h = await loginFailing();
  if (!h.failing) return { stopped: false, strikes: 0 };
  const n = (stopIfLoginStuck.n || 0) + 1;
  if (n < strikes) { stopIfLoginStuck.n = n; return { stopped: false, strikes: n, errors: h.errors }; }
  stopIfLoginStuck.n = 0;
  await down().catch(() => {});
  logAction({ kind: 'qq', source: 'auto', ok: false, detail: `小号登不进去（连续 ${strikes} 次检查都失败，最近日志里有 ${h.errors} 次 Login Error），先停掉容器，免得一直重登把号弄得更糟` });
  return { stopped: true, strikes: n, errors: h.errors };
}
