# 对抗性验证报告 · dsh-plugin/yangyu-panel

- 验证者：`plugin-verifier`（独立验证者，非作者）
- 时间：2026-11-02 15:08–15:15（Asia/Shanghai）
- 受检产物：`/Users/mikejam/Documents/deepseek-harness/QQ_bot/dsh-plugin/yangyu-panel/`
- 参照实现：`/Users/mikejam/Documents/Codex/jishui-employment-service-platform/dsh-plugin/jishui-workbench/`
- 权威契约来源：本机 DSH 运行时 `@deepseek-ai/dsh-desktop-runtime` **0.2.1-rc.5**（`/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/`）+ `cordis_inspect_query` live 查询
- 判定：**有条件通过**（未发现阻塞级缺陷；live 复用路径与官方契约逐条对齐；有 3 项「中」级设计缺口与 6 项低级别问题）
- 红线遵守：只写了本文件；未杀进程、未动 launchd、未动 profile、未改插件源码、未 `POST /stop`、未自己起 `panel.mjs`

---

## 0. 总览表

| # | 核查项 | 结论 | 关键证据 |
| --- | --- | --- | --- |
| 1 | 静态审读（7 个文件） | 通过（有问题，见 §3） | 全文通读 |
| 2 | `webServer.register({kind,path,handler})` 契约 | 一致 | live `Service.listService` |
| 3 | `sidebar.panellist` 注册字段 | 一致 | 出厂源码 3 处同写法 |
| 4 | `main` keyed 槽 `key` 用法 | 一致 | 出厂源码 schedule 同写法 |
| 5 | `exports["./client"]` / `dsh.client` 解析 | 一致 | 出厂源码 `dsh-client-modules` |
| 6 | 自测脚本 | 9/9 通过、EXIT=0；存在 3 处「测试名大于断言」 | §4 |
| 7 | 面板是否真在跑（GET 8899） | 是，HTTP 200 + `<title>养鱼面板</title>` | `curl -D -` |
| 8 | launchd 任务是否 loaded | 是，`state = running, active count = 1` | `launchctl print` EXIT=0 |
| 9 | 会不会起第二个面板 / 杀 launchd 的面板 | **不会**（live 实证 + 控制流走查） | `status.managed=false`、无插件日志、仅 1 个 listener |
| 10 | 两个监督者抢端口重启风暴 | 存在**条件性**路径（见 M2） | 静态推演 + plist `KeepAlive` |
| 11 | iframe 被 X-Frame-Options / CSP 拦掉 | **不会**（8899 无任何 framing 头；DSH 侧无 `frame-src`） | `curl -D -`、`curl -sI` |
| 12 | live 项（status/start/404） | **已执行**（插件在我验证中途被装上） | §5 |
| 13 | sidebar occupant（client inspect） | **未能验证**（3 次 10s 超时） | §7 |

---

## 1. 静态审读

逐个读完 `index.js`（769 行）、`client.js`（576 行）、`package.json`、`cordis.patch.yml`、`locale/zh.json`、`locale/en.json`、`README.md`（110 行）、`icon.svg`、`scripts/selftest.mjs`（323 行）。目录清单：

```
-rw------- 7059  README.md
-rw------- 21927 client.js
-rw------- 653   cordis.patch.yml
-rw------- 461   icon.svg
-rw------- 24094 index.js
drwx------       locale/{zh,en}.json
-rw------- 1069  package.json
drwx------       scripts/selftest.mjs
```

---

## 2. 权威 API 逐条对齐（不凭印象）

### 2.1 host / `Service` / `listService` → `webServer`

live 返回（节选）：

```json
{"key":"webServer",
 "access":{"hardDependency":{"inject":["webServer"]}},
 "methods":[{"signature":"register(route: WebRoute): () => void", ...}]}
```
```ts
export interface WebRoute { kind: WebRouteKind; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>; }
export type WebRouteKind = 'exact' | 'prefix';
```

插件用法 `index.js:33`（`inject = ['webServer']`）、`index.js:144-148`：

```js
ctx.webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler: runtime.handler })
```

→ **一致**（kind/path/handler 三字段、返回 disposer 也被正确当作函数调用，`index.js:151`）。

**live 派发语义**（`dsh-host-webserver/lib/index.js` 字符偏移 381 / 494-505）：

```js
const rawPath = new URL(req.url ?? "/", "http://x").pathname;
const route = this.match(rawPath);
if (route !== void 0) { await route.handler(req, res); return; }
...
match(pathname){ const exact=this.exact.get(pathname); if (exact!==void 0) return exact;
  for (const [prefix, route] of this.prefixes){ if (pathname!==prefix && !pathname.startsWith(`${prefix}/`)) continue; ... } }
```

- **宿主不剥前缀、也不改写 `req.url`** → 插件「req.url 带完整前缀，自行剥掉」的判断**正确且必要**（`index.js:35-36`、`635-636`）。
  live 反证：`{"error":"未知路由：GET /yangyu-panel/nope"}` —— 插件收到的 `url.pathname` 确实是带前缀的完整路径。
- 前缀匹配形如 `pathname === prefix || pathname.startsWith(prefix + '/')`，插件写法与之一致。
- **无全局鉴权**：`handle()` 里 match 到就直接 `await route.handler(req,res)`，只有 `/api` 前缀路由自己在 handler 内做 `admit()`（`dsh-client-connection/lib/index.js` 偏移 859、1046）。见 §3 M3。
- `register` 对重复 `(kind,path)` **会 throw** → 重复安装会响亮失败，不会静默双注册。

### 2.2 client / `Slots` / `listSubTree`

`cordis_inspect_query(client, Slots, listSubTree)` **连续 3 次 10s 超时**（`Error: Slots.listSubTree: Client inspect query ... timed out after 10000ms`），无法取 live 视图。改用同一运行时（0.2.1-rc.5）出厂源码交叉核对：

- 槽结构（`dsh-client-ui-layout/lib/client.js` 偏移 623）：`root.children` 里 `sidebar` = **single**、`main` = **keyed**。
- `sidebar.panellist` 的注册字段（`dsh-client-ui-sidebar/lib/client.js` 偏移 34194 消费端）：
  ```js
  ctx.slots.entriesOfSlot("sidebar.panellist").map(({options}) => ({ id: options.id, order: options.order ?? 0, label: resolveSlotLabel(options.label, ...) }))
  ```
  官方同写法两处：
  ```js
  // dsh-client-ui-plugin-manager/lib/client.js 偏移 621964
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name:"sidebar.panellist", id:PANEL_ID, order:0,  label:()=>t("panel"), locale:NS }, PluginsPanelIcon));
  // dsh-client-ui-schedule/lib/client.js 偏移 324258
  ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({ name:"sidebar.panellist", id:PANEL_ID, order:10, locale:MANAGER_NS, label:()=>t("panel") }, TaskManagerIcon));
  ```
  插件 `client.js:245-256` 完全同形（`{name,id,order:30,label,locale}`）→ **一致**；`order:30` 排在官方 Plugins(0)、Scheduled(10) 之后，符合注释声明。
- `main` keyed 槽（`dsh-client-ui-schedule/lib/client.js` 偏移 324034）：
  ```js
  ctx.slots.inject("main", () => ctx.slots.register({ name:"main", key:PANEL_ID, locale:MANAGER_NS, inject:()=>({...}) }, TaskManagerPage));
  ```
  插件 `client.js:566-571` 同形（`inject: () => ({})`）→ **一致**。
  出厂 README 明确「同一个 id 寻址 `main` keyed slot 的组件；**选择不存在的主面板条目会抛错**」——因此 §2.2 两处只要有一处写错就会在点击时炸，这是本插件最关键的耦合点，已核对为正确。
- `ctx.locale.register(NS, {zh,en})` / `ctx.locale.bind(NS)`：出厂 `dsh-client-ui-layout` 同写法（`ctx.locale.register("shortcuts.layout",{zh,en})` + `ctx.locale.bind(...)`）→ 一致。
- `ctx.slots.inject(slot, () => ctx.slots.register(...))` 的返回形态：官方三处一致（另见 `dsh-client-ui-conversation` 用 generator，两种都被接受）→ 一致。

### 2.3 客户端半侧入口解析（对应核查项 5 / package.json）

`dsh-client-modules/lib/index.js`：

```js
// 偏移 171-181
const client = exportsField["./client"];
throw new Error(`client-modules: ${pkgName} exports["./client"] must be a string or an object with a string default`);
// 偏移 732-745
const decl = parseDshClient(packageName, dsh?.client);
if (decl === void 0 || decl.platform !== "web") { ... }
if (clientRel === void 0) throw new Error(`client-modules: ${packageName} declares dsh.client but exports no "./client" bundle`);
```

插件 `package.json:17-23`（`"./client": "./client.js"`）+ `package.json:41-45`（`platform:"web", immediately:true, inject:[]`）→ **满足**，且与参考插件逐字段相同：

| 字段 | yangyu-panel | jishui-workbench（已安装的参照件） |
| --- | --- | --- |
| `exports["."]` | `./index.js` | `./index.js` |
| `exports["./client"]` | `./client.js` | `./client.js` |
| `exports["./locale/*.json"]` / `./icon` / `./package.json` | 有 | 有 |
| `files[]` | 8 项（与参照完全同集） | 8 项 |
| `dsh.bundle.patch` | `./cordis.patch.yml` | `./cordis.patch.yml` |
| `dsh.client` | `{platform:web, immediately:true, inject:[]}` | 同 |
| `icon` / `main` / `type:module` | `./icon.svg` / `./index.js` / `module` | 同 |

`dsh.bundle.patch` 的语义由 `dsh-app-boot/lib/index.js`（偏移 23264/23687/23939）确认：字符串 → 单文件，数组 → 按序拼接 → 一致。

`window.__ModuleLoader__.load({id, factory(require){...}})`（`client.js:13-15`）：出厂 **所有**官方客户端 bundle 都用同一形态（如 `dsh-api-gateway/lib/client.browser.js`、`dsh-client-locale/lib/client.js` 均以 `window.__ModuleLoader__.load({ id: "...", factory: (require) => {...} })` 开头）；本插件 `factory(require){...}` 为等价的对象方法简写 → **一致**。

---

## 3. 发现（按严重度分级）

> 说明：**没有发现任何阻塞级缺陷。**「中」级为设计缺口/加固项，「低」级为文档失真与测试名不副实。

### M1（中）launchd「loaded 但没在跑」时，插件永久静默不就绪

- 位置：`index.js:479-489`
  ```js
  if (cfg.respectLaunchd && (await launchdJobLoaded(cfg.launchdLabel))) {
    service.ready = false; service.managed = false; service.error = null;   // ← 故意清空 error
    log('info', `端口 ${service.port} 空闲，但 launchd 任务 ... 处于 loaded 状态：交给它拉起，插件不重复启动`);
    return false;
  }
  ```
- 后果：端口空闲 + launchd 任务 loaded 时，插件**永远不自己拉起**，且 `error` 被显式置 null。若 launchd 那边因为任何原因不再拉起（plist `KeepAlive` 只覆盖 `SuccessfulExit=false`，即 `panel.mjs` 以 0 退出时 launchd **不会**重启；或任务被 throttle），则：
  - `GET /yangyu-panel/status` → `{"ready":false,"pid":null,"managed":false,"error":null}`，**没有任何原因可显示**；
  - 看门狗每 30 秒重试一次、每次写一行 info 日志（`index.js:606-611` + `622-623`），**无限增长**；
  - 用户点「启动」也走同一条让位分支 → 界面只剩 `启动已结束，但面板未就绪`（`client.js:350`），无细节。
- 与「DSH 在跑 → 面板也在跑」的产品目标直接冲突（依赖 launchd 自身的恢复能力）。
- 本机状态：`launchctl print gui/501/com.mikejam.yangyu-panel` → `state = running, active count = 1`，**当前不会触发**；触发条件是 launchd 侧恢复失败。
- 复现（**不要在生产上做**，仅给作者参考）：`launchctl bootout gui/501/com.mikejam.yangyu-panel` 后只 `bootstrap` 不 `kickstart`，或让 panel.mjs 以 code 0 退出。
- 建议：让位分支保留一个可上报的 `error/reason`（例如 `panel.startDeferredToLaunchd`），并对同一条让位 info 日志做去重。

### M2（中）后加入的 launchd 会让两个监督者抢端口 → launchd 侧重启风暴

- 位置：`index.js:480`（只在「**准备自己拉起之前**」检查 launchd）+ `panel.mjs:547`（`server.listen(PORT, HOST, cb)`，**全文件无 `server.on('error')`**）。
- 控制流：插件启动时 launchd 未 loaded（例如 §3 M1 的配置 B / 用户 `bootout` 过）→ 插件自己 spawn 面板并占住 8899（`managed=true`）→ 之后用户/系统把 `com.mikejam.yangyu-panel` 重新 `bootstrap`（plist `RunAtLoad=true`）→ launchd 再起一个 `panel.mjs` → **EADDRINUSE**。
  - panel.mjs 没有 `error` 监听 → Node 抛未捕获异常 → 该进程以非 0 退出；
  - plist `KeepAlive{SuccessfulExit:false}` → launchd 判定「非成功退出，必须重启」→ 再起 → 再 EADDRINUSE → **重启风暴**（launchd 有 10s 节流，但会持续）；
  - 插件侧 `probe()` 因为**自己的**实例在答而一直 ready，`status.managed=true`，**完全察觉不到**第二个监督者的存在。
- 反向（更常见、危害更小）：launchd 已占用 8899 时插件 spawn → 插件的子进程 EADDRINUSE 崩掉 → `child.on('exit')` 写 `service.error`（`index.js:378-383`）→ 随后 `refresh()` 因为 probe 成功又把 `error` 清空（`index.js:576-584`）→ **status 全绿，只在 `panel/data/dsh-plugin-panel.log` 里留下崩溃记录**。属「静默掩盖」。
- 本机当前不触发：`managed=false` + 只有一个 listener + 无插件日志，说明插件走的是复用路径、**没有 spawn**。
- 建议：spawn 后（或看门狗 tick 里）再检测一次 launchd loaded，若此时已 loaded 且自己占着端口，就主动退回复用（`managed=false`）并上报一条 warning。

### M3（中）`/yangyu-panel/*` 是无鉴权的状态变更端点

- 证据（live）：
  ```
  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:58567/yangyu-panel/status   → 200   （未带任何 cookie）
  ```
  对比 `curl http://127.0.0.1:58567/` → **401 Unauthorized**（fallback SPA handler 自己做 `BrowserAuth`）。
- 机制：web server 派发不给命名路由加鉴权（§2.1），插件 handler（`index.js:631-669`）也不看 `Origin`/`Sec-Fetch-*`。
- 影响面有限（故不判高）：58567 只 bind `127.0.0.1`（`lsof -nP -iTCP:58567 -sTCP:LISTEN` → `TCP 127.0.0.1:58567`），且 `/start` 幂等、`/stop` 对 launchd 管的面板拒杀（§3 走查），最坏是「正好是插件自己拉起的面板被跨站 POST /stop 杀掉，30 秒内被看门狗拉回」。
- 建议：handler 头部做一次 `Origin`/`Sec-Fetch-Site` 校验，或要求一次性 token（客户端 fetch 是同源，加 token 无成本）。

### L1（低）宿主启动超时 30s 与 UI 文案 60s 不一致，且该配置项未文档化

- `index.js:428` / `440`：`Number(cfg.startTimeoutMs) || 30_000` —— `startTimeoutMs` **不在 `DEFAULTS`（`index.js:42-55`）、不在 README 配置表（`README.md:41-50`）**。
- `client.js:30` `MAX_WAIT_MS = 60000`；`locale/zh.json:21` + `client.js:54` 文案「启动超时（60 秒）」。
- 后果：宿主 30s 就放弃并写入 `error`，客户端立刻走 `startReturned` 分支显示 `失败 — 面板在 30 秒内未就绪`（`client.js:349-357`）→ 那条「启动超时（60 秒）」文案在正常情况下**永远不会出现**；用户看到的时间语义与文档不符。
- 建议：把 `startTimeoutMs` 写进 `DEFAULTS` + README，并把默认值对齐到 60s（或把文案改成 30s）。

### L2（低）README 排错表关于看门狗的描述是错的

- `README.md:89`：「看门狗只在 `watchdogSecs > 0` **且 `autoStart`** 时自愈」。
- 代码：`apply()` 里 `runtime.startWatchdog()` **无条件**注册（`index.js:159-162`），`startWatchdog()` 只判断 `secs > 0`（`index.js:603-611`）。
- 即：`autoStart:false` + `watchdogSecs:30` 时看门狗**仍会自动拉起面板**。代码里 `index.js:175` 的注释（「等待 POST /start **或看门狗触发**」）才是对的。
- 建议：删掉 README 里的「且 `autoStart`」。

### L3（低）`onHostExit` 是死代码，`stopOnHostExit` 的「宿主退出」语义只在 dispose 路径成立

- `index.js:673-678` 定义 `onHostExit()`，`index.js:704` 导出；**全文再无调用点，`apply()` 也没把它挂到任何宿主退出钩子**（`grep -n "onHostExit" index.js` → 仅 673/704）。
- 实际生效的是 `dispose()`（`index.js:680-696`）里那段重复逻辑。
- 后果：进程被 SIGKILL / 崩溃时不会回收（默认 `stopOnHostExit:false` 所以无实际影响）；但 README:47 的「插件卸载/**宿主退出**时是否回收」在「宿主退出」这半句上不成立。
- 建议：要么接上宿主退出事件，要么删掉 `onHostExit` 并把 README 改成「插件卸载时」。

### L4（低）「在内置浏览器打开」按钮在 `browser` tab 类型未注册时是死按钮

- 插件判断条件只查 `ctx.sidebarRight.openTab` 是否是函数（`client.js:412-415`），随后直接调用：
  ```js
  right.openTab('browser', { params: { url: frameUrl } })   // client.js:436
  ```
- 官方同类调用的**前置条件更严**（`dsh-client-ui-chat/lib/client.js` 偏移 590686）：
  ```js
  if (linkOpening.getSnapshot() === "sidebar" && ctx.get("sidebarRightTabs")?.get("browser") !== void 0) ctx.sidebarRight.openTab("browser", {...})
  ```
- 且未注册 kind 会 **throw**（`dsh-client-ui-sidebar-right/lib/client.js` 偏移 98837）：
  ```js
  placeTab(...){ const definition = this.tabs.get(kind); if (definition === void 0) throw new Error(`sidebarRight: no tab type is registered as "${kind}"`); }
  ```
- live：`Config.listConfigs{name:"@deepseek-ai/dsh-client-ui-sidebar-browser"}` → `{"patchId":"ui-sidebar-browser","status":"absent"}`；其 README 明确该条目需 profile patch 里 `disabled: false` 才启用。
- 后果：点击该按钮时抛错被 `safeGet()`（`client.js:136-142`、`432-439`）吞掉 → **按钮在、点了没反应**（不会白屏）。
- 客观说明：参考插件 `jishui-workbench/client.js:441` **一模一样**，属继承自参照实现的既有问题，不是本次新引入；且该判断依赖 client 侧 inspect（本次超时）才能最终坐实 `browser` kind 是否注册。
- 建议：与官方一致，加 `ctx.get('sidebarRightTabs')?.get('browser')` 判断后再决定是否渲染按钮。

### L5（低）自测脚本：3 处「断言小于用例名」

1. `selftest.mjs:275-295` 用例名写「路由：GET / 列路由，未知路径 404，**非 GET/ POST 不外泄**」，但**全程没有发过 PUT/DELETE/PATCH 请求**（只发了 `GET /` 与 `GET /nope`）→ 该断言项不存在。
2. **完全没有覆盖**：`stopService()` 的杀进程路径（`killGroup`/SIGTERM/SIGKILL，`index.js:528-559`）、`POST /stop` 路由、`dispose()`/`onHostExit`（`index.js:671-696`）、并发 `start` 合流（`index.js:509-526`）、看门狗 tick。全项目最「危险」的代码恰好一行没测。
3. `selftest.mjs:314-318` 的 `await0()` 是死代码，从未被调用。

### L6（低）硬编码绝对路径（可移植性，仅供参考）

`index.js:39` `DEFAULT_REPO_ROOT = '/Users/mikejam/Documents/deepseek-harness/QQ_bot'`；`cordis.patch.yml` 未覆写 `repoRoot`。换机器/换目录即失效。README:43 已说明可配 —— 仅作提示，本机场景无碍。

---

## 4. 亲手跑自测（原样输出）

命令与结果（`cd /Users/mikejam/Documents/deepseek-harness/QQ_bot/dsh-plugin/yangyu-panel && node scripts/selftest.mjs; echo EXIT=$?`）：

```
✅ 语法检查 index.js / client.js — node --check 通过
✅ 宿主导出面完整 — inject=[webServer]
✅ resolveConfig：默认值 + 非法值兜底 — 默认与兜底均符合预期
✅ resolvePaths：由 repoRoot 推导出真实存在的入口 — panelEntry=/Users/mikejam/Documents/deepseek-harness/QQ_bot/panel/panel.mjs
✅ resolveNodeBin：能在本机找到 node — /opt/homebrew/bin/node
✅ 复用分支：已就绪面板 → ready=true / managed=false / 不 spawn — port=51263 pid=null
✅ 冲突分支：端口被陌生服务占用 → 报错且不 spawn — 端口 51270 已被其他进程占用，且响应不满足面板就绪判据；请先释放该端口或改…
✅ 守卫分支：空闲端口不越权启动（让位 launchd 或报缺入口） — 分支=让位 launchd（已 loaded）
✅ 路由：GET / 列路由，未知路径 404，非 GET/ POST 不外泄 — GET  /yangyu-panel/status | POST /yangyu-panel/start | POST /yangyu-panel/stop

用例合计 9：通过 9，失败 0，未执行 0
结论：全部用例已执行且通过。
EXIT=0
```

**是否「恒真假用例」的逐项判断：**

| 用例 | 真能失败？ | 依据 |
| --- | --- | --- |
| 语法检查 | 能 | `spawnSync(node --check)` 断言 `status===0` |
| 宿主导出面 | 能 | 逐项断言 `name`/`inject`/5 个导出 |
| resolveConfig | 能 | 断言 6 个默认值 + 3 个兜底 + `watchdogSecs:0` 合法 |
| resolvePaths | 能 | 断言真实存在 `panel/panel.mjs`（本机存在） |
| resolveNodeBin | 能 | 断言非空字符串 |
| 复用分支 | 能 | 起真假面板服务（返回含「养鱼面板」的 HTML），断言 `ready===true`/`managed===false`/`child===null` |
| 冲突分支 | 能 | 起陌生服务（HTML 不含判据），断言报「已被其他进程占用」/`child===null` |
| 守卫分支 | **半恒真** | 断言是 `missing \|\| deferred`：本机 launchd loaded，永远走 `deferred`（输出自证「分支=让位 launchd（已 loaded）」），`missing` 那半边在本机**不可达**；不是假通过，但覆盖度被环境锁死 |
| 路由 | 能（但名大于实） | 见 §3 L5.1 |

**「前置条件未满足却输出全部通过」的核查结论：** 未发现。
- 分支脚本里 `skipped` 计数存在（`selftest.mjs:299-309`），有未执行项会 `exit 2` 并打印「不得宣称『全部通过』」，符合工作区硬规则。
- 所有涉及 spawn 的路径都用「假上游 + 不存在的 repoRoot」堵死，并逐个断言 `service.child === null`（`selftest.mjs:217/240/264`）——**我实际验证了这一点**：跑完自测后 `ps`/端口感应显示插件从未写出 `panel/data/dsh-plugin-panel.log`（该文件至今不存在），面板只有 launchd 的 8939 一个 listener。
- 唯一「名大于实」的三处见 §3 L5，但都属**覆盖不足**，不属**假通过**。

---

## 5. live 项（插件在我验证途中被装上）

时间线：15:11 我查到 `GET /yangyu-panel/status → 404`、profile 里 0 处 `yangyu`；15:13 复查时已变为 200 / profile 2 处。**因此 live 项已执行**，但「安装前」的 404 也如实记录。

### 5.1 安装落点

```
$ grep -n yangyu ~/.dsh/profiles/desktop/package.json
14:    "dsh-yangyu-panel": "link:/Users/mikejam/Documents/deepseek-harness/QQ_bot/dsh-plugin/yangyu-panel",
43:        "dsh-yangyu-panel"
```
→ 与参考插件 `dsh-jishui-workbench` 的安装形态（`link:` + 出现在 `dsh.profile.bundles`）完全一致。

### 5.2 `GET /yangyu-panel/status`

```
HTTP/1.1 200 OK
content-type: application/json; charset=utf-8
cache-control: no-store
content-length: 141

{"panel":{"ready":true,"port":8899,"pid":null,"managed":false,"error":null},"url":"http://127.0.0.1:8899/","starting":false,"autoStart":true}
```
**这是本次最关键的 live 证据**：`ready:true` + `managed:false` + `pid:null` ⇒ 插件识别为「复用 launchd 的面板」，**没有 spawn 自己的进程**，因此 `POST /stop` 走的是拒杀分支（`index.js:530-539`）。

### 5.3 `GET /yangyu-panel/`

```
{"plugin":"dsh-yangyu-panel","routes":["GET  /yangyu-panel/status","POST /yangyu-panel/start","POST /yangyu-panel/stop"]}
```

### 5.4 `POST /yangyu-panel/start`（幂等复用路径，安全操作）

```
HTTP/1.1 200 OK
{"panel":{"ready":true,"port":8899,"pid":null,"managed":false,"error":null},"url":"http://127.0.0.1:8899/","starting":false,"autoStart":true}
```
**未起第二个实例的旁证（同刻采集）：**
```
$ curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8899/   → 200
$ lsof -nP -iTCP:8899 -sTCP:LISTEN
node    8939 mikejam   12u  IPv4 0x31524a9d9d79394a  0t0  TCP 127.0.0.1:8899 (LISTEN)   ← 只有一个
$ ls panel/data/ | grep dsh-plugin    → 无 panel/data/dsh-plugin-panel.log（插件从未 spawn）
```

### 5.5 `GET /yangyu-panel/nope`

```
GET /yangyu-panel/nope -> 404
body: {"error":"未知路由：GET /yangyu-panel/nope"}     ← 插件自己的 JSON 404（对比：未安装时 404 是空体）
```

### 5.6 sidebar occupant（`cordis_inspect_query` client / Slots / listSubTree）

```
$ listSubTree {"root":"sidebar.panellist"}  → Error: timed out after 10000ms   （×3，15:09 / 15:10 / 15:13）
```
**未能验证**，见 §7。间接证据：`dsh-client-modules` 在组合期用 `readFileSync(record.meta.clientPath)` 读取客户端产物，失败会抛 `MissingClientBundleError` → 汇总成 `ClientPackageCompositionError` 让插件加载失败；而本插件宿主半侧已正常加载并对外提供路由 ⇒ 客户端 bundle 的解析/读取**大概率已成功**（推理，非直接观测）。

---

## 6. 对抗性证伪逐条结论

### 6.a 面板当前是否真在跑 —— **是**

```
$ curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8899/     → 200
$ curl -s http://127.0.0.1:8899/ | head -c 200
<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<!-- B站图床会按 Referer 防盗链，不…
$ curl -s http://127.0.0.1:8899/ | grep -o '<title>[^<]*</title>'  → <title>养鱼面板</title>
```
与插件就绪判据 `READY_MARK = '养鱼面板'`（`index.js:58`）+ `status===200`（`index.js:238-239`）**完全吻合**。

### 6.b launchd 任务是否 loaded —— **是**

```
$ launchctl print gui/501/com.mikejam.yangyu-panel | head -20
gui/501/com.mikejam.yangyu-panel = {
	active count = 1
	path = /Users/mikejam/Library/LaunchAgents/com.mikejam.yangyu-panel.plist
	type = LaunchAgent
	state = running
	program = /opt/homebrew/bin/node
	arguments = { /opt/homebrew/bin/node  /Users/mikejam/Documents/deepseek-harness/QQ_bot/panel/panel.mjs }
	working directory = /Users/mikejam/Documents/deepseek-harness/QQ_bot/panel
	...
$ launchctl print ... >/dev/null; echo EXIT=$?   → EXIT=0
```
⇒ 插件的让位判据 `launchdJobLoaded()`（`launchctl print` 退出码 0，`index.js:294-297`）**在本机会返回 true**，即 `ensure()` 必走让位/reuse，不会抢。

### 6.c 控制流逐路径走查：会不会起第二个面板 / 杀 launchd 的面板 / 重启风暴

注入状态：`autoStart:true, respectLaunchd:true, launchdLabel:com.mikejam.yangyu-panel, watchdogSecs:30, stopOnHostExit:false`。

| # | 路径 | 控制流 | 后果 | 判定 |
| --- | --- | --- | --- | --- |
| c1 | 插件加载（本机实况） | `apply`→`start('插件加载')`→`ensure`：`probe()` true → `index.js:456-460` 直接 return true | `managed` 保持 false、`child` 为 null | **不起第二个**（live §5.2 实证） |
| c2 | 面板掉线，看门狗 tick | `probe` false → `service.child` null → `ensure`：`isPortInUse` false → `launchdJobLoaded` **true** → `index.js:480-489` 让位 return false | 由 launchd 拉起；插件只记一行 info | **不起第二个**（但见 M1：launchd 不扛时永久不就绪） |
| c3 | launchd 在启动途中（端口还没绑） | `probe` false → `isPortInUse` false → `launchdJobLoaded` true → 让位 | 安全 | **不起第二个** |
| c4 | 端口被陌生人占 | `isPortInUse` true → `settleBusyPort` 3×0.9s 仍不满足 → `index.js:473-476` 报错 return false | 如实报错，**不 spawn** | 安全（selftest 覆盖） |
| c5 | `POST /stop`（复用态） | `stopService`：`service.child` 为 null → `index.js:530-539` 走「不杀」分支 | 只刷新状态，报错文案提示需用插件外方式 | **不杀 launchd 的面板** ✅ |
| c6 | `POST /stop`（插件自管态） | `managed` true + `child` 非空 → `index.js:541-559`：`waitExit` → `killGroup(pid,'SIGTERM')`（`-pid` 整组）→ 8s 后 SIGKILL | 只杀**自己** spawn 的进程组。因为 spawn 时 `detached:true`（`index.js:341`），pgid==child.pid，`-pid` 不会波及其他进程 | 安全 |
| c7 | `dispose()` / `stopOnHostExit` | `index.js:680-696`：仅当 `cfg.stopOnHostExit && service.child && service.managed` 才杀 | 默认 false ⇒ 面板不受 DSH 生命周期影响 | 安全（但 `onHostExit` 是死代码，见 L3） |
| c8 | **watchdogTick 与 POST /start 并发** | `watchdogTick`（`index.js:613-627`）**不设置也不检查 `startPromise`/`starting`**，只查 `starting`；而 `starting` 只在 `start()`（`index.js:509-526`）里置位。若一次 tick 正卡在 `ensure()` 的 await 链里（probe 2s + isPortInUse 0.6s + `launchctl print` 最多 2.5s）而此刻恰好进来一个 `POST /start`，两者会**同时**执行 `ensure()`，都可能通过「端口空闲」判定 → **两次 `spawnPanel()`**（`index.js:504`） | 第二个实例必崩（`panel.mjs:547` 无 `error` 处理 → EADDRINUSE 未捕获）→ 插件侧再 `refresh()` 把 error 清空，**静默掩盖** | **存在理论双 spawn 窗口**（窄，且本机被 launchd 让位分支掩盖）——与 M2 的机制同源 |
| c9 | launchd 后加入 | 见 M2 | **重启风暴** | **存在** |

**结论：**「杀 launchd 的面板」这条路**不存在**（c5/c6 双重保险 + live `managed:false` 实证）；「起第二个面板」在**当前配置与本机状态**下**不会发生**（c1 实证 + c2/c3 让位）；但在 c8（并发）与 M2（后加入 launchd）两条窄路径上存在真实的双实例可能，且失败会被静默掩盖。

### 6.d iframe 会不会被 X-Frame-Options / CSP 拦掉 —— **不会**

```
$ curl -sI http://127.0.0.1:8899/
HTTP/1.1 403 Forbidden           ← HEAD 被拒（与任务描述一致）
Content-Type: application/json; charset=utf-8
Cache-Control: no-store

$ curl -s -D - -o /dev/null http://127.0.0.1:8899/        （GET）
HTTP/1.1 200 OK
Content-Type: text/html; charset=utf-8
Cache-Control: no-cache
Transfer-Encoding: chunked
（无 X-Frame-Options，无 Content-Security-Policy，无 frame-ancestors）

$ curl -s http://127.0.0.1:8899/ | grep -i -E 'frame|csp|policy|content-security'   → 无匹配
$ grep -rn -i 'window.top|frameElement|X-Frame|frame-ancestors' panel/public/ panel/panel.mjs   → 无匹配（无 frame-busting）
```
- 8899 侧：**零 framing 限制 + 零 frame-busting** ⇒ 可被嵌入。
- 父文档侧（58567）：`curl -sD - http://127.0.0.1:58567/` 返回 **401 + 68 字节空体**，响应头里**没有** `Content-Security-Policy` / `X-Frame-Options`。**注**：这一条只能证明「未认证时 58567 的响应没有 CSP 头」；无法证明「认证后返回的 index.html（含 meta 形式 CSP）没有 `frame-src` 约束」，归入 §7 未能验证。
- `HEAD 403` 对 iframe **无影响**（浏览器 iframe 用 GET）；已实测 GET 200。
- 跨源但**同站**（`127.0.0.1:58567` vs `127.0.0.1:8899`）⇒ `SameSite=Lax/Strict` cookie 仍会随 iframe 子请求发送，不存在被 SameSite 拦掉的问题。

### 6.e `package.json` 的 `dsh.client` / `exports` / `files` 是否足够宿主找到 `client.js` —— **足够**

见 §2.3：字段值与参考插件逐字段相同，且与 `dsh-client-modules` 的解析代码（`exports["./client"]` 必须是 string 或 `{default:string}`；`dsh.client.platform` 必须是 `"web"`；缺 `./client` 会 throw）逐条吻合。

---

## 7. 未能验证（明确清单）

1. **client 侧 live 槽视图**：`cordis_inspect_query(platform=client, provider=Slots, method=listSubTree, {"root":"sidebar.panellist"})` 与 `{"root":"main"}` **各尝试多次、每次 10s 超时**（`Client inspect query ... timed out after 10000ms`，附带提示「Open or reconnect the Harness page」）。因此 **`sidebar.panellist` occupants 里是否真的出现 id 为 `yangyu-panel` 的一项，未直接观测到**；`main` keyed 槽的 live `key` 同理。改用同版本出厂源码交叉核对（§2.2）。
2. **浏览器端视觉结果**：左栏小鱼图标是否渲染、点击后主区是否真的出现整页 iframe、工具条与 6px 感应条的交互 —— 未截图、未视觉验证。
3. **`POST /stop`**：按红线**未执行**。因此「复用路径不杀进程」是**代码走查 + `status.managed=false` 推断**，没有做破坏性实证。
4. **`stopOnHostExit=true` 的回收路径**、以及 `dispose()` 实际被触发的行为：需要改 profile 或卸载插件，红线禁止。
5. **M1 的触发态**（launchd loaded 但没在跑）：需要 `bootout`/让 panel.mjs 以 code 0 退出，红线禁止动 launchd，仅静态推演 + selftest 的 loaded 分支间接覆盖。
6. **认证后 index.html 的 CSP/meta**：`GET http://127.0.0.1:58567/` 返回 401（body 68 字节），未能读到真实页面，因此「58567 侧是否存在 CSP」只证明到「未认证响应无 CSP 头」。
7. **`window.__DSH_BOOT__` 里是否包含本插件行**：需要认证 cookie 的 index.html，未取（不碰凭据）。用 `dsh-client-modules` 的组合期 `readFileSync` + 加载成功这一间接事实替代。
8. **PID 8939 的父进程是否为 launchd**：`ps -o pid,ppid ...` 被沙箱拒绝（`bash: /bin/ps: Operation not permitted`）；`launchctl print` 显示 `state = running, active count = 1` 属间接足够。
9. **`launchctl print` 的让位判据在「任务存在但未 loaded」时**：未构造该状态（需动 launchd）。

---

## 8. 判定与建议

**总体判定：有条件通过。**

- **通过的部分（有实证）**：宿主 `webServer.register` 契约、`sidebar.panellist` / `main` 注册形状、客户端 bundle 解析字段、就绪判据与真实面板、复用不抢端口、复用不杀进程、路由前缀剥离、404 语义、iframe 不被 framing 头拦住 —— 逐条对齐且 live 可复现。
- **条件**：以下三项建议在「宣称交付完成」前处理（都可小改，且不影响现有运行）：
  1. **M1**：让位 launchd 时不要清空 error（保留可上报原因 + 日志去重）—— 这是唯一会**破坏「DSH 在跑 → 面板也在跑」目标**的缺口；
  2. **M2 + c8**：spawn 前后各复查一次 launchd，并让 `watchdogTick` 复用 `startPromise` 互斥，堵住双 spawn / 双监督者；
  3. **M3**：给 `/yangyu-panel/*` 加一次同源校验。
- **可以只记不修的**：L1/L2/L3/L4/L5/L6（文档失真、死代码、死按钮、测试名不实、硬编码路径）。其中 **L2 与 L3 属于 README 说了假话**，建议顺手改掉，免得下次排错被误导。

---

# 第二轮复验（2026-11-02 15:27–15:45）· 修复验收

> 第一轮的正文与证据**原样保留在上方**，本节只做追加。方法不变：不采信作者自述，一切以亲手跑出的证据 + 与出厂源码/live 契约的对齐为准。
> 红线遵守：只写本文件；未杀进程、未动 launchd、未动 profile、未改插件源码、未 `POST /stop`。本轮所有 POST 都打在幂等的 `/start` 上（且 launchd 面板已就绪 ⇒ 纯复用路径）。

## R2.0 本轮采集到的事实

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 插件仍启用 | 是 | `~/.dsh/profiles/desktop/package.json:14` link 依赖 + `:43` bundles |
| `startTimeoutMs` 默认 30000、可否覆盖 | 是 | `selftest` 用例「配置：startTimeoutMs…」通过；`index.js:42-57` DEFAULTS 含 `startTimeoutMs: 30_000` |
| `startTimeoutMs` 是否真被 `waitReady` 使用 | 是 | `index.js:453-454` `Number(cfg.startTimeoutMs) \|\| DEFAULT_START_TIMEOUT_MS` |
| 自测 | 11/11，EXIT=0，2.871s | 见 R2.3 |
| panel.mjs 语法 | OK | `node --check panel/panel.mjs` |
| live 路由 | 200 | `GET /yangyu-panel/` 返回路由表；`/nope` → 插件 JSON 404 |
| 面板实例数 | **仍只有 1 个** | `lsof` → 仅 `node 8939` 监听 8899 |
| 插件是否 spawn 过 | **否** | `panel/data/dsh-plugin-panel.log` 至今不存在 |
| status | `ready:true / pid:null / managed:false / error:null` | 全程未变 |

## R2.1 修复逐条验收（对作者清单，逐条给证据）

| 编号 | 声称的修复 | 验收 | 证据（file:line / 命令） |
| --- | --- | --- | --- |
| M1 | 让位分支不再静默 | **成立** | `index.js:519-542`：`launchdJobState` → `loaded` 时先 `waitForReady(8000)`，超时写 error 级日志「改由插件兜底启动」并落到 `preflight`/`spawnPanel`。**不再有 `ready:false && error:null` 的出口**（该分支两条出口：`waitForReady` 成功→`ready=true`；失败→至少 `preflight` 的 `error`）。selftest 新增硬断言「ready:false 时必须有明确 error」（`selftest.mjs:279-282`） |
| M2 | EADDRINUSE 不再崩/风暴 | **成立** | `git diff panel/panel.mjs` 新增 `server.on('error')`，**位于 `server.listen` 之前**；EADDRINUSE → `process.exit(0)`，其它 → `exit(1)`。语义侧证（man page）见 R2.2 |
| c8 | 双 spawn 窗口 | **成立** | `index.js:667-679`：`watchdogTick` 首行 `if (disposed \|\| starting \|\| startPromise) return`，末尾 `await start('看门狗自愈')`（不再直接 `ensure`）⇒ 与 HTTP `/start` 共用 `startPromise` 互斥（`index.js:563-580`） |
| M3 | 无鉴权 → 同源校验 | **成立（但有残留缺口，见 R2.4-N1）** | `index.js:697-717` `isSameOrigin` + `index.js:730-733` 只对 POST 生效；live 决策矩阵见 R2.2 |
| L1 | 超时文案 30s | **成立** | `index.js:50-51` 进 DEFAULTS；`README.md:47` 新增该行；`locale/zh.json:21` / `locale/en.json:21` 改 30 秒；`client.js:30` `MAX_WAIT_MS=60000` 作为客户端包络 ≥ 宿主 30s（注释 `client.js:31` 说明了这层关系） |
| L2 | README 看门狗描述 | **成立** | `README.md:90` 改为「看门狗只要 `watchdogSecs > 0` 就会跑（与 `autoStart` 无关）」，与 `index.js:657-665`（`startWatchdog` 只看 secs）一致；并写明了 8 秒让位与 unknown 分支 |
| L3 | `onHostExit` 死代码 | **成立** | `index.js:169` `process.on('exit', runtime.onHostExit)`；`index.js:170-173` cleanup 里 `removeListener('exit', runtime.onHostExit)`（**同一函数引用**，不会泄漏监听器）；`index.js:767-772` 仍以 `cfg.stopOnHostExit` 开头短路 |
| L4 | `openTab` 死按钮 | **成立** | `client.js:432-450`：先 `try { right.openTab('browser', …); return true }`，`usedBuiltin` 为假再 `window.open(frameUrl,'_blank','noopener,noreferrer')`；`client.js:519-523` 去掉了错误的 `canOpenTab` 预判，按钮改为常显（`disabled: !ready`） |
| L5 | 测试名/覆盖 | **部分成立** | PUT 用例现在**真的发 PUT**（`selftest.mjs:305-306`）；新增跨站 CSRF 用例（`:315-334`）与 `startTimeoutMs` 用例（`:337-343`）；`await0` 死代码已删。**但**：守卫用例改成用不存在的 label，反而把 M1 的让位窗口代码排除在覆盖之外，见 R2.4-N2；`stopService`/`dispose` 仍零覆盖（第一轮 L5.2 未修） |
| 三态 | launchd 判据 loaded/absent/unknown | **成立** | `index.js:280-319` `launchdJobState` 返回三态；`unknown` 时 `index.js:521-526` 写 error 日志再继续自启。安全性论证：到达 `unknown` 自启分支**必须先通过步骤 3 的 `isPortInUse` 判定**（`index.js:501-512`），即端口必须空闲 ⇒ 不存在「launchd 面板在跑却又多起一个」的路径 |

## R2.2 四项特别对抗性核查（作者点名）

### Q1 `isSameOrigin` 会不会误伤 DSH 自己页面的合法调用 —— **不会误伤（已实测），但防御强度不如 DSH 自己的 fence**

**实测决策矩阵**（每次真实 HTTP POST 到 live 的 `/yangyu-panel/start`，不带任何 cookie；curl 的 `Host` 由 URL 自动生成为 `127.0.0.1:58567`）：

```
① 无任何头（curl 基线）                                  -> 200
② Origin: http://127.0.0.1:58567                       -> 200   ← 浏览器同源 POST 的指纹
③ Origin 同源 + Sec-Fetch-Site: same-origin
   + Sec-Fetch-Mode: cors + Sec-Fetch-Dest: empty       -> 200   ← 浏览器完整指纹
④ Origin: https://evil.com                              -> 403
⑤ Origin: null                                          -> 403
⑥ 无 Origin + Sec-Fetch-Site: cross-site                -> 403
⑦ 无 Origin + Sec-Fetch-Site: same-origin               -> 200
⑧ Origin 同源 + Sec-Fetch-Site: cross-site              -> 200   （Origin 存在时跳过 site 校验）
⑨ Host: evil.com:58567 + Origin: http://evil.com:58567  -> 200   ← DNS rebinding（见 N1）
⑩ Host: localhost:58567 + Origin: http://localhost:58567 -> 200
GET /status ＋ Origin: https://evil.com                 -> 200   （只读探针，设计上宽松）
```

**为什么不会误伤（三条互补证据）**：
1. **端口一致性**：结果 ②③⑩ 说明 `new URL(origin).host` 与 `req.headers.host` 在「带端口 / 换主机名」两种形态下都能对上。作者担心的「Host 带端口而 Origin 不带」在非默认端口下不会发生——浏览器序列化 Origin 时会带上非默认端口，HTTP/1.1 的 `Host` 同样带端口，两侧都是 `host:port`；本机 live 实测 ② 为 200 即是直接反证。
2. **浏览器到底发不发 Origin**：三种可能（发真实 Origin / 不发 / 发 `null`）里，前两种分别命中 ② 与 ①⑦，**都是 200**；唯一会被拒的 `Origin: null`（⑤）需要文档 referrer policy 为 `no-referrer`。已核对：DSH 的 `dist/index.html` **没有** `<meta name="referrer">`、也**没有** CSP；`Referrer-Policy: no-referrer` 只出现在 `/connect` 认证流程的 **303/302 重定向响应**上（`dsh-client-connection/lib/index.js` 字符偏移 21010 / 21394 / 23228），**不在 index 的 200 响应上**（`dsh-host-frontend-static/lib/index.js:73` 只写 `content-type`）。⇒ `null` 分支不会被合法客户端命中。
3. **同一页面上的 DSH 自身 API 反证**：DSH 的 `/api` 前缀路由套着更严的信任闸门（`dsh-client-connection` README：「附带的 HTTP(S) `Origin` 必须指向同一 authority；`sec-fetch-site: cross-site` 一律拒绝。Host/Origin 校验失败返回 **403**」）。既然这一整套 GUI（会话、装插件、工具调用）在本机工作正常，就说明浏览器从 58567 页面发的 POST **不是** `Origin: null`。插件这一侧接受的就是同一个 (Origin, Host) 组合。

**结论**：M3 的修复对合法客户端**零误伤**；`isSameOrigin` 的宽松侧（无 Origin 无法鉴别的本机进程）是刻意的，且只读的 `GET /status` 保持宽松符合设计。

### Q2 兜底自启 + `exit(0)` 会不会形成循环 —— **不会**

控制流（launchd loaded 但 plist 不重启它，端口空闲）：
1. `ensure`→`probe()` false（`index.js:492`）→ `service.child` 为 null（`:497`）→ `isPortInUse` false（`:501`）→ `launchdJobState` = `loaded`（`:520`）
2. `waitForReady(8000)` 打满 8s 仍 false（`:534`）→ 写 error 日志（`:538-541`）
3. `preflight()` OK（`:546`）→ `spawnPanel()`（`:558`）→ **此端口空闲，panel.mjs 正常 bind，不会触发 EADDRINUSE**（`panel.mjs` 新增的 error handler 根本不会被走到）
4. `waitReady()` → probe 200 + `<title>养鱼面板</title>` → `ready=true`
5. 之后 launchd 若被 `kickstart`：它的实例 EADDRINUSE → `exit(0)` → **不重启**（语义见下）⇒ 无风暴

**man page 引文（决定性）**：
> **SuccessfulExit <boolean>** — If true, the job will be restarted as long as the program exits and with an exit status of zero. **If false, the job will be restarted in the inverse condition.**
> （来源：[launchd.plist(5)](https://keith.github.io/xcode-man-pages/launchd.plist.5.html)）

本机 plist 是 `KeepAlive{SuccessfulExit:false}`（`~/Library/LaunchAgents/com.mikejam.yangyu-panel.plist:20-24`）⇒ 只有当退出状态**非 0**（即失败）才会重启 ⇒ `exit(0)` 的重复实例不会被重新拉起 ⇒ **重启风暴在机制上被堵死**。另附：同页 man page 的 `ThrottleInterval` 默认 10 秒，即使真有反复启动也会被节流。

**残留**（低，见 R2.4-N4）：如果 panel.mjs 因为端口以外的原因启动即崩，看门狗每 30 秒无退避重试一次，`panel/data/dsh-plugin-panel.log` 会持续增长。这不是本轮引入的，但本轮把「launchd 迟迟不起来时插件接管」变成了主路径，所以暴露面变大了。

### Q3 `process.on('exit')` 在 `stopOnHostExit=false` 时是否 no-op —— **是，且不可能误杀 launchd 的面板**

- `index.js:767-768`：`function onHostExit(){ if (!cfg.stopOnHostExit) return; … }` ⇒ live 配置 `stopOnHostExit:false`（`cordis.patch.yml`）下一进函数就返回，**不发任何信号**。
- 即使把它改成 `true`，`:769` 仍要求 `service.child && service.managed && service.child.pid` 三者同时成立；`service.managed` 只在 `spawnPanel()`（`index.js:377`）里被置 true —— **复用来的进程永远不会被置 true** ⇒ 结构上无法命中 launchd 的面板。live 侧证：全程 `status.managed === false`。
- 监听器生命周期正确：`index.js:169` 注册的是 `runtime.onHostExit` 本身，`:171` 用**同一引用** `removeListener` ⇒ 反复 disable/enable 不会累积监听器。
- （参考级不一致）`onHostExit` 用 `SIGKILL`（`index.js:770`），而 `dispose` 是 `SIGTERM`→4s→`SIGKILL`（`index.js:781-788`）。退出路径不给面板收尾时间，建议对齐成 SIGTERM 优先。

### Q4 重跑自测 + sidebar occupant

**自测原样输出**（`cd …/yangyu-panel && time node scripts/selftest.mjs; echo EXIT=$?`）：

```
✅ 语法检查 index.js / client.js — node --check 通过
✅ 宿主导出面完整 — inject=[webServer]
✅ resolveConfig：默认值 + 非法值兜底 — 默认与兜底均符合预期
✅ resolvePaths：由 repoRoot 推导出真实存在的入口 — panelEntry=/Users/mikejam/Documents/deepseek-harness/QQ_bot/panel/panel.mjs
✅ resolveNodeBin：能在本机找到 node — /opt/homebrew/bin/node
✅ 复用分支：已就绪面板 → ready=true / managed=false / 不 spawn — port=52952 pid=null
✅ 冲突分支：端口被陌生服务占用 → 报错且不 spawn — 端口 52959 已被其他进程占用，且响应不满足面板就绪判据；请先释放该端口或改…
✅ 守卫分支：空闲端口不越权启动（缺入口 / 让位 launchd / 判据失效） — 终态=缺入口（判据未 loaded 或已失效）
✅ 路由：GET / 列路由，未知路径 404，PUT 不可用 — GET  /yangyu-panel/status | POST /yangyu-panel/start | POST /yangyu-panel/stop
✅ 安全：跨站 Origin 的 POST 被拒绝（403），同源放行 — 跨站 403 / 同源与只读 200
✅ 配置：startTimeoutMs 默认 30s 且可覆盖 — 默认 30000，可覆盖

用例合计 11：通过 11，失败 0，未执行 0
结论：全部用例已执行且通过。
EXIT=0

real	0m2.871s
```

**恒真用例判断（逐个新增/改动项）**：

| 用例 | 真能失败？ | 说明 |
| --- | --- | --- |
| 路由 PUT | **能** | `route.route('/start','PUT')` 是真实 HTTP PUT（`selftest.mjs:305`），断言 404；live 侧我独立复核 `PUT /start` → 404、`DELETE /start` → 404、`HEAD /status` → 404 |
| 跨站 CSRF | **能** | `startRaw` 走真实 `http.request` 且真的带 headers（`selftest.mjs:76-90、118-120`）；三个拒绝分支（evil / null / cross-site）各自独立断言 403，任一失效即红 |
| startTimeoutMs | **能（但只测配置层）** | 只断言 `resolveConfig` 的默认值与被覆盖值，**没有**验证「5s 超时真的在 5s 报错」——`waitReady` 的计时行为仍无测试 |
| 守卫分支 | **半恒真** | 见 N2 |
| 其余 7 项 | 能 | 与第一轮结论一致（第一轮已逐项判定，本轮代码未改动这些用例的断言结构） |

**sidebar/main occupant**：`cordis_inspect_query(client / Slots / listSubTree {"root":"sidebar.panellist"})` 本轮**再次超时**（第 4 次，10s，提示 `Open or reconnect the Harness page`）⇒ **仍未直接观测到 occupant，记为「未能验证」**。间接证据（与第一轮相同且更强了一点）：宿主半侧在 disable→enable 后正常重载并对外提供路由；`dsh-client-modules` 在组合期对 `exports["./client"]` 解析出的绝对路径做 `readFileSync`，失败会抛 `MissingClientBundleError` → `ClientPackageCompositionError` 让插件加载失败；现在插件加载正常 ⇒ 客户端 bundle 已被成功读取与组合（推理，非观测）。

## R2.3 复验结论

- **10 项修复：9 项完全成立，1 项部分成立**（L5 的覆盖问题反而扩大了一点，见 N2）。
- **新增风险：1 项「中」（N1 DNS rebinding），3 项「低」，2 项仅供参考。**
- **作者点名担心的两点（Q1 误伤、Q2 循环）经实测与机制论证均为「不成立」**：Q1 有 curl 决策矩阵 + referrer/CSP 核查 + DSH 自身 API 反证三重证据；Q2 有 man page 语义 + 端口空闲前提论证。

### N1（中）`isSameOrigin` 挡不住 DNS rebinding（Origin 与 Host 同源可比 ⇒ 两者一起被伪造）

- 证据：实测 ⑨ `Host: evil.com:58567` + `Origin: http://evil.com:58567` → **200**。这不是 curl 特有的：攻击页在 `http://evil.com:58567` 上把 DNS 重绑到 127.0.0.1 后，浏览器发出的正是这一对头（Origin 与 Host 都是 `evil.com:58567`，`Sec-Fetch-Site` 还会是 `same-origin`）。
- 根因：`index.js:700-707` 只比较「本请求的 Origin host」与「本请求的 Host」，两个值都来自同一个不可信请求。
- 对照：同一套代码里 DSH 自己的闸门是**另一套**做法（不采信请求头自证）：`dsh-client-connection/README.md`「Host 必须是 loopback、等于监听器的绑定 IP 字面量（端口不限），或匹配 `trustedHosts` 条目……这些检查防御 DNS rebinding 与跨站浏览器请求」；实现见 `dsh-client-connection/lib/index.js` 偏移 8154/8447（`isTrustedAuthority`）。
- 影响面：仍限于 loopback、仍只能 start/stop 一个本地面板，故判「中」而非「高」。但它是**唯一能绕过 M3 修复的路径**，且修复成本低。
- 建议：把判定改成「Host（或 Origin authority）必须 ∈ {`127.0.0.1[:port]`, `localhost[:port]`, `[::1][:port]`, 绑定 IP}」的允许清单，即 DSH 那套 `isTrustedAuthority` 语义；或直接复用 DSH 的 `trustedHosts` 配置。

### N2（低）守卫用例把 M1 的核心逻辑排除在覆盖之外，且断言有一半恒不可达

- `selftest.mjs:262` 显式传 `launchdLabel: 'com.mikejam.yangyu-panel-selftest-nonexistent'` ⇒ `launchctl print` 非 0 ⇒ 三态返回 **`absent`** ⇒ `index.js:527` 的 `loaded` 分支被整段跳过。
- 于是 **M1 的让位窗口与兜底自启（`index.js:534-542`）在测试里一次都没执行**；输出「终态=缺入口（判据未 loaded 或已失效）」也证实走的是 `absent` 路径。
- 同一断言 `missing || sawLaunchdLog`（`:274-277`）在 `absent` 路径下 `sawLaunchdLog` 必为假（`absent` 分支不写任何含 `launchd` 的日志）⇒ 该析取的右半边恒不成立，等于只断言了 `missing`。
- 评价：**改成不存在的 label 换来了确定性（值得肯定，也顺带让用例从 8s 缩到瞬时）**，代价是把新写的核心分支变成了无测试区。建议补一条把 `loaded` 分支也覆盖的用例（例如把 `LAUNCHD_HANDOFF_WAIT_MS` 也做成可注入的 config，或把等待窗口压到 0～50ms 再断言「error 明确 + 走到兜底自启」）。
- 另外第一轮 L5.2 指出的「`stopService()` 杀进程路径、`dispose()`、并发合流零覆盖」**本轮仍未补**。

### N3（低）代理/转发场景下 Origin 与 Host 可能不一致而误拒，DSH 自身对这种情况有专门处理

- `index.js:707` 是严格的 `originHost !== host → 拒绝`。若 DSH 被 HTTPS 反向代理在前（例如 `https://dsh.local:8443` → `http://127.0.0.1:58567`）且代理**改写了 Host**，浏览器给的是 `Origin: https://dsh.local:8443` + `Host: 127.0.0.1:58567` ⇒ 403，工具条「启动/重启/停止」全部失效。
- 对照 DSH 的实现说明（`dsh-client-connection/README.zh.md`）：「此时**按 Origin 的 scheme 解析 Host**，以支持 HTTPS 代理转发到 HTTP 上游」—— 即 DSH 自己专门处理了这种情形。
- 本机当前不适用（GUI 就是 `http://127.0.0.1:58567`，`lsof` 也确认 58567 bind 在 127.0.0.1）。列为「低」，仅提示别在反代后面直接用它。

### N4（低）看门狗无退避：面板因非端口原因启动即崩时会每 30s 重 spawn

- `index.js:660-662` 固定 30s 定时（`watchdogSecs` 默认 30），`watchdogTick`（`:667-679`）探活失败且 `service.child` 为空就 `start()`，`ensure` 走到 `spawnPanel()`。
- 若 panel.mjs 因配置错误等原因启动即崩（与端口无关，`panel.mjs` 的 `exit(1)` 分支），每 30 秒会重来一次：`spawnPanel` 每次 append 一行 `===== dsh-yangyu-panel 启动面板 @ … =====`（`index.js:343-346`），子进程 stderr 也并进同一文件 ⇒ `panel/data/dsh-plugin-panel.log` 无上限增长。
- 非本轮引入（第一轮同代码），但 M1 让插件在 launchd 迟迟不起来时接管，这条路径的触发概率上升。
- 建议：加退避（如连续失败 N 次后把周期翻倍封顶）或给日志加轮转。

### N5（参考）`launchdJobState` 把「任务不存在」与「launchctl 报错」都算非 0

`index.js:314-317` 只按退出码二分，`code !== 0` 一律 `absent`（`unknown` 只覆盖 spawn 失败/超时）。影响被兜住（见 R2.1 三态行：到达自启分支必先证明端口空闲），故仅作提示：若将来 `ensure` 的步骤顺序变化，这个区分会重新变得重要。

### N6（参考）`panel.mjs` 里还带着与本轮修复无关的未提交改动

`git status`：`M panel/llm.mjs`、`M panel/panel.mjs`、`M panel/public/app.js`、`M panel/store.mjs`。`git diff panel/panel.mjs` 除本轮新增的 `server.on('error')` 外，还包含 `geminiApiKey` 剥离、`POST /api/autopilot/config` 里 `delete patch.qq.mode/tg`、`GET /api/memory/graph` 位置调整等**更早的工作**。这些不在本次验收范围，但说明 `panel/` 处于「带未提交改动」状态——若后续误 `git checkout`，会连带回退这些修复。纯提示。

## R2.4 本轮「未能验证」清单（在第一轮清单之外增量）

1. **sidebar occupant**：`cordis_inspect_query(client/Slots/listSubTree)` 第 4 次超时（10s）⇒ 仍未直接观测（第一轮 §7.1 的同一项，本轮重试失败，如实记录）。
2. **Q1 的浏览器端直接观测**：无法在本沙箱启动真实浏览器抓取 DSH 页面发出的请求头，故 Q1 结论由「curl 决策矩阵 + referrer/CSP 源码核查 + DSH 自身 `/api` 可用这一事实」三条间接证据合成，**不是对浏览器抓包的直接观测**。
3. **M1 的 8 秒让位窗口实跑**：需要构造「launchd loaded 且不重启」的状态（`bootout`/改 plist），红线禁止动 launchd；只有静态控制流 + man page 语义论证。
4. **`server.on('error')` 的真触发验证**：需要让两个实例抢 8899，等于人为制造第二个面板实例，未做（会碰生产面板）。
5. **`stopOnHostExit=true` 时的 `process.on('exit')` 实跑**：需要改 profile，红线禁止；本轮只做了代码走查 + live `managed:false` 侧证。
6. **`stopService` / `dispose` 的杀进程行为**：仍无测试、也未实测（红线禁 `POST /stop`）。
7. **`panel/data/dsh-plugin-panel.log` 的增长速率**：N4 只做机制推演，未实测（未制造崩溃场景）。

## R2.5 第二轮判定

**修复验收：通过（有条件）。**

- 作者自述的 10 项修复，**9 项经独立证据完全成立**；`L5` 部分成立（PUT 用例与两个新用例是真的，但守卫用例的改动把 M1 的核心分支排除出了覆盖，且 `stopService`/`dispose` 仍零覆盖）。
- 作者点名担心的两个新缺陷（Q1 误伤合法调用、Q2 兜底自启成环）经实测与机制论证**均不成立**。
- 仍待处理（都不阻塞当前使用）：
  1. **N1（中）**：`isSameOrigin` 只做 Origin↔Host 自证，挡不住 DNS rebinding；建议改成 loopback/绑定 IP 允许清单（对齐 DSH 自己的 `isTrustedAuthority`）。
  2. **N2（低）**：补一条覆盖 `loaded → 8s → 兜底自启` 的用例；把 `stopService`/`dispose` 纳入测试。
  3. **N4（低）**：看门狗退避或日志轮转，避免崩溃时日志无界增长。
- 运行面结论（live）：插件仍以**复用**方式工作——`ready:true / managed:false / pid:null`，8899 上始终只有 launchd 的 **PID 8939** 一个监听者，插件从未写出 `panel/data/dsh-plugin-panel.log`，`launchd` 任务 `launchctl print` EXIT=0。即：**第一轮实测过的「不抢端口、不杀 launchd 面板」性质在本轮修复后仍然成立**（本轮我的全部 POST 测试也未带出第二个实例）。
