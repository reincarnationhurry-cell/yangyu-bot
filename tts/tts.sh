#!/bin/bash
# 语音合成脚本：文本 -> QQ 可发送的 MP4（含音频）
# 用法: ./tts.sh "要说的文字" [输出文件名] [语音名]
# 例:   ./tts.sh "你好呀" hello Meijia

set -euo pipefail

TEXT="${1:-你好呀，我是蓝色大肥鱼}"
NAME="${2:-voice}"
VOICE="${3:-Meijia}"
OUT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# 1. 合成语音（macOS say）
say -v "$VOICE" -o "$TMP/raw.aiff" "$TEXT"

# 2. 检测时长
DUR=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$TMP/raw.aiff" 2>/dev/null || echo "3")
DUR=$(printf "%.2f" "${DUR:-3}")

# 3. 生成静态封面（用角色的淡蓝色），并合成 mp4
ffmpeg -y -loglevel error \
  -f lavfi -i "color=c=0x9ED8F0:s=640x640:d=${DUR}" \
  -i "$TMP/raw.aiff" \
  -shortest \
  -c:v libx264 -preset veryfast -pix_fmt yuv420p -r 10 \
  -c:a aac -b:a 96k -ar 44100 -ac 1 \
  -movflags +faststart \
  "$OUT_DIR/${NAME}.mp4"

echo "✅ 已生成: $OUT_DIR/${NAME}.mp4 (${DUR}s)"
ls -la "$OUT_DIR/${NAME}.mp4"
