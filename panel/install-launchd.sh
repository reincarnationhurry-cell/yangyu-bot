#!/bin/bash
# 把养鱼面板（含自动养号调度器）交给 macOS launchd 托管：登录自启、崩溃自动拉起。
#
#   ./install-launchd.sh            安装 / 更新并启动
#   ./install-launchd.sh uninstall  停止并移除
#
# 环境变量：PANEL_PORT（默认 8899）、LABEL（默认 com.<用户名>.yangyu-panel）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="${LABEL:-com.$(whoami).yangyu-panel}"
PORT="${PANEL_PORT:-8899}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE="$(command -v node || true)"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已移除 $LABEL"
  exit 0
fi

[[ -n "$NODE" ]] || { echo "找不到 node，先装 Node.js ≥ 18"; exit 1; }
mkdir -p "$HERE/data" "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$NODE</string><string>$HERE/panel.mjs</string></array>
  <key>WorkingDirectory</key><string>$HERE</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>$HERE/data/panel.out.log</string>
  <key>StandardErrorPath</key><string>$HERE/data/panel.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE"):/usr/local/bin:/usr/bin:/bin</string>
    <key>PANEL_PORT</key><string>$PORT</string>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ 已安装并启动：$LABEL"
echo "  面板地址：http://127.0.0.1:$PORT"
echo "  重启：launchctl kickstart -k gui/$(id -u)/$LABEL"
