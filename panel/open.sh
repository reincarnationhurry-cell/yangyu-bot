#!/bin/bash
# 打开养鱼面板：确保服务在跑，然后打开浏览器
set -e
PORT="${PANEL_PORT:-8899}"
LABEL="${LABEL:-com.$(whoami).yangyu-panel}"
URL="http://127.0.0.1:${PORT}/"

# 面板由 launchd 托管，正常情况下已经在跑
if curl -s -o /dev/null --max-time 2 "$URL"; then
  open "$URL"
else
  echo "面板没在跑，尝试通过 launchd 拉起来…"
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for i in $(seq 1 20); do
    sleep 0.5
    if curl -s -o /dev/null --max-time 2 "$URL"; then
      open "$URL"
      exit 0
    fi
  done
  echo "启动失败。手动排查："
  echo "  launchctl print gui/$(id -u)/$LABEL"
  echo "  tail -30 \"$(dirname \"$0\")/data/panel.err.log\""
  exit 1
fi
