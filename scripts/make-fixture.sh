#!/usr/bin/env bash
# 生成带气口、重复、口误和 1.5 秒停顿的测试口播（540x960 竖屏，约 19 秒）
set -euo pipefail
OUT_DIR="$(cd "$(dirname "$0")/.." && pwd)/tests/fixtures"
TMP="$(mktemp -d)"
mkdir -p "$OUT_DIR"
say -v Tingting -o "$TMP/a.aiff" "然后呢，嗯，我平时经常在 GitHub 上面去逛，去逛 AI 项目。"
say -v Tingting -o "$TMP/b.aiff" "最近发现了一个，一个项目，叫高性价比人生指南。这个项目里面一共讲了六百，不对，讲了六百五十条。"
ffmpeg -v error -y -i "$TMP/a.aiff" -ar 44100 -ac 1 "$TMP/a.wav"
ffmpeg -v error -y -i "$TMP/b.aiff" -ar 44100 -ac 1 "$TMP/b.wav"
ffmpeg -v error -y -f lavfi -t 1.5 -i anullsrc=r=44100:cl=mono "$TMP/s.wav"
ffmpeg -v error -y -i "$TMP/a.wav" -i "$TMP/s.wav" -i "$TMP/b.wav" \
  -filter_complex "[0:a][1:a][2:a]concat=n=3:v=0:a=1[a]" -map "[a]" "$TMP/talk.wav"
ffmpeg -v error -y -f lavfi -i color=c=0x334455:s=540x960:r=30 -i "$TMP/talk.wav" \
  -shortest -c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p -c:a aac -b:a 96k "$OUT_DIR/talk.mp4"
rm -rf "$TMP"
echo "已生成 $OUT_DIR/talk.mp4"
