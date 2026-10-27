#!/bin/bash
# 把 GPT-SoVITS 的接口（api_v2.py，她的嗓子）交给 macOS launchd 托管：登录自启、崩溃自动拉起。
# GPT-SoVITS 是号主自己装的（默认 ~/GPT-SoVITS，里面要有 .venv），这里只管让它开着。
#
#   ./install-gsv-launchd.sh            安装 / 更新并启动
#   ./install-gsv-launchd.sh uninstall  停止并移除
#
# 环境变量：GSV_DIR（默认 ~/GPT-SoVITS）、GSV_PORT（默认 9880，voice.mjs 里写死的也是它）、LABEL（默认 com.<用户名>.yangyu-gsv）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LABEL="${LABEL:-com.$(whoami).yangyu-gsv}"
GSV_DIR="${GSV_DIR:-$HOME/GPT-SoVITS}"
PORT="${GSV_PORT:-9880}"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
PY="$GSV_DIR/.venv/bin/python"

if [[ "${1:-}" == "uninstall" ]]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "已移除 $LABEL"
  exit 0
fi

[[ -x "$PY" && -f "$GSV_DIR/api_v2.py" ]] || { echo "在 $GSV_DIR 找不到 GPT-SoVITS（要有 api_v2.py 和 .venv）"; exit 1; }
mkdir -p "$HERE/data" "$(dirname "$PLIST")"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PY</string><string>api_v2.py</string>
    <string>-a</string><string>127.0.0.1</string><string>-p</string><string>$PORT</string>
    <string>-c</string><string>GPT_SoVITS/configs/tts_infer.yaml</string>
  </array>
  <key>WorkingDirectory</key><string>$GSV_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HERE/data/gsv.out.log</string>
  <key>StandardErrorPath</key><string>$HERE/data/gsv.err.log</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$GSV_DIR/.venv/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>PYTORCH_ENABLE_MPS_FALLBACK</key><string>1</string>
  </dict>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "✓ 已安装并启动：$LABEL"
echo "  接口：http://127.0.0.1:$PORT/tts（加载模型要半分钟左右）"
echo "  重启：launchctl kickstart -k gui/$(id -u)/$LABEL"
