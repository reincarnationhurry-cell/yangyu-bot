/**
 * dsh-yangyu-panel —— 宿主半侧（Cordis 插件）
 *
 * 把本工作区里的「养鱼面板」（panel/panel.mjs，默认 127.0.0.1:8899）接成 DSH 的一个
 * 左栏入口所需的**宿主能力**，职责只有三件事：
 *
 * 1. 注册前缀路由 `/yangyu-panel`，提供 status / start / stop（全部返回 JSON）。
 * 2. 保证「DSH 在跑 → 面板在跑」：插件加载时按 config.autoStart 懒启动面板，
 *    之后由看门狗（config.watchdogSecs）周期探活，掉线即自动拉起。
 * 3. 生命周期收尾：只回收**自己拉起的**进程；复用来的（例如 launchd 管的）绝不杀。
 *
 * 设计要点（与 launchd 共存的安全性）：
 * - 端口上已经有本项目进程（就绪判据命中）时视为**复用**，status 标 `managed: false`，
 *   stop 不会去杀它。
 * - 端口被非本项目程序占用时如实报错，不 spawn、不假装成功。
 * - 探活失败但端口被占时，先做几次短重试（给「另一个监督者正在启动」留时间），
 *   仍然不满足判据才判冲突。
 * - 看门狗准备自己拉起之前，若 `respectLaunchd` 为真且同 label 的 launchd 任务处于
 *   loaded 状态，则**让给 launchd**（只记日志），避免两个监督者互相抢端口造成重启风暴。
 * - 并发 start 合流成同一次启动，不重复 spawn。
 * - 子进程 stdout/stderr 追加到 panel/data/dsh-plugin-panel.log。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-yangyu-panel'

/** 本插件需要的宿主服务：注册 HTTP 路由用 webServer。 */
export const inject = ['webServer']

/** 路由前缀（kind: 'prefix'）：req.url 带完整前缀，自行剥掉。 */
const ROUTE_PREFIX = '/yangyu-panel'

/**
 * 默认仓库根目录：插件以 `link:` 装进 DSH profile，import.meta.url 解析到的就是仓库里这份
 * （dsh-plugin/yangyu-panel/index.js 往上两级）。以前写死成号主机器上的绝对路径，换台机器就找不到。
 * 仍可在 cordis.patch.yml 的 config.repoRoot 覆盖。
 */
const DEFAULT_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** 跟 panel/install-launchd.sh 同一个规则：com.<当前用户名>.yangyu-panel */
function defaultLaunchdLabel() {
  let user = process.env.USER || ''
  try {
    user = os.userInfo().username || user
  } catch {
    /* 拿不到用户名就用环境变量 */
  }
  return `com.${user || 'user'}.yangyu-panel`
}

/** 内置默认配置：与 ctx 行 config 浅合并，缺字段用默认。 */
const DEFAULTS = {
  repoRoot: DEFAULT_REPO_ROOT,
  panelPort: 8899,
  nodeBin: '',
  /** DSH 启动即拉起面板——「只要 dsh 在运行，面板也在运行」的主开关。 */
  autoStart: true,
  /** 看门狗周期（秒）；0 = 关闭自动重启，只做被动探活。 */
  watchdogSecs: 30,
  /** 单次启动的等待上限（毫秒），与 UI 文案/README 的 30 秒对齐。 */
  startTimeoutMs: 30_000,
  /** 插件注销时是否回收自己拉起的面板；默认 false：面板比 DSH 活得久（与 launchd 一致）。 */
  stopOnHostExit: false,
  /** 看门狗决定自己拉起前，先让位给已 loaded 的 launchd 任务（防双监督者抢端口）。 */
  respectLaunchd: true,
  /** 让位判据用的 launchd label。 */
  launchdLabel: defaultLaunchdLabel(),
  /** launchd loaded 时先等它多久把面板拉起来（毫秒），等不到再兜底自启。 */
  launchdHandoffMs: 8_000,
  /** 看门狗连续拉不起来时的最长退避（秒）：周期按 2 的幂翻倍，封顶于此。 */
  watchdogMaxBackoffSecs: 1_800,
  /** launchctl 可执行文件路径；非 macOS 或非标准安装位置可改，自测里指向假实现。 */
  launchctlBin: '/bin/launchctl',
  /**
   * 额外受信任的 Host 名（反代/自定义域名时才需要）。
   * 默认空：只信 127.0.0.1 / localhost / [::1] 三个 loopback 名，
   * 避免 DNS rebinding 用任意域名指到 127.0.0.1 就能操控本面板。
   */
  trustedHosts: [],
}

/** 就绪判据：面板首页 index.html 里的 <title> 文案。 */
const READY_MARK = '养鱼面板'
/** 就绪轮询间隔。 */
const POLL_INTERVAL_MS = 500
/** 单次探活超时。 */
const PROBE_TIMEOUT_MS = 2_000
/** stop 时 SIGTERM 的宽限期，超时再 SIGKILL。 */
const STOP_GRACE_MS = 8_000
/** 端口被占但探活不通过时的重试：给并发启动的另一个进程留出就绪时间。 */
const BUSY_RETRY_MS = 900
const BUSY_RETRIES = 3
/** 单次启动的总等待上限（与 client 文案、README 对齐）。 */
const DEFAULT_START_TIMEOUT_MS = 30_000

/** 归一化 ctx 行 config：浅合并默认值，逐字段兜底。 */
export function resolveConfig(raw) {
  const source = raw && typeof raw === 'object' ? raw : {}
  const cfg = { ...DEFAULTS, ...source }
  if (typeof cfg.repoRoot !== 'string' || cfg.repoRoot.trim() === '') {
    cfg.repoRoot = DEFAULTS.repoRoot
  }
  cfg.panelPort = toPort(cfg.panelPort, DEFAULTS.panelPort)
  cfg.nodeBin = typeof cfg.nodeBin === 'string' ? cfg.nodeBin : ''
  cfg.watchdogSecs = toNonNegativeInt(cfg.watchdogSecs, DEFAULTS.watchdogSecs)
  cfg.autoStart = cfg.autoStart !== false
  cfg.stopOnHostExit = cfg.stopOnHostExit === true
  cfg.respectLaunchd = cfg.respectLaunchd !== false
  cfg.launchdLabel =
    typeof cfg.launchdLabel === 'string' && cfg.launchdLabel.trim() !== ''
      ? cfg.launchdLabel.trim()
      : DEFAULTS.launchdLabel
  cfg.trustedHosts = normalizeTrustedHosts(cfg.trustedHosts)
  cfg.launchdHandoffMs = toNonNegativeInt(cfg.launchdHandoffMs, DEFAULTS.launchdHandoffMs)
  cfg.watchdogMaxBackoffSecs = toNonNegativeInt(cfg.watchdogMaxBackoffSecs, DEFAULTS.watchdogMaxBackoffSecs)
  return cfg
}

/**
 * 看门狗退避：连续 fails 次没拉起来后，下一次至少隔多久（毫秒）。
 * 面板一启动就崩（配置错之类，不是端口问题）时，固定 30 秒重拉会让日志无限增长；
 * 改成 secs·2^fails，封顶 maxSecs。fails=0 就是正常周期。
 */
export function watchdogBackoffMs(secs, fails, maxSecs = DEFAULTS.watchdogMaxBackoffSecs) {
  const base = Math.max(0, Number(secs) || 0)
  const n = Math.max(0, Math.min(20, Number(fails) || 0))
  return Math.min(base * 2 ** n, Math.max(base, Number(maxSecs) || 0)) * 1_000
}

/** 允许清单归一化：小写、去空白、只留非空字符串，避免手写配置带来的大小写/空格问题。 */
function normalizeTrustedHosts(raw) {
  if (!Array.isArray(raw)) return []
  const out = []
  for (const item of raw) {
    if (typeof item !== 'string') continue
    const name = item.trim().toLowerCase()
    if (name !== '' && !out.includes(name)) out.push(name)
  }
  return out
}

function toPort(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 && n < 65_536 ? n : fallback
}

function toNonNegativeInt(value, fallback) {
  const n = Number(value)
  return Number.isInteger(n) && n >= 0 ? n : fallback
}

/** 由仓库根目录推导出的所有固定路径。 */
export function resolvePaths(repoRoot) {
  const repo = path.resolve(repoRoot)
  return {
    repo,
    panelDir: path.join(repo, 'panel'),
    panelEntry: path.join(repo, 'panel', 'panel.mjs'),
    dataDir: path.join(repo, 'panel', 'data'),
    logPath: path.join(repo, 'panel', 'data', 'dsh-plugin-panel.log'),
  }
}

/** node 可执行文件查找：config.nodeBin → PANEL_NODE_BIN → 常见绝对路径 → PATH。 */
export function resolveNodeBin(nodeBin) {
  const candidates = [
    nodeBin,
    process.env.PANEL_NODE_BIN,
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate !== '' && fs.existsSync(candidate)) {
      return candidate
    }
  }
  const dirs = (process.env.PATH ?? '').split(path.delimiter)
  for (const dir of dirs) {
    if (!dir) continue
    const candidate = path.join(dir, 'node')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 面板就绪判据（也可被自测脚本复用）。 */
export function isPanelBody(body) {
  return typeof body === 'string' && body.includes(READY_MARK)
}

export function apply(ctx, config) {
  const cfg = resolveConfig(config)
  const paths = resolvePaths(cfg.repoRoot)
  const runtime = createRuntime(ctx, cfg, paths)

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: runtime.handler,
    })
    return () => {
      try {
        if (typeof disposeRoute === 'function') disposeRoute()
        else if (disposeRoute && typeof disposeRoute.dispose === 'function') disposeRoute.dispose()
      } catch (error) {
        runtime.log('error', `释放路由失败：${describe(error)}`)
      }
    }
  }, 'dsh-yangyu-panel: /yangyu-panel 路由')

  ctx.effect(() => {
    runtime.startWatchdog()
    // 宿主进程退出时兜底回收自己拉起的面板（仅当 stopOnHostExit=true）。
    // 之前 onHostExit 只有定义没人挂，等于死代码 —— 现在真正接上 exit 钩子。
    process.on('exit', runtime.onHostExit)
    return () => {
      process.removeListener('exit', runtime.onHostExit)
      runtime.dispose()
    }
  }, 'dsh-yangyu-panel: 面板进程与看门狗')

  runtime.log(
    'info',
    `加载完成：面板入口 ${paths.panelEntry}，端口 ${cfg.panelPort}，autoStart=${cfg.autoStart}，` +
      `watchdog=${cfg.watchdogSecs}s，stopOnHostExit=${cfg.stopOnHostExit}`,
  )

  if (cfg.autoStart) {
    void runtime.start('插件加载（autoStart）').catch((error) => {
      runtime.log('error', `autoStart 失败：${describe(error)}`)
    })
  } else {
    runtime.log('info', 'autoStart=false：等待 POST /yangyu-panel/start 或看门狗触发')
  }
}

export function createRuntime(ctx, cfg, paths) {
  const service = newService(cfg.panelPort, paths.logPath)

  let starting = false
  let startPromise = null
  let disposed = false
  let watchdogTimer = null
  /** 看门狗退避状态：连续失败次数、下一次最早什么时候再拉 */
  const watchdog = { fails: 0, nextAt: 0 }

  function log(level, message) {
    const logger = ctx?.logger
    const line = `[${name}] ${message}`
    const fn = logger && typeof logger[level] === 'function' ? logger[level].bind(logger) : null
    if (fn) fn(line)
    else if (level === 'error') console.error(line)
  }

  // ---------------------------------------------------------------- 探活

  function httpGet(port, pathname, timeoutMs) {
    return new Promise((resolve) => {
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      let req
      try {
        req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: pathname,
            method: 'GET',
            agent: false,
            headers: { connection: 'close', accept: 'text/html,*/*' },
          },
          (res) => {
            let body = ''
            res.setEncoding('utf8')
            res.on('data', (chunk) => {
              if (body.length < 262_144) body += chunk
            })
            res.on('end', () => finish({ ok: true, status: res.statusCode ?? 0, body }))
            res.on('error', () => finish({ ok: false, status: 0, body: '' }))
          },
        )
      } catch {
        finish({ ok: false, status: 0, body: '' })
        return
      }
      req.setTimeout(timeoutMs, () => req.destroy(new Error('probe timeout')))
      req.on('error', () => finish({ ok: false, status: 0, body: '' }))
      req.end()
    })
  }

  async function probe() {
    const { ok, status, body } = await httpGet(service.port, '/', PROBE_TIMEOUT_MS)
    if (!ok || status !== 200) return false
    return isPanelBody(body)
  }

  function isPortInUse(port) {
    return new Promise((resolve) => {
      const socket = net.connect({ host: '127.0.0.1', port })
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        socket.removeAllListeners()
        socket.destroy()
        resolve(value)
      }
      socket.setTimeout(600, () => finish(false))
      socket.once('connect', () => finish(true))
      socket.once('error', () => finish(false))
    })
  }

  /**
   * launchd 任务是否 loaded（准备自己拉起前的让位判据）。
   *
   * 返回 'loaded' | 'absent' | 'unknown' 三态：
   * - 'absent' = launchctl 明确说没这个任务（非 0 退出）；
   * - 'unknown' = launchctl 压根跑不起来（沙箱/权限/PATH 问题）—— 此时**不能**当成
   *   「没 loaded」而静默去抢端口，要记日志说明判据失效。误判成 absent 的后果由
   *   panel.mjs 的 EADDRINUSE 兜底（第二个实例会以 0 退出，探活随后看到已有的面板）。
   */
  function launchdJobState(label) {
    return new Promise((resolve) => {
      if (typeof process.getuid !== 'function') {
        resolve('unknown')
        return
      }
      let child
      try {
        child = spawn(cfg.launchctlBin || '/bin/launchctl', ['print', `gui/${process.getuid()}/${label}`], {
          stdio: ['ignore', 'ignore', 'ignore'],
        })
      } catch {
        resolve('unknown')
        return
      }
      let settled = false
      const finish = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          /* 已退出 */
        }
        finish('unknown')
      }, 2_500)
      if (typeof timer.unref === 'function') timer.unref()
      child.on('error', () => {
        clearTimeout(timer)
        finish('unknown')
      })
      child.on('exit', (code) => {
        clearTimeout(timer)
        finish(code === 0 ? 'loaded' : 'absent')
      })
    })
  }

  /** 兼容旧调用点：只有明确 loaded 才算让位。 */
  async function launchdJobLoaded(label) {
    return (await launchdJobState(label)) === 'loaded'
  }

  // ---------------------------------------------------------------- 前置检查

  function preflight() {
    if (!fs.existsSync(paths.panelEntry)) {
      return `缺少面板入口文件：${paths.panelEntry}`
    }
    if (!resolveNodeBin(cfg.nodeBin)) {
      return '未找到 node 可执行文件（依次尝试 config.nodeBin、环境变量 PANEL_NODE_BIN、/opt/homebrew/bin/node、/usr/local/bin/node、PATH）'
    }
    return null
  }

  // ---------------------------------------------------------------- 子进程

  function spawnPanel() {
    try {
      fs.mkdirSync(paths.dataDir, { recursive: true })
      fs.appendFileSync(
        service.logPath,
        `\n===== ${name} 启动面板 @ ${new Date().toISOString()} =====\n`,
      )
      service.fd = fs.openSync(service.logPath, 'a')
    } catch (error) {
      service.error = `无法写入日志文件 ${service.logPath}：${describe(error)}`
      return
    }

    const spec = {
      cmd: resolveNodeBin(cfg.nodeBin),
      args: [paths.panelEntry],
      cwd: paths.panelDir,
      env: { ...process.env, PANEL_PORT: String(service.port) },
    }

    let child
    try {
      child = spawn(spec.cmd, spec.args, {
        cwd: spec.cwd,
        env: spec.env,
        // detached：自成进程组，stop 时可以整组回收。
        detached: true,
        stdio: ['ignore', service.fd, service.fd],
      })
    } catch (error) {
      service.error = `无法启动面板进程：${describe(error)}`
      closeFd()
      return
    }

    service.child = child
    service.pid = child.pid ?? null
    service.managed = true
    service.ready = false
    service.error = null
    service.exitInfo = null
    log('info', `已拉起面板：pid=${service.pid} cwd=${spec.cwd} 日志=${service.logPath}`)

    child.on('error', (error) => {
      service.error = `面板进程启动失败：${describe(error)}`
      if (service.child === child) {
        service.child = null
        service.pid = null
        service.managed = false
      }
      closeFd()
    })

    child.on('exit', (code, signal) => {
      if (service.child !== child) return
      service.child = null
      service.pid = null
      const wasManaged = service.managed
      service.managed = false
      service.ready = false
      service.exitInfo = { code, signal }
      closeFd()
      if (service.stopping || !wasManaged) return
      if (code !== 0 && signal === null) {
        service.error = `面板进程异常退出（code=${code}），日志：${service.logPath}`
      } else if (signal !== null) {
        service.error = `面板进程被信号 ${signal} 终止，日志：${service.logPath}`
      }
      log('error', service.error ?? `面板进程退出（code=${code}, signal=${signal}）`)
    })
  }

  function closeFd() {
    if (service.fd === null) return
    try {
      fs.closeSync(service.fd)
    } catch {
      /* 已关闭 */
    }
    service.fd = null
  }

  function killGroup(pid, signal) {
    if (!pid) return
    try {
      process.kill(-pid, signal)
    } catch {
      try {
        process.kill(pid, signal)
      } catch {
        /* 已退出 */
      }
    }
  }

  function waitExit(child, timeoutMs) {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
    return new Promise((resolve) => {
      const onExit = () => {
        clearTimeout(timer)
        resolve(true)
      }
      const timer = setTimeout(() => {
        child.removeListener('exit', onExit)
        resolve(false)
      }, timeoutMs)
      child.once('exit', onExit)
    })
  }

  // ---------------------------------------------------------------- 启动 / 等待 / 停止

  async function waitReady() {
    const timeoutMs = Number(cfg.startTimeoutMs) || DEFAULT_START_TIMEOUT_MS
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (service.exitInfo) return false
      if (await probe()) {
        service.ready = true
        service.error = null
        return true
      }
      await sleep(POLL_INTERVAL_MS)
    }
    service.ready = false
    if (!service.error) {
      service.error = `面板在 ${Math.round(timeoutMs / 1000)} 秒内未就绪；日志：${service.logPath}`
    }
    return false
  }

  /** 在给定时间窗内等「外部（launchd）把面板拉起来」。 */
  async function waitForReady(windowMs) {
    const deadline = Date.now() + windowMs
    while (Date.now() < deadline) {
      if (await probe()) return true
      await sleep(POLL_INTERVAL_MS)
    }
    return false
  }

  /** 端口被占但判据不通过：重试若干次，给并发启动的进程留出就绪时间。 */
  async function settleBusyPort() {
    for (let attempt = 0; attempt < BUSY_RETRIES; attempt += 1) {
      await sleep(BUSY_RETRY_MS)
      if (await probe()) return true
    }
    return false
  }

  async function ensure(reason) {
    // 1) 已满足就绪判据：本项目进程（不管谁拉起的）直接复用。
    if (await probe()) {
      service.ready = true
      service.error = null
      return true
    }
    // 2) 我们拉起的进程还在跑（还没就绪）→ 等它就绪。
    if (service.child) return waitReady()

    // 3) 端口被占但判据不通过：可能是另一个监督者正在拉起 → 短重试后再判冲突。
    if (await isPortInUse(service.port)) {
      if (await settleBusyPort()) {
        service.ready = true
        service.error = null
        log('info', '端口上已有就绪的面板（复用现有进程）')
        return true
      }
      service.ready = false
      service.managed = false
      service.error = `端口 ${service.port} 已被其他进程占用，且响应不满足面板就绪判据；请先释放该端口或改用 config.panelPort`
      return false
    }

    // 4) launchd 任务 loaded 时优先让位给它——两个监督者同时抢端口会互相打架。
    //    但**让位不等于放弃**：让位后必须确认面板真的被 launchd 拉起来了，
    //    否则「DSH 在跑 → 面板也在跑」这句话就是假的（plist 的 KeepAlive 只覆盖
    //    SuccessfulExit=false，正常退出码 0 时 launchd 不会再拉）。所以这里等一小段，
    //    起来了就报 ready，没起来就自己拉起并说明原因。
    if (cfg.respectLaunchd) {
      const state = await launchdJobState(cfg.launchdLabel)
      if (state === 'unknown') {
        log(
          'error',
          `无法判定 launchd 任务 ${cfg.launchdLabel} 的状态（launchctl 不可用），将自行启动面板；若端口已被 launchd 实例占用，第二个实例会以 0 退出，不影响现有面板`,
        )
      }
      if (state === 'loaded') {
        service.managed = false
        service.error = null
        log(
          'info',
          `端口 ${service.port} 空闲，但 launchd 任务 ${cfg.launchdLabel} 处于 loaded 状态：先让它在 ${cfg.launchdHandoffMs / 1000} 秒内拉起`,
        )
        if (await waitForReady(cfg.launchdHandoffMs)) {
          service.ready = true
          return true
        }
        log(
          'error',
          `launchd 任务 ${cfg.launchdLabel} 在该窗口内没有把面板拉起来，改由插件兜底启动（避免面板一直不在）`,
        )
      }
    }

    // 5) 依赖缺失 → 给出明确缺失路径。
    const missing = preflight()
    if (missing) {
      service.ready = false
      service.managed = false
      service.error = missing
      return false
    }

    // 6) 拉起并等到就绪或超时。
    log('info', `拉起面板（来源：${reason}）`)
    service.exitInfo = null
    service.stopping = false
    spawnPanel()
    if (!service.child) return false
    return waitReady()
  }

  async function start(reason) {
    if (startPromise) return startPromise
    startPromise = (async () => {
      starting = true
      try {
        await ensure(reason)
      } catch (error) {
        log('error', `启动流程异常：${describe(error)}`)
      } finally {
        starting = false
        startPromise = null
      }
      const result = await refresh()
      log('info', `启动结束：ready=${result.panel.ready} pid=${result.panel.pid ?? '-'}`)
      return result
    })()
    return startPromise
  }

  async function stopService() {
    const child = service.child
    if (!child || !service.managed) {
      // 复用来的（含 launchd 管的）：不杀，只刷新真实状态。
      service.ready = await probe()
      if (service.ready) service.error = null
      service.error = service.ready
        ? null
        : service.error ??
          '面板由外部进程（例如 launchd）管理，插件不回收它；如需停止请用插件外的方式'
      return
    }

    const pid = child.pid
    service.stopping = true
    log('info', `回收面板：pid=${pid}`)
    const exited = waitExit(child, STOP_GRACE_MS)
    killGroup(pid, 'SIGTERM')
    if (!(await exited)) {
      log('error', '面板未在宽限期内退出，发送 SIGKILL')
      killGroup(pid, 'SIGKILL')
      await waitExit(child, 3_000)
    }
    closeFd()
    service.child = null
    service.pid = null
    service.managed = false
    service.ready = false
    service.error = (await isPortInUse(service.port))
      ? `已终止面板进程，但端口 ${service.port} 仍被占用`
      : null
  }

  async function stop(reason) {
    if (startPromise) {
      try {
        await startPromise
      } catch {
        /* 启动失败直接进入停止 */
      }
    }
    log('info', `停止面板（来源：${reason}）`)
    await stopService()
    return refresh()
  }

  // ---------------------------------------------------------------- 状态

  async function refresh() {
    const ready = await probe()
    service.ready = ready
    if (ready) {
      service.error = null
      service.exitInfo = null
    }
    return snapshot()
  }

  function snapshot() {
    return {
      panel: {
        ready: service.ready === true,
        port: service.port,
        pid: service.pid ?? null,
        managed: service.managed === true,
        error: service.error ?? null,
      },
      url: `http://127.0.0.1:${service.port}/`,
      starting,
      autoStart: cfg.autoStart === true,
    }
  }

  // ---------------------------------------------------------------- 看门狗

  function startWatchdog() {
    const secs = Number(cfg.watchdogSecs) || 0
    if (secs <= 0 || watchdogTimer) return
    watchdogTimer = setInterval(() => {
      void watchdogTick()
    }, secs * 1_000)
    if (typeof watchdogTimer.unref === 'function') watchdogTimer.unref()
    log('info', `看门狗已启动：每 ${secs} 秒探活一次`)
  }

  async function watchdogTick() {
    if (disposed || starting || startPromise) return
    try {
      if (await probe()) {
        service.ready = true
        service.error = null
        watchdog.fails = 0
        watchdog.nextAt = 0
        return
      }
      if (service.child) return // 自己拉起的进程还在，交给 waitReady/exit 处理
      if (Date.now() < watchdog.nextAt) return // 退避中：别每 30 秒重拉一次、往日志里灌一屏
      log('error', '看门狗探活失败：面板未响应，尝试自动拉起')
      // 走 start() 而不是直接 ensure()：复用 startPromise 互斥，
      // 否则看门狗与 HTTP /start 并发时都可能通过「端口空闲」判定而双 spawn。
      await start('看门狗自愈')
      if (service.ready) {
        watchdog.fails = 0
        watchdog.nextAt = 0
      } else {
        watchdog.fails += 1
        const wait = watchdogBackoffMs(cfg.watchdogSecs, watchdog.fails, cfg.watchdogMaxBackoffSecs)
        watchdog.nextAt = Date.now() + wait
        log('error', `看门狗连续 ${watchdog.fails} 次没拉起面板，${Math.round(wait / 1000)} 秒后再试`)
      }
    } catch (error) {
      log('error', `看门狗异常：${describe(error)}`)
    }
  }

  // ---------------------------------------------------------------- HTTP 路由

  /**
   * 同源/本机判定，挡住跨站 CSRF **和 DNS rebinding**。
   *
   * 最初 `/yangyu-panel/*` 对任何来源都返回 200，本机任意网页都能 POST 一个 /stop 把面板停掉。
   * 第一版修复只做「本请求 Origin host ↔ 本请求 Host」自证 —— 这是个真缺陷：
   * 攻击者用 DNS rebinding 让 evil.com 解析到 127.0.0.1，浏览器发出的
   * `Host: evil.com:58567` 与 `Origin: http://evil.com:58567` 两边**都来自同一个不可信请求**，
   * 自证必然通过（实测确实 200）。
   *
   * 现在照 DSH 自己的做法（isTrustedAuthority）：**不采信请求头自证**，改为
   * 1) Host 必须解析到 loopback 字面量或允许清单里的确切名字，否则一律拒绝（DNS rebinding 防线）；
   * 2) 有 Origin 时必须同源；
   * 3) 有 Sec-Fetch-Site 时只允许 same-origin / none。
   * 本机 curl 不带 Origin、Host 是 127.0.0.1:port，照常可用。
   */
  function isTrustedHost(hostHeader) {
    if (typeof hostHeader !== 'string' || hostHeader === '') return false
    // 去掉端口：[::1]:58567 这种要保留方括号内的 IPv6 字面量。
    let name = hostHeader
    const ipv6 = /^\[([^\]]+)\](?::\d+)?$/.exec(hostHeader)
    if (ipv6) name = ipv6[1]
    else if (/^[^:]+:\d+$/.test(hostHeader)) name = hostHeader.slice(0, hostHeader.lastIndexOf(':'))
    else if (hostHeader.includes(':')) return false // 未加方括号的 IPv6 视为不可信
    name = name.toLowerCase()
    if (name === '127.0.0.1' || name === '::1' || name === 'localhost') return true
    // 允许清单：config.trustedHosts 里显式列出的名字（反代/自定义域名场景）。
    return Array.isArray(cfg.trustedHosts) && cfg.trustedHosts.includes(name)
  }

  function isSameOrigin(req) {
    const host = (req.headers && (req.headers.host || '')) || ''
    if (!isTrustedHost(host)) return false

    const origin = req.headers && req.headers.origin
    if (typeof origin === 'string' && origin !== '') {
      // origin: null（file:// / 沙箱 iframe）一律拒绝。
      if (origin === 'null') return false
      let parsed
      try {
        parsed = new URL(origin)
      } catch {
        return false
      }
      // Origin 那一侧同样必须落在受信任主机上，且**端口一致**。
      // 不直接比对「Origin host === Host host」：localhost 与 127.0.0.1 指向同一台机器，
      // 页面从 localhost 发起、请求打到 127.0.0.1 是合法同源场景，直接比字符串会误拒。
      if (!isTrustedHost(parsed.host)) return false
      if (hostPort(host) !== hostPort(parsed.host)) return false
    }

    const site = req.headers && req.headers['sec-fetch-site']
    if (typeof site === 'string' && site !== 'same-origin' && site !== 'none') return false
    return true
  }

  /** 取 host:port 里的端口部分；缺省按 http 的 80 处理。 */
  function hostPort(hostHeader) {
    const m = /^\[[^\]]+\]:(\d+)$/.exec(hostHeader) || /^[^:]+:(\d+)$/.exec(hostHeader)
    return m ? m[1] : '80'
  }

  async function handler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      let route = url.pathname
      if (route.startsWith(ROUTE_PREFIX)) route = route.slice(ROUTE_PREFIX.length)
      route = route.replace(/\/+$/, '') || '/'
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'POST') await readBody(req)

      // 只对会改变进程状态的 POST 做同源校验；GET /status 是只读探针，保持宽松。
      if (method === 'POST' && !isSameOrigin(req)) {
        log('error', `拒绝跨站请求：${method} ${url.pathname} origin=${req.headers?.origin ?? '-'}`)
        return sendJson(res, 403, { error: 'cross-origin request rejected' })
      }

      if (method === 'GET' && route === '/') {
        return sendJson(res, 200, {
          plugin: name,
          routes: [
            'GET  /yangyu-panel/status',
            'POST /yangyu-panel/start',
            'POST /yangyu-panel/stop',
          ],
        })
      }
      if (method === 'GET' && route === '/status') {
        return sendJson(res, 200, await refresh())
      }
      if (method === 'POST' && route === '/start') {
        return sendJson(res, 200, await start('http'))
      }
      if (method === 'POST' && route === '/stop') {
        return sendJson(res, 200, await stop('http'))
      }
      return sendJson(res, 404, { error: `未知路由：${method} ${url.pathname}` })
    } catch (error) {
      log('error', `路由处理失败：${describe(error)}`)
      try {
        sendJson(res, 500, { error: describe(error) })
      } catch {
        /* 连接已断 */
      }
    }
  }

  // ---------------------------------------------------------------- 清理

  function onHostExit() {
    if (!cfg.stopOnHostExit) return
    if (service.child && service.managed && service.child.pid) {
      killGroup(service.child.pid, 'SIGKILL')
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    if (watchdogTimer) {
      clearInterval(watchdogTimer)
      watchdogTimer = null
    }
    if (cfg.stopOnHostExit && service.child && service.managed && service.child.pid) {
      service.stopping = true
      const pid = service.child.pid
      log('info', `插件卸载：回收自己拉起的面板 pid=${pid}`)
      killGroup(pid, 'SIGTERM')
      const timer = setTimeout(() => killGroup(pid, 'SIGKILL'), 4_000)
      if (typeof timer.unref === 'function') timer.unref()
    }
    closeFd()
  }

  return {
    handler,
    start,
    stop,
    refresh,
    dispose,
    onHostExit,
    startWatchdog,
    log,
    // 自测脚本用：暴露内部件以便在隔离端口上验证，不改变运行时行为。
    internals: { probe, ensure, snapshot, service, watchdogTick, watchdog },
  }
}

function newService(port, logPath) {
  return {
    port,
    logPath,
    ready: false,
    managed: false,
    child: null,
    pid: null,
    fd: null,
    error: null,
    exitInfo: null,
    stopping: false,
  }
}

function readBody(req, limit = 65_536) {
  return new Promise((resolve) => {
    if (!req || typeof req.on !== 'function') {
      resolve('')
      return
    }
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        resolve('')
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', () => resolve(''))
    req.on('aborted', () => resolve(''))
  })
}

function sendJson(res, status, payload) {
  if (!res || res.writableEnded || res.headersSent) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function describe(error) {
  if (error instanceof Error) return error.message
  return String(error)
}

export const __test__ = { ROUTE_PREFIX, READY_MARK, DEFAULTS }
