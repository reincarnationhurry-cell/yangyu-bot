# 熄屏不掉线（keep awake）

问题：Mac 熄屏后系统进入休眠，DSH 的 QQ 网关 WebSocket 被挂起/断开，
表现为「发消息没人回」「回复断在半句」。

## 临时（当前这次会话有效）
```bash
caffeinate -ims &
```

## 永久（推荐，开机自启+自愈）
已生成 plist：`ops/com.mikejam.dsh-keepawake.plist`

安装：
```bash
cp ~/Documents/deepseek-harness/QQ_bot/ops/com.mikejam.dsh-keepawake.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.mikejam.dsh-keepawake.plist
```

检查：
```bash
launchctl print gui/$(id -u)/com.mikejam.dsh-keepawake | head
```

卸载：
```bash
launchctl unload ~/Library/LaunchAgents/com.mikejam.dsh-keepawake.plist
rm ~/Library/LaunchAgents/com.mikejam.dsh-keepawake.plist
```

`caffeinate -ims` 的含义：屏可以关，但系统不睡、硬盘不睡、不被空闲判定休眠。
