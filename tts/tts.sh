#!/bin/bash
# 语音合成脚本：文本 -> QQ 可发送的 MP4（含音频）
# 用法: ./tts.sh "要说的文字" [输出文件名] [语音名]
# 例:   ./tts.sh "你好呀" hello Xiaoyi
# 声音用 edge-tts（Xiaoyi 活泼 / Xiaoxiao 温柔，要联网）；没装或连不上就退回 macOS say

set -euo pipefail

TEXT="${1:-你好呀，我是蓝色大肥鱼}"
NAME="${2:-voice}"
VOICE="${3:-Xiaoyi}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. 合成语音（edge-tts，不行就 macOS say）
case "$VOICE" in
  Xiaoxiao) EDGE_VOICE=zh-CN-XiaoxiaoNeural ;;
  *)        EDGE_VOICE=zh-CN-XiaoyiNeural ;;
esac
EDGE="$(command -v edge-tts || echo "$HOME/.local/bin/edge-tts")"
RAW="$TMP/raw.mp3"
if ! { [ -x "$EDGE" ] && "$EDGE" --voice "$EDGE_VOICE" --text "$TEXT" --write-media "$RAW" >/dev/null 2>&1; }; then
  RAW="$TMP/raw.aiff"
  say -v Meijia -o "$RAW" "$TEXT"
fi

# 2. 检测时长
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$RAW" 2>/dev/null || echo "3")
DUR=$(printf "%.2f" "${DUR:-3}")

# 3. 生成静态封面（用角色的淡蓝色），并合成 mp4
ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=0x9ED8F0:s=640x640:d=${DUR}" \
  -i "$RAW" \
  -shortest \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -r 10 \
  -c:a aac -b:a 96k -ar 44100 -ac 1 \
  -movflags +faststart \
  "$OUT_DIR/${NAME}.mp4"

echo "✅ 已生成: $OUT_DIR/${NAME}.mp4 (${DUR}s)"
ls -la "$OUT_DIR/${NAME}.mp4"
