#!/usr/bin/env bash
# 从实测数据里裁出功能配图要用的素材（真实界面截图的局部 + 成片截帧），供 tpl/feature.html 与 tpl/hero.html 使用。
# 用法：scripts/readme/media.sh <工作台数据目录/spaces> <截图目录> <输出目录>
#   截图目录里需要（都是 1440×900@2x 的真实工作台截图）：
#     live.png     出片中、转录里口误刚被划掉的一刻
#     chat.png     对话里发了一句修改、出了 v2 的一屏
#     compare.png  打开「对比」的一屏（左栏滚到卡片自检分数）
# 横屏样片的项目 id 用环境变量 LAND 传入（它有 v1 极简工作室、v2 夜景落地窗两个版本）。
set -euo pipefail
spaces=$1; shots=$2; out=$3
: "${LAND:?需要 LAND=横屏样片的项目 id}"
mkdir -p "$out"
# 裁图：文件 x w h y 输出（CSS 像素；截图是 2x，这里乘 2）
crop() { magick "$1" -crop "$(($3 * 2))x$(($4 * 2))+$(($2 * 2))+$(($5 * 2))" +repage "$6"; }
crop "$shots/live.png"    92 512 142 248 "$out/live-head.png"
crop "$shots/live.png"    92 512 166 540 "$out/live-tx.png"
crop "$shots/chat.png"    92 512 380 322 "$out/chat.png"
crop "$shots/compare.png" 690 692 690 132 "$out/compare.png"
crop "$shots/compare.png" 92 512 72 134 "$out/scores.png"

frame() { ffmpeg -v error -y -ss "$2" -i "$1" -frames:v 1 -vf "$3" -q:v 3 "$4"; }
L1="$spaces/$LAND/v1/final.mp4"; L2="$spaces/$LAND/v2/final.mp4"
frame "$spaces/$LAND/inputs"/*/*.mp4 0.7 "crop=405:720:(iw-405)/2:0,scale=540:-1" "$out/bg-orig.jpg"
frame "$L1" 0.7 "scale=540:-1" "$out/bg-studio.jpg"
frame "$L2" 0.7 "scale=540:-1" "$out/bg-night.jpg"
i=0; for t in 0.7 2.4 4.6 8.6 10.4; do frame "$L1" "$t" "scale=540:-1" "$out/s$i.jpg"; i=$((i + 1)); done
# 横幅浮窗里的成片截帧：横屏样片 v2（对话里改成夜景落地窗之后）的开场钩子卡
frame "$L2" 2.4 "scale=720:-1" "$out/hero-frame.jpg"
ls "$out"
