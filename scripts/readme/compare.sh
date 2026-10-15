#!/usr/bin/env bash
# 剪辑前后对比：左原片、右成片，同步从 0 秒开始播放，较短的一条停在最后一帧，各自下方有进度条。
# 前景层（深色底、圆角洞、标签）由 tpl/stage.html 渲染，洞的位置必须与这里的 LAYOUT 一致。
# 产出：<out>.mp4（1920×1200，带成片的声音）、<out>.webp（960 宽动图，README 主图）、<out>.gif（800 宽兜底）
# 用法：scripts/readme/compare.sh landscape|portrait 原片.mp4 成片.mp4 "底部说明（用 | 分隔）" 输出前缀
set -euo pipefail
kind=$1; orig=$2; final=$3; note=$4; out=$5
here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

dur() { ffprobe -v error -show_entries format=duration -of csv=p=0 "$1"; }
mmss() { awk -v s="$1" 'BEGIN { s = int(s + 0.5); printf "%d:%02d", s / 60, s % 60 }'; }
da=$(dur "$orig"); db=$(dur "$final")
D=$(awk -v a="$da" -v b="$db" 'BEGIN { print (a > b ? a : b) + 1.2 }')

# LAYOUT：x y w h（与 tpl/stage.html 相同）
if [ "$kind" = landscape ]; then A=(112 321 1056 594); else A=(316 170 504 896); fi
B=(1296 170 504 896); [ "$kind" = portrait ] && B=(1100 170 504 896)

node "$here/render.mjs" stage "kind=$kind&a=$(mmss "$da")&b=$(mmss "$db")&note=$note" 1920 1200 "$tmp/fg.png" --transparent >/dev/null

# 进度条：轨道 W×4，蓝条从左往右长出来（成片蓝、原片白），轨道再贴到洞下方 22px 处
bar() { # $1=标签 $2=宽 $3=时长 $4=颜色
  echo "color=c=0xffffff1a:s=${2}x4:r=24:d=$D,format=rgba[t$1];color=c=$4:s=${2}x4:r=24:d=$D,format=rgba[c$1];[t$1][c$1]overlay=x='-$2+$2*min(t/$3\,1)':y=0:eval=frame[bar$1]"
}

ffmpeg -v error -y -i "$orig" -i "$final" -loop 1 -framerate 24 -t "$D" -i "$tmp/fg.png" -filter_complex "
color=c=0x0c0d10:s=1920x1200:r=24:d=$D[bg];
[0:v]fps=24,scale=${A[2]}:${A[3]}:force_original_aspect_ratio=increase,crop=${A[2]}:${A[3]},setsar=1,tpad=stop_mode=clone:stop_duration=$D[a];
[1:v]fps=24,scale=${B[2]}:${B[3]}:force_original_aspect_ratio=increase,crop=${B[2]}:${B[3]},setsar=1,tpad=stop_mode=clone:stop_duration=$D[b];
[bg][a]overlay=${A[0]}:${A[1]}:shortest=1[v1];[v1][b]overlay=${B[0]}:${B[1]}[v2];[v2][2:v]overlay=0:0[v3];
$(bar a "${A[2]}" "$da" 0xffffffb3);$(bar b "${B[2]}" "$db" 0x85a0e0);
[v3][bara]overlay=${A[0]}:$((A[1] + A[3] + 22))[v4];[v4][barb]overlay=${B[0]}:$((B[1] + B[3] + 22)),trim=duration=$D,format=yuv420p[v];
[1:a]apad,atrim=duration=$D[au]" \
  -map '[v]' -map '[au]' -c:v libx264 -preset slow -crf 24 -tune film -movflags +faststart -c:a aac -b:a 128k "$out.mp4"

# GIF（兜底）：800 宽 12fps、128 色 + bayer 抖动，控制在 8MB 内；README 主图用下面的动图 webp
ffmpeg -v error -y -i "$out.mp4" -vf "fps=12,scale=800:-1:flags=lanczos,split[x][y];[x]palettegen=max_colors=128:stats_mode=diff[p];[y][p]paletteuse=dither=bayer:bayer_scale=3:diff_mode=rectangle" -loop 0 "$out.gif"
# 动图 webp：960 宽 12fps，画质远好于 GIF、体积约为其四分之一
mkdir -p "$tmp/f" && ffmpeg -v error -y -i "$out.mp4" -vf "fps=12,scale=960:-1:flags=lanczos" "$tmp/f/%04d.png"
img2webp -loop 0 -lossy -q 72 -m 6 -d 83 "$tmp"/f/*.png -o "$out.webp" >/dev/null
ls -l "$out".{mp4,gif,webp} | awk '{ printf "%s %.1f MB\n", $NF, $5 / 1048576 }'
