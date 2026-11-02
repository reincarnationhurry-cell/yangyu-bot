#!/bin/bash
# 一键装好面板：检查依赖 → 交给系统托管（开机自启、崩了自动拉起）→ 打开浏览器
#
#   ./install.sh             安装 / 更新并启动
#   ./install.sh uninstall   停止并移除托管
#
# macOS 用 launchd，Linux 用 systemd --user。Windows 双击 start.cmd（不托管，窗口开着就在跑）。
# 环境变量：PANEL_PORT（默认 8899）
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PORT="${PANEL_PORT:-8899}"
URL="http://127.0.0.1:$PORT/"
OS="$(uname -s)"

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m·\033[0m %s\n' "$1"; }
die()  { printf '  \033[31m✗\033[0m %s\n' "$1"; exit 1; }
has()  { command -v "$1" >/dev/null 2>&1; }

if [[ "${1:-}" == "uninstall" ]]; then
  case "$OS" in
    Darwin) "$HERE/panel/install-launchd.sh" uninstall ;;
    Linux)
      systemctl --user disable --now yangyu-panel.service 2>/dev/null || true
      rm -f "$HOME/.config/systemd/user/yangyu-panel.service"
      systemctl --user daemon-reload 2>/dev/null || true
      echo "已移除 yangyu-panel.service" ;;
  esac
  exit 0
fi

echo "检查依赖"
has node || die "没找到 node：先装 Node.js 18 或更新的版本（https://nodejs.org）"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
(( NODE_MAJOR >= 18 )) || die "Node.js 太旧（$(node -v)），要 18 或更新"
ok "Node.js $(node -v)（面板没有 npm 依赖，不用 npm install）"

if has docker; then ok "docker（用 QQ 小号时跑 NapCat）"; else warn "没有 docker：只用 QQ 小号线路时才需要（macOS 推荐 OrbStack）"; fi
if has ffmpeg; then ok "ffmpeg"; else warn "没有 ffmpeg：发语音要用（brew / apt install ffmpeg）"; fi
if has edge-tts || [[ -x "$HOME/.local/bin/edge-tts" ]]; then ok "edge-tts"; else warn "没有 edge-tts：她的嗓子（pipx install edge-tts），没有就打字"; fi
CHROME=""
for p in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" \
         /usr/bin/google-chrome /usr/bin/google-chrome-stable /usr/bin/chromium /usr/bin/chromium-browser /usr/bin/microsoft-edge; do
  [[ -x "$p" ]] && { CHROME="$p"; break; }
done
if [[ -n "${WEB_BROWSER:-}$CHROME" ]]; then ok "浏览器 ${WEB_BROWSER:-$CHROME}"; else warn "没找到 Chrome：逛贴吧、刷抖音要用"; fi

mkdir -p "$HERE/panel/data"
chmod +x "$HERE/panel/"*.sh 2>/dev/null || true

echo "交给系统托管"
case "$OS" in
  Darwin)
    PANEL_PORT="$PORT" "$HERE/panel/install-launchd.sh" ;;
  Linux)
    has systemctl || die "没有 systemd：直接 node panel/panel.mjs 跑，或者自己用 pm2 / supervisor 托管"
    UNIT_DIR="$HOME/.config/systemd/user"
    mkdir -p "$UNIT_DIR"
    cat > "$UNIT_DIR/yangyu-panel.service" <<UNIT
[Unit]
Description=养鱼面板
After=network-online.target

[Service]
WorkingDirectory=$HERE/panel
ExecStart=$(command -v node) $HERE/panel/panel.mjs
Environment=PANEL_PORT=$PORT
Environment=PATH=$(dirname "$(command -v node)"):/usr/local/bin:/usr/bin:/bin
Restart=on-failure
RestartSec=5
StandardOutput=append:$HERE/panel/data/panel.out.log
StandardError=append:$HERE/panel/data/panel.err.log

[Install]
WantedBy=default.target
UNIT
    systemctl --user daemon-reload
    systemctl --user enable --now yangyu-panel.service
    warn "想让它不登录也开着：sudo loginctl enable-linger $(whoami)"
    ok "已安装：systemctl --user status yangyu-panel" ;;
  *) die "不认识的系统 $OS：Windows 请双击 start.cmd" ;;
esac

for _ in $(seq 1 30); do curl -s -o /dev/null --max-time 1 "$URL" && break; sleep 0.5; done
if curl -s -o /dev/null --max-time 2 "$URL"; then
  ok "面板起来了：$URL （第一次打开会带你去「上手」页）"
  if [[ "$OS" == Darwin ]]; then open "$URL"; elif has xdg-open; then xdg-open "$URL" >/dev/null 2>&1 || true; fi
else
  die "面板没起来，看看 $HERE/panel/data/panel.err.log"
fi
