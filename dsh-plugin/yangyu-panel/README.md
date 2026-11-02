# dsh-yangyu-panel

把本地「**养鱼面板**」（`panel/panel.mjs`，`http://127.0.0.1:8899`）接成 **DSH 左栏的一个入口**：
点左栏的小鱼图标 → 主区整页嵌入面板。宿主半侧负责「**只要 DSH 在运行，面板就在运行**」：
插件加载即拉起面板，之后每 30 秒探活，掉线自动拉起；并且**与现有 launchd 共存不抢端口**。

```
DSH 左栏 ──点击──> main 整页组件 ──iframe──> http://127.0.0.1:8899/  (panel.mjs)
                        │
                        └─fetch──> /yangyu-panel/status|start|stop  ──> 宿主半侧进程管理
```

## 它做什么

| 半侧 | 文件 | 职责 |
| --- | --- | --- |
| 宿主 | `index.js` | 注册 `/yangyu-panel` 前缀路由（status/start/stop）；随 DSH 拉起 `panel.mjs`；30 秒看门狗自愈；只回收自己拉起的进程 |
| 浏览器 | `client.js` | 在 `sidebar.panellist` 注册一行「养鱼面板」（图标 = 小鱼）；在 `main` 用同一 key 注册整页组件：顶部工具条（状态 / 启动 / 重启 / 停止 / 刷新 / 在内置浏览器打开）+ iframe |

- 面板**已就绪**时工具条自动收起，只在页面顶部留 6px 感应条（鼠标移上去滑出），整屏让给面板。
- 面板**没在跑**时显示状态条与「启动」按钮，点一下由 DSH 拉起。
- 工具条按钮：启动、重启、停止、刷新、在内置浏览器打开（宿主有 `sidebarRight.openTab` 时出现）。
- iframe 是独立文档，不继承 DSH 主题 token —— 面板页面自带配色；工具条本身用 `--dsw-alias-*` token（都带字面兜底）。

## 安装

本机 `desktop` profile 由 Electron 应用独占，**命令行装不了**（`dsh plugin ...` 会返回
`profile "desktop" is managed exclusively by the Electron application`）。用应用内 GUI：

1. 左栏「插件」→「添加插件」/「安装第三方插件」
2. 插件目录填**绝对路径**：`/Users/mikejam/Documents/deepseek-harness/QQ_bot/dsh-plugin/yangyu-panel`
3. 勾选「立即启用」→ 安装

装完左栏出现小鱼图标；若没出现，重载页面（客户端 bundle 在 `dsh.client.immediately=true` 下随页面加载）。
改完 `client.js` 后要让客户端重新取 bundle：重载页面；`index.js`（宿主半侧）改动需要重启 DSH 或重新加载插件。

## 配置

在 profile 的 `~/.dsh/profiles/desktop/cordis.patch.yml` 里改本插件那一行的 `config`（也可由 GUI 插件页改）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `repoRoot` | `/Users/mikejam/Documents/deepseek-harness/QQ_bot` | 工作区根，面板入口推导为 `<repoRoot>/panel/panel.mjs` |
| `panelPort` | `8899` | 面板端口；spawn 时以 `PANEL_PORT` 环境变量传给 panel.mjs |
| `autoStart` | `true` | 插件加载即拉起面板（「DSH 起则面板起」的主开关） |
| `watchdogSecs` | `30` | 探活周期（秒）；`0` = 关闭看门狗，只被动探活 |
| `startTimeoutMs` | `30000` | 单次启动等待上限（毫秒），与 UI 的「启动超时（30 秒）」文案一致 |
| `stopOnHostExit` | `false` | 插件卸载/宿主退出时是否回收**自己拉起的**面板 |
| `respectLaunchd` | `true` | 自己拉起前，若同名 launchd 任务 loaded 则让位（防双监督者抢端口） |
| `launchdLabel` | `com.mikejam.yangyu-panel` | 让位判据用的 launchd label |
| `launchctlBin` | `/bin/launchctl` | launchctl 路径；非标准位置或自测时改指向假实现 |
| `trustedHosts` | `[]` | 额外受信任的 Host 名（反代/自定义域名才需要）。**默认只信 `127.0.0.1` / `localhost` / `[::1]`**；这是防 DNS rebinding 的关键，别随手加域名 |
| `nodeBin` | `''` | 指定 node；空则依次找 `PANEL_NODE_BIN`、`/opt/homebrew/bin/node`、`/usr/local/bin/node`、`PATH` |

## 谁在管面板：两种推荐配置

**A. 保持现状（默认，推荐先这样）** —— launchd 让面板脱离 DSH 常驻，插件只做入口 + 兜底自愈。
面板本来就由 `~/Library/LaunchAgents/com.mikejam.yangyu-panel.plist` 常驻，此时插件**复用**现有进程
（`status` 里 `managed: false`），工具条上的「停止」不会去杀它；插件看门狗发现掉线也不会抢，
而是让给 launchd 去重启。`stopOnHostExit: false`，DSH 退出面板照常活着。

**B. 让面板完全跟随 DSH 生命周期** —— DSH 跑面板才跑，DSH 退出面板就停：

```bash
launchctl bootout gui/$UID/com.mikejam.yangyu-panel            # 卸掉 launchd 常驻
mv ~/Library/LaunchAgents/com.mikejam.yangyu-panel.plist{,.disabled}   # 顺手停掉开机自启
```

再把 patch 里本插件 `config.stopOnHostExit` 改成 `true`。之后面板进程由插件独占管理：
`status.managed = true`，「停止」真的能停，DSH 退出即回收。两种配置**不要同时用**（会让两个监督者抢端口）。

## 自测

```bash
cd /Users/mikejam/Documents/deepseek-harness/QQ_bot/dsh-plugin/yangyu-panel
node scripts/selftest.mjs
```

9 个用例：语法检查、宿主导出面、`resolveConfig`/`resolvePaths`/`resolveNodeBin`、复用分支、
冲突分支、守卫分支（空闲端口不越权启动）、路由表。**自测永不 spawn 真实 panel.mjs**（那会起第二个
面板去动 B站 账号），全部用假上游 + 不存在的 repoRoot 把 spawn 路堵死，并断言 `service.child === null`。
退出码：`0` 全过；`1` 有失败；`2` 有未执行项（此时**不得**宣称「全部通过」）。

## 排错

| 现象 | 处理 |
| --- | --- |
| 左栏没有小鱼图标 | 重载页面；确认 profile `package.json` 的 `dsh.profile.bundles` 含 `dsh-yangyu-panel`，且 patch 用 `insert:` 形式 |
| 页面显示「端口已被其他进程占用」 | 8899 上是别的程序。`lsof -nP -iTCP:8899 -sTCP:LISTEN` 看占用者，或改 `config.panelPort` |
| 显示「缺少面板入口文件」 | `repoRoot` 配错，或 `panel/panel.mjs` 被挪走 |
| 启动后一直「未就绪」 | 看 `panel/data/dsh-plugin-panel.log`（插件拉起时的 stdout/stderr）与 `panel/data/panel.err.log` |
| 面板掉线后没自动起来 | 看门狗只要 `watchdogSecs > 0` 就会跑（与 `autoStart` 无关）。启用了 `respectLaunchd` 时它会先让 launchd 在 8 秒内拉起；8 秒没起来就由插件兜底启动，并写一条 `改由插件兜底启动` 日志。宿主日志里若出现 `无法判定 launchd 任务 … 的状态`，说明 `launchctl` 在该环境下不可用，插件会自己拉起（第二个实例会 EADDRINUSE 后以 0 退出，不会影响已有面板） |

## 文件结构

```
dsh-plugin/yangyu-panel/
├── index.js            宿主半侧（Cordis 插件，inject: ['webServer']）
├── client.js           浏览器半侧（__ModuleLoader__.load，注册 sidebar.panellist + main）
├── cordis.patch.yml    bundle patch（insert 本插件的 loader 行 + 默认 config）
├── package.json        清单：dsh.bundle.patch + dsh.client{platform:web, immediately:true}
├── icon.svg            左栏图标（原创小鱼，线条随 currentColor）
├── locale/{zh,en}.json 文案与 meta
├── scripts/selftest.mjs 自测（9 项，不碰生产面板）
└── README.md
```

## 边界与已知约束

- 插件**不实现**面板功能，只做「入口 + 进程守护」；面板本身仍是 `panel/` 下的既有代码。
- 只回收**自己拉起**的进程；复用来的（launchd / 手动 `node panel.mjs`）绝不被插件杀掉 —— 避免误杀用户手动开的实例。
- 端口被非本项目程序占用时如实报错，不假装成功，也不会去杀别人的进程。
- 并发 `start` 合流成一次启动，不重复 spawn。
