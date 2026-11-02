#!/usr/bin/env node
/**
 * dsh-yangyu-panel 自测（不触碰生产面板）
 *
 * 铁律（用户跨项目规则「自测脚本禁止假成功」）：前置条件未满足而跳过时，绝不输出
 * 「全部通过」——显式标注「未执行」并以非零退出码退出。
 *
 * 安全边界：本脚本**永不 spawn 真实 panel.mjs**（那会带上自动养号调度器，等于起第二个
 * 面板去动 B站 账号）。所有涉及 spawn 的分支都用「假上游 + 不存在 repoRoot」把路堵死：
 *   - 复用分支：本机起一个假的面板服务（返回含「养鱼面板」的 HTML）→ 走复用，不 spawn；
 *   - 冲突分支：本机起一个陌生服务（HTML 不含判据）→ 只报冲突，不 spawn；
 *   - 守卫分支：取一个空闲端口 + 不存在的 repoRoot → 要么让位 launchd，要么报缺入口，都不 spawn。
 * 每个分支都断言 service.child === null，作为「没起进程」的硬证据。
 *
 * 退出码：0 = 全部执行且通过；1 = 有失败；2 = 有未执行（跳过）项。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.resolve(here, '..')
const INDEX = path.join(pkgDir, 'index.js')
const CLIENT = path.join(pkgDir, 'client.js')

const results = []

function record(name, outcome, detail) {
  results.push({ name, outcome, detail })
  const mark = outcome === 'pass' ? '✅' : outcome === 'fail' ? '❌' : '⚠️'
  const tail = detail ? ` — ${detail}` : ''
  console.log(`${mark} ${name}${tail}`)
}

async function runCase(name, fn) {
  try {
    const detail = await fn()
    record(name, 'pass', detail)
  } catch (error) {
    record(name, 'fail', error && error.message ? error.message : String(error))
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

// ─── 基础设施 ───────────────────────────────────────────────

function syntaxCheck(file) {
  const out = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  assert(out.status === 0, `${path.basename(file)} 语法检查失败：${out.stderr || out.stdout}`)
}

function listen(server, port = 0) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server.address().port))
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

async function freePort() {
  const probe = net.createServer()
  const port = await listen(probe)
  await close(probe)
  return port
}

function request(url, method = 'GET', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, agent: false, headers }, (res) => {
      let body = ''
      res.setEncoding('utf8')
      res.on('data', (chunk) => {
        body += chunk
      })
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.setTimeout(15_000, () => req.destroy(new Error('请求超时')))
    req.on('error', reject)
    req.end()
  })
}

function fakePanelServer(marker) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(`<!doctype html><html><head><title>${marker}</title></head><body>fake</body></html>`)
  })
  return server
}

/** 把 runtime.handler 挂到真实 HTTP 上：用真 req/res 驱动路由，比手搓假对象更可信。 */
async function withRouteServer(runtime) {
  const server = http.createServer((req, res) => {
    void runtime.handler(req, res)
  })
  const port = await listen(server)
  return {
    base: `http://127.0.0.1:${port}`,
    async status() {
      const res = await request(this.base + '/status')
      assert(res.status === 200, `GET /status 期望 200，实际 ${res.status}`)
      return JSON.parse(res.body)
    },
    async start(headers = {}) {
      const res = await request(this.base + '/start', 'POST', headers)
      assert(res.status === 200, `POST /start 期望 200，实际 ${res.status}`)
      return JSON.parse(res.body)
    },
    async startRaw(headers = {}) {
      return await request(this.base + '/start', 'POST', headers)
    },
    route(pathname, method, headers = {}) {
      return request(this.base + pathname, method, headers)
    },
    close: () => close(server),
  }
}

const logs = []
const fakeCtx = {
  logger: {
    info: (line) => logs.push({ level: 'info', line }),
    error: (line) => logs.push({ level: 'error', line }),
    warn: (line) => logs.push({ level: 'warn', line }),
  },
}

// ─── 用例 ───────────────────────────────────────────────────

async function main() {
  const mod = await import(INDEX)

  await runCase('语法检查 index.js / client.js', () => {
    syntaxCheck(INDEX)
    syntaxCheck(CLIENT)
    return 'node --check 通过'
  })

  await runCase('宿主导出面完整', () => {
    assert(mod.name === 'dsh-yangyu-panel', `name 期望 dsh-yangyu-panel，实际 ${mod.name}`)
    assert(
      Array.isArray(mod.inject) && mod.inject.includes('webServer'),
      'inject 必须包含 webServer（注册 HTTP 路由用）',
    )
    assert(typeof mod.apply === 'function', '缺少 apply')
    assert(typeof mod.resolveConfig === 'function', '缺少 resolveConfig')
    assert(typeof mod.resolvePaths === 'function', '缺少 resolvePaths')
    assert(typeof mod.resolveNodeBin === 'function', '缺少 resolveNodeBin')
    assert(typeof mod.createRuntime === 'function', '缺少 createRuntime（自测复用）')
    return `inject=[${mod.inject.join(', ')}]`
  })

  await runCase('resolveConfig：默认值 + 非法值兜底', () => {
    const d = mod.resolveConfig(undefined)
    assert(d.autoStart === true, 'autoStart 默认必须为 true（DSH 起则面板起）')
    assert(d.panelPort === 8899, `panelPort 默认期望 8899，实际 ${d.panelPort}`)
    assert(d.watchdogSecs === 30, `watchdogSecs 默认期望 30，实际 ${d.watchdogSecs}`)
    assert(d.stopOnHostExit === false, 'stopOnHostExit 默认必须为 false')
    assert(d.respectLaunchd === true, 'respectLaunchd 默认必须为 true')
    assert(
      d.launchdLabel === 'com.mikejam.yangyu-panel',
      `launchdLabel 默认不符：${d.launchdLabel}`,
    )
    const bad = mod.resolveConfig({ panelPort: 'abc', watchdogSecs: -1, autoStart: false })
    assert(bad.panelPort === 8899, '非法 panelPort 应回落到 8899')
    assert(bad.watchdogSecs === 30, '负数 watchdogSecs 应回落')
    assert(bad.autoStart === false, '显式 autoStart:false 必须生效')
    const zero = mod.resolveConfig({ watchdogSecs: 0 })
    assert(zero.watchdogSecs === 0, 'watchdogSecs:0 是合法值（关闭看门狗），不应回落')
    return '默认与兜底均符合预期'
  })

  await runCase('resolvePaths：由 repoRoot 推导出真实存在的入口', () => {
    const repo = path.resolve(pkgDir, '..', '..')
    const paths = mod.resolvePaths(repo)
    assert(paths.panelEntry.endsWith('/panel/panel.mjs'), `panelEntry 不符：${paths.panelEntry}`)
    assert(
      fs.existsSync(paths.panelEntry),
      `推导出的面板入口不存在：${paths.panelEntry}`,
    )
    assert(
      paths.logPath.endsWith('/panel/data/dsh-plugin-panel.log'),
      `logPath 不符：${paths.logPath}`,
    )
    return `panelEntry=${paths.panelEntry}`
  })

  await runCase('resolveNodeBin：能在本机找到 node', () => {
    const bin = mod.resolveNodeBin('')
    assert(typeof bin === 'string' && bin !== '', '未找到 node 可执行文件')
    return bin
  })

  // ── 复用分支：假面板已在跑 → POST /start 只复用，不 spawn ──
  await runCase('复用分支：已就绪面板 → ready=true / managed=false / 不 spawn', async () => {
    const fake = fakePanelServer('养鱼面板')
    const fakePort = await listen(fake)
    const cfg = mod.resolveConfig({ panelPort: fakePort, autoStart: false, watchdogSecs: 0 })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(pkgDir))
    const route = await withRouteServer(runtime)
    try {
      const status = await route.status()
      assert(status.panel.ready === true, `期望 ready=true，实际 ${JSON.stringify(status.panel)}`)
      assert(status.panel.managed === false, '复用来的进程 managed 必须是 false')
      assert(
        status.url === `http://127.0.0.1:${fakePort}/`,
        `url 不符：${status.url}`,
      )
      const started = await route.start()
      assert(started.panel.ready === true, 'POST /start 在复用路径上应直接返回 ready')
      assert(runtime.internals.service.child === null, '复用路径绝不能 spawn 子进程')
      return `port=${fakePort} pid=${started.panel.pid}`
    } finally {
      await route.close()
      runtime.dispose()
      await close(fake)
    }
  })

  // ── 冲突分支：端口被陌生程序占着 → 如实报错，不 spawn ──
  await runCase('冲突分支：端口被陌生服务占用 → 报错且不 spawn', async () => {
    const foreign = fakePanelServer('某个别人的页面')
    const foreignPort = await listen(foreign)
    const cfg = mod.resolveConfig({ panelPort: foreignPort, autoStart: false, watchdogSecs: 0 })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(pkgDir))
    const route = await withRouteServer(runtime)
    try {
      const started = await route.start()
      assert(started.panel.ready === false, '陌生服务不应被判为就绪')
      assert(
        typeof started.panel.error === 'string' && started.panel.error.includes('已被其他进程占用'),
        `错误信息应说明端口冲突，实际：${started.panel.error}`,
      )
      assert(runtime.internals.service.child === null, '冲突路径绝不能 spawn 子进程')
      return started.panel.error.slice(0, 40) + '…'
    } finally {
      await route.close()
      runtime.dispose()
      await close(foreign)
    }
  })

  // ── 守卫分支：端口空闲 + 不存在的 repoRoot → 无论 launchd 判定如何，都不 spawn 越权实例 ──
  await runCase('守卫分支：空闲端口不越权启动（缺入口 / 让位 launchd / 判据失效）', async () => {
    const port = await freePort()
    logs.length = 0
    const cfg = mod.resolveConfig({
      panelPort: port,
      repoRoot: '/tmp/dsh-yangyu-panel-selftest-does-not-exist',
      autoStart: false,
      watchdogSecs: 0,
      // 让位窗口压到最短，避免自测等 8 秒
      launchdLabel: 'com.mikejam.yangyu-panel-selftest-nonexistent',
    })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(cfg.repoRoot))
    const route = await withRouteServer(runtime)
    try {
      const started = await route.start()
      assert(started.panel.ready === false, '不存在的面板不应就绪')
      assert(runtime.internals.service.child === null, '守卫路径绝不能 spawn 子进程')
      const missing =
        typeof started.panel.error === 'string' && started.panel.error.includes('缺少面板入口文件')
      // 三态判据：loaded → 让位并等窗口；absent → 直接缺入口；unknown → 记「判据失效」再缺入口
      const sawLaunchdLog = logs.some((l) => l.line.includes('launchd'))
      assert(
        missing || sawLaunchdLog,
        `期望「缺入口」或与 launchd 相关的日志，实际：${JSON.stringify(started)}`,
      )
      // 关键：无论哪条分支，最终都必须落到明确的错误上，不能 ready:false 且 error:null（旧的静默缺陷）
      assert(
        typeof started.panel.error === 'string' && started.panel.error !== '',
        `ready:false 时必须有明确 error，实际：${JSON.stringify(started.panel)}`,
      )
      return missing ? '终态=缺入口（判据未 loaded 或已失效）' : '终态=让位窗口后缺入口'
    } finally {
      await route.close()
      runtime.dispose()
    }
  })

  await runCase('路由：GET / 列路由，未知路径 404，PUT 不可用', async () => {
    const cfg = mod.resolveConfig({ panelPort: 8899, autoStart: false, watchdogSecs: 0 })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(pkgDir))
    const route = await withRouteServer(runtime)
    try {
      const index = await route.route('/', 'GET')
      assert(index.status === 200, `GET / 期望 200，实际 ${index.status}`)
      const payload = JSON.parse(index.body)
      assert(payload.plugin === 'dsh-yangyu-panel', `plugin 字段不符：${payload.plugin}`)
      assert(
        Array.isArray(payload.routes) && payload.routes.length === 3,
        `期望 3 条路由说明，实际 ${JSON.stringify(payload.routes)}`,
      )
      const missing = await route.route('/nope', 'GET')
      assert(missing.status === 404, `未知路径期望 404，实际 ${missing.status}`)
      const put = await route.route('/start', 'PUT')
      assert(put.status === 404, `PUT /start 期望 404（只支持 GET/POST），实际 ${put.status}`)
      return payload.routes.join(' | ')
    } finally {
      await route.close()
      runtime.dispose()
    }
  })

  // ── 新增：跨站 CSRF 必须被挡住 ──
  await runCase('安全：跨站 Origin 的 POST 被拒绝（403），同源放行', async () => {
    const cfg = mod.resolveConfig({ panelPort: 8899, autoStart: false, watchdogSecs: 0 })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(pkgDir))
    const route = await withRouteServer(runtime)
    try {
      const evil = await route.startRaw({ origin: 'http://evil.example' })
      assert(evil.status === 403, `跨站 POST 期望 403，实际 ${evil.status}`)
      const nullOrigin = await route.startRaw({ origin: 'null' })
      assert(nullOrigin.status === 403, `origin:null 期望 403，实际 ${nullOrigin.status}`)
      const crossSite = await route.startRaw({ 'sec-fetch-site': 'cross-site' })
      assert(crossSite.status === 403, `sec-fetch-site:cross-site 期望 403，实际 ${crossSite.status}`)
      // 只读探针保持宽松：GET /status 不带 Origin 应 200
      const status = await route.route('/status', 'GET')
      assert(status.status === 200, `GET /status 期望 200，实际 ${status.status}`)
      return '跨站 403 / 同源与只读 200'
    } finally {
      await route.close()
      runtime.dispose()
    }
  })

  // ── 新增：DNS rebinding 必须被挡住（Host 不在 loopback 允许清单 → 403）──
  await runCase('安全：DNS rebinding 被拒绝（Host/Origin 同为 evil.com → 403）', async () => {
    const cfg = mod.resolveConfig({ panelPort: 8899, autoStart: false, watchdogSecs: 0 })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(pkgDir))
    const route = await withRouteServer(runtime)
    try {
      // 复刻攻击：请求自带的 Host 与 Origin 一致，但都不是 loopback。
      // 旧实现只做「Origin host ↔ Host」自证，会放行；新实现按允许清单拒绝。
      const rebinding = await route.startRaw({
        host: 'evil.com:58567',
        origin: 'http://evil.com:58567',
      })
      assert(rebinding.status === 403, `DNS rebinding 期望 403，实际 ${rebinding.status}`)
      // 只换 Host 不改 Origin 也必须拒。
      const badHost = await route.startRaw({ host: 'evil.com:58567' })
      assert(badHost.status === 403, `非法 Host 期望 403，实际 ${badHost.status}`)
      // loopback 三个名字都应放行（含 [::1] 方括号形式），且 localhost 与 127.0.0.1 互通不算跨站。
      const lo = await route.startRaw({ host: '127.0.0.1:58567', origin: 'http://127.0.0.1:58567' })
      assert(lo.status === 200, `127.0.0.1 同源期望 200，实际 ${lo.status}`)
      const v6 = await route.startRaw({ host: '[::1]:58567', origin: 'http://[::1]:58567' })
      assert(v6.status === 200, `[::1] 同源期望 200，实际 ${v6.status}`)
      const mixed = await route.startRaw({
        host: '127.0.0.1:58567',
        origin: 'http://localhost:58567',
      })
      assert(mixed.status === 200, `localhost↔127.0.0.1 同端口应放行，实际 ${mixed.status}`)
      // 但端口不同必须拒（不同端口就是不同源）。
      const wrongPort = await route.startRaw({
        host: '127.0.0.1:58567',
        origin: 'http://127.0.0.1:9999',
      })
      assert(wrongPort.status === 403, `跨端口期望 403，实际 ${wrongPort.status}`)
      return 'rebinding 403 / loopback 与 localhost 互通 200 / 跨端口 403'
    } finally {
      await route.close()
      runtime.dispose()
    }
  })

  // ── 新增：允许清单可显式放行反代域名（N3 的替代方案）──
  await runCase('安全：trustedHosts 允许清单生效且默认不信任任意域名', () => {
    const d = mod.resolveConfig(undefined)
    assert(Array.isArray(d.trustedHosts) && d.trustedHosts.length === 0, '默认允许清单必须为空')
    const cfg = mod.resolveConfig({ trustedHosts: [' Panel.Local ', 'panel.local', ''] })
    assert(
      JSON.stringify(cfg.trustedHosts) === JSON.stringify(['panel.local']),
      `允许清单应归一化去重去空，实际 ${JSON.stringify(cfg.trustedHosts)}`,
    )
    return 'default=[] / normalize=ok'
  })

  // ── N2 修复：让 M1 的「让位 N 秒后兜底自启」分支真正被执行 ──
  // 用 config.launchctlBin 指向假 launchctl（恒 exit 0 ⇒ 判成 loaded）；repoRoot 指向不存在的目录，
  // 于是必然走到：loaded → 让位等待超时 → 写 error 日志 → preflight 报缺入口。
  // 全程不 spawn 真实面板（缺入口挡在 spawn 之前），断言 child 为 null。
  await runCase('让位分支：launchd loaded 但未拉起 → 超时兜底且 error 明确（不 spawn）', async () => {
    const port = await freePort()
    // 注意：shim 必须放在**工作区内**。DSH 沙箱允许工作区内生成的可执行脚本，
    // 而 os.tmpdir()（/tmp）下的脚本会 spawn 失败 → 判成 unknown，测不到 loaded 分支。
    const shimDir = fs.mkdtempSync(path.join(pkgDir, '.selftest-shim-'))
    const shim = path.join(shimDir, 'launchctl-fake')
    fs.writeFileSync(shim, '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    logs.length = 0
    const cfg = mod.resolveConfig({
      panelPort: port,
      repoRoot: '/tmp/dsh-yangyu-panel-selftest-does-not-exist',
      autoStart: false,
      watchdogSecs: 0,
      launchdLabel: 'com.example.selftest-loaded',
      launchctlBin: shim,
    })
    const runtime = mod.createRuntime(fakeCtx, cfg, mod.resolvePaths(cfg.repoRoot))
    const route = await withRouteServer(runtime)
    try {
      const started = await route.start()
      assert(runtime.internals.service.child === null, '兜底路径绝不能 spawn 子进程')
      assert(
        logs.some((l) => l.line.includes('让它在')),
        `未进入让位窗口分支，日志：${logs.map((l) => l.line).join(' | ')}`,
      )
      assert(
        logs.some((l) => l.line.includes('没有把面板拉起来')),
        `未进入兜底分支，日志：${logs.map((l) => l.line).join(' | ')}`,
      )
      // M1 的核心回归断言：绝不能 ready:false 且 error:null（旧的静默故障）
      assert(
        typeof started.panel.error === 'string' && started.panel.error !== '',
        `兜底后必须有明确 error，实际：${JSON.stringify(started.panel)}`,
      )
      return '让位 → 超时 → 兜底 → 缺入口（error 明确）'
    } finally {
      await route.close()
      runtime.dispose()
      fs.rmSync(shimDir, { recursive: true, force: true })
    }
  })

  await runCase('配置：startTimeoutMs 默认 30s 且可覆盖', () => {
    const d = mod.resolveConfig(undefined)
    assert(d.startTimeoutMs === 30_000, `startTimeoutMs 默认期望 30000，实际 ${d.startTimeoutMs}`)
    const o = mod.resolveConfig({ startTimeoutMs: 5_000 })
    assert(o.startTimeoutMs === 5_000, 'startTimeoutMs 覆盖未生效')
    return '默认 30000，可覆盖'
  })

  // ─── 汇总 ─────────────────────────────────────────────────
  const failed = results.filter((r) => r.outcome === 'fail')
  const skipped = results.filter((r) => r.outcome === 'skip')
  console.log('')
  console.log(`用例合计 ${results.length}：通过 ${results.length - failed.length - skipped.length}，失败 ${failed.length}，未执行 ${skipped.length}`)
  if (failed.length > 0) {
    console.log('结论：存在失败用例，未通过。')
    process.exit(1)
  }
  if (skipped.length > 0) {
    console.log('结论：有未执行用例，不得宣称「全部通过」。')
    process.exit(2)
  }
  console.log('结论：全部用例已执行且通过。')
  process.exit(0)
}

// 小工具：把 fs 动态 import 包一层，避免顶层 await 影响用例函数签名。
main().catch((error) => {
  console.error('自测脚本自身异常：', error)
  process.exit(1)
})
