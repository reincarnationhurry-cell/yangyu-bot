# QQ 机器人运维笔记

## 一、回复「截断」（半句话没了）

### 结论（2026-10-20 夜定位）
不是 QQ 投递丢包，也不是消息超长分片——**是模型这一步的输出本身停在了半句**。

证据来自会话日志 `~/.dsh/sessions/<工作区>/<会话>/session.v4.jsonl.zstd`：
`assistant/message` 里 text 块结尾就是断点，和流式最后一帧完全一致，
结束原因是 `finish: {kind: 'stop'}`（模型自己停的），不是发送失败。

### 触发条件
与 **provider = trae** 强相关：
- buddy 的 1-18 轮，全部正常收尾（句号/问号结尾），0 次截断。
- 切到 trae 之后（第 19 轮起），8 轮里 5-6 轮断在半句。

降低推理档位**不能**解决：第 23 轮已经是 `light`，照样断在「Q 网关注连的那几秒」。
所以不是「推理吃掉预算」，更像是 trae 这条链路把末尾 token 丢了，
或者响应在正文写完前就被结束（`finish` 报的是 `stop` 而不是 `length`，也支持这个判断）。

### 修法（按优先级）
1. **在 QQ 会话里发 `/model`**，切回 `buddy/deepseek-v4.1-flash`。会话级，立即生效。
2. 根治（全局默认）：把 `~/.dsh/profiles/desktop/cordis.patch.yml` 里
   `- id: agent-default-model` 的
   `provider: trae` / `reasoningEffort: extra_high`
   改成 `provider: buddy` / `reasoningEffort: high`，然后完全退出 DSH 重开。
   （该文件在工作区外，模型没有写权限，需手动改。）

## 二、熄屏后不工作

### 原因
Mac 空闲休眠后 DSH 的 QQ 网关 WebSocket 被挂起，表现为「发消息没人回」，
以及上面的「回复断在半句」——两者叠加，所以夜里特别明显。

### 已做
本机已起一个 `caffeinate -ims`（只阻止系统休眠，屏幕照常熄）：
```bash
pgrep -f "caffeinate -ims"     # 确认在跑
pmset -g assertions | head -20 # 应看到 caffeinate + PreventUserIdleSystemSleep
```

### 永久生效（开机自启 + 崩溃自愈）
plist 已生成：`ops/com.mikejam.dsh-keepawake.plist`（参数 `-ims`：只阻止休眠，屏幕照常熄）。

**必须在用户自己的终端里执行**，模型会话内的 launchctl 被沙箱挡住
（`bootstrap` 报 `5: Input/output error`，`chmod`/`cp` 到 `~/Library/LaunchAgents` 报 `Operation not permitted`）：

```bash
cp ~/Documents/deepseek-harness/QQ_bot/ops/com.mikejam.dsh-keepawake.plist ~/Library/LaunchAgents/
launchctl bootout gui/$(id -u)/com.mikejam.dsh-keepawake 2>/dev/null
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.mikejam.dsh-keepawake.plist
launchctl print gui/$(id -u)/com.mikejam.dsh-keepawake | grep -E "state|pid"
```

期望输出：`state = running`（有 pid）。

注意：2026-10-21 凌晨装的那版参数是 `-dims`（会连屏幕一起常亮，费电）。
上面这组命令会把 plist 换成 `-ims` 并重新注册。

卸载：
```bash
launchctl bootout gui/$(id -u)/com.mikejam.dsh-keepawake
rm ~/Library/LaunchAgents/com.mikejam.dsh-keepawake.plist
```

### 当前状态（2026-10-21 08:2x）
- 手动 `caffeinate -ims` 在跑，休眠已被挡住（`pmset -g assertions` 有
  `PreventUserIdleSystemSleep` + `PreventSystemSleep`），重启/注销后失效。
- LaunchAgent 此刻 **NOT LOADED**（模型会话里 bootout 成功、bootstrap 被拦），需按上面命令重装。

## 三、回复慢
- 已把 `mergeTimeoutSecs` 从 5 改到 1（消息合并缓冲），重启后生效。
- 剩下的 4-12 秒是 QQ 官方 Bot 的链路开销（msg_id 校验 + 腾讯服务器中转），改不了。

## 三、开发别在 QQ_bot 工作区里做

DSH 的记忆插件按工作区分桶，QQ 渠道的工作区就是 QQ_bot。在这里干开发活，
工程笔记会进「肥鱼」的记忆，每条 QQ 消息都背着它（变慢，人设也被冲淡）；在 QQ 会话里干开发活更糟，上下文会涨到几十万 token。

- 开发：在 DSH 桌面版里开 `deepseek-harness`（上一层目录）当工作区，或者直接用别的工具改代码。
- 以前的工程笔记已经搬到 `ops/dev-notes.md`（原记忆备份在 `~/.dsh/memory-backup-QQ_bot-*`）。
- QQ 会话变慢了就发 `/new`。

## 四、DSH 升级后 QQ 掉线

### 结论（2026-10-24 定位）
QQ 接入靠第三方插件 `@michengai/dsh-im-connect`。它在 `package.json` 的 `peerDependencies` 里把支持的宿主版本**一个个写死**
（`0.2.1-rc.2 || 0.2.1-rc.3 …`）。DSH 桌面版一自动升级、插件还没发新版，宿主就不加载它：设置里「IM 助理」消失、
QQ 网关不启动，`~/.dsh/dsh-im-connect/gateway.log` 停在升级前。渠道配置、凭据、会话都还在，不用重配。

### 修法
1. DSH 插件市场把 dsh-im-connect 升到最新 → **Cmd+Q 完全退出** DSH 再打开。
2. 插件作者还没跟上新版本时：先别升 DSH（等插件更新了再升），或者退回上一个 DSH 版本。

### 面板会帮你盯着
`panel/health.mjs` 每 5 分钟查一次：DSH.app 的版本在不在插件声明的列表里、DSH 这次启动后网关有没有「网关就绪」。
出问题会在面板顶上挂红条，并弹一条 macOS 通知（QQ 断了，她没法在 QQ 里告诉你）。

## 五、记忆插件的「昨日反思」和「已更新今日日志」

DSH 的记忆插件（`@a9i5k4/dsh-auto-memory`）是给写代码设计的，系统提示里写死了两条：
每天第一轮「在回复开头以『昨日反思』小节呈现前一天的反思」，以及「更新记忆后必须在回复末尾醒目地写出来」。
在 QQ 里聊天就会冒出这些话。

- AGENTS.md 里已经让她静默做、别在回复里提（工作区规则能压住大部分情况）。
- 想彻底不要「昨日反思」：DSH 设置 → 记忆插件 → 关掉「每日反思」（对应 `~/.dsh/dsh-auto-memory.json` 的 `reflectEnabled`，全局生效，
  其他工作区也会一起关）。她自己的睡前反思在面板里（`mind.mjs`），不受影响。

## 六、小号被风控了 → 切回官方机器人（2026-10-28 实测）

### 结论
QQ 小号线路（NapCat）不适合长期挂机：**小号会被 QQ 风控**。这次的表现是
QQ 安全中心「你的账号身份验证信息已失效，部分功能受限」+「已登录设备风险提醒（QQ桌面版-Linux）」，
NapCat 每 2 分钟重登一次全部失败：`[Core] [Login] Login Error, ErrType: 1 ErrCode: 3`，扫码也不管用。

对照：**官方机器人线路（DSH + dsh-im-connect）不受这个风控影响**，官方渠道更稳。

### 判断信号（不用翻代码）
- `docker logs napcat` 刷 `Login Error, ErrType 1, ErrCode 3`，伴 `二维码已保存到 /app/napcat/cache/qrcode.png`；
- 面板顶挂红条「QQ 小号没连上 NapCat」，`/api/qq` 里 `connected: false`、`error: 连接出错`；
- `panel/data/actions.jsonl` 里反复「QQ 小号断开了，会自己重连」→「小号连上了」→ 又断开；
- 手机 QQ 或 QQ 安全中心里出现身份验证失效/功能受限。

### 切回官方线路（面板上点一下就行）

2026-10-28 起面板加了**一键切线路**：自动养号 →「💬 QQ 连接」顶上的
**「换回官方机器人」** 按钮，会自己停掉 NapCat 容器并把面板切回官方。
**「换成小号线路」** 反过来：拉起容器、切到小号，并把登录二维码显示在面板上（不用再去 WebUI 找）。
旁边还有「起容器 / 停容器 / 重启换张码」。小号解冻后过几天想再试，点「换成小号线路」扫码即可。

要命令行做（比如面板打不开）也一样：

```bash
# 1. 面板配置切回官方机器人（面板进程会自己把 OneBot 客户端停掉）
curl -s -X POST -H 'Content-Type: application/json' \
  -d '{"qq":{"mode":"official"}}' http://127.0.0.1:8899/api/autopilot/config

# 2. 停掉 NapCat 容器（不然它继续每 2 分钟重登，账号越弄越糟）
cd panel/qq/napcat && docker compose down
```

核对：`/api/qq` 里 `mode: official`、`on: false`；
`curl http://127.0.0.1:8899/api/health` 返回 `ok: true`、`host: 0.2.1-rc.3`、`plugin.version` 在插件声明支持的列表里；
`~/.dsh/dsh-im-connect/gateway.log` 末行有时间在往后走的「网关就绪」。

### 切之前先备份
`panel/data/autopilot.json` 是面板配置，切线路会改它。先 `cp` 一份带时间戳的 `.bak`（本仓库习惯）。

### 注意（和官方线路的历史坑不同）
- 这不是 2026-10-24 那个「DSH 升级、插件 peer 范围不含新宿主」的故障：那次是**网关根本不启动**，
  这次网关正常、插件版本也对得上，坏的只是小号本身。别混为一谈。
- 官方机器人的两个固有限制照旧：**只能在你说话后一小时内回**（`README.md` 有说明），**不能主动开口**；
  想让她凭空找你，只有小号线路能做到 —— 所以切回来等于放弃主动消息，接受这个交换。
- 小号那边的聊天历史、`owner.json` 里关于号主的事、`qq-chat.jsonl` 都还在本地，切回官方不会删；
  以后小号解冻了，把 `qq.mode` 改回 `onebot` 再 `docker compose up -d` 就能续上。
- `panel/data/secrets.json` 的 `qqOpenId` 要填**你在 QQ 机器人里的 openid**，别把别处的 URL 填进来
  （面板上这个框和「模型」的接口地址长得不完全一样，容易看错）。
