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
