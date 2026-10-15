#!/usr/bin/env bash
# 混音 + 响度统一 + 封装：BGM 中低频、音效高频（频段隔离），amix 不归一化，两遍 loudnorm 到 -14 LUFS / 真峰值 ≤ -1.5 dBTP
# 用法：tools/mix.sh <无声视频.mp4> <输出.mp4>
set -euo pipefail
cd "$(dirname "$0")/.."
A=build/audio
VIDEO="$1"; OUT="$2"
FILTER="[0:a]volume=1.0[bgm];[1:a]highpass=f=300[s8];[2:a]highpass=f=800[su];[bgm][s8][su]amix=inputs=3:duration=first:normalize=0,aformat=channel_layouts=stereo"
MEASURE=$(ffmpeg -hide_banner -nostats -i $A/bgm.wav -i $A/sfx8.wav -i $A/sfxui.wav -filter_complex "$FILTER,loudnorm=I=-14:TP=-2.0:LRA=11:print_format=json" -f null - 2>&1 | sed -n '/^{/,/^}/p')
get() { echo "$MEASURE" | python3 -c "import json,sys;print(json.load(sys.stdin)['$1'])"; }
ffmpeg -v error -y -i $A/bgm.wav -i $A/sfx8.wav -i $A/sfxui.wav -filter_complex \
  "$FILTER,loudnorm=I=-14:TP=-2.0:LRA=11:measured_I=$(get input_i):measured_TP=$(get input_tp):measured_LRA=$(get input_lra):measured_thresh=$(get input_thresh):offset=$(get target_offset):linear=true,aresample=48000" \
  -c:a pcm_s16le $A/mix.wav
ffmpeg -v error -y -i "$VIDEO" -i $A/mix.wav -map 0:v -map 1:a -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart "$OUT"
ffmpeg -hide_banner -nostats -i "$OUT" -filter_complex ebur128=peak=true -f null - 2>&1 | grep -E "^\s+(I:|Peak:)" | tr -s ' '
