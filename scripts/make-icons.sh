#!/usr/bin/env bash
# 从 assets/brand/logo.svg 生成启动器图标：
#   launcher/macos/AppIcon.icns   macOS 应用图标（圆角方块，四周留白，符合系统图标网格）
#   launcher/windows/mingzhi.ico  Windows 图标（16～256 像素，各尺寸都是 PNG）
# 生成结果已入库，CI 不需要重新生成；改了 logo 之后在 macOS 上手动运行一次再提交。
# 依赖：rsvg-convert（brew install librsvg）、ImageMagick（brew install imagemagick）、iconutil（macOS 自带）、node
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/assets/brand/logo.svg"
ICNS="$ROOT/launcher/macos/AppIcon.icns"
ICO="$ROOT/launcher/windows/mingzhi.ico"

for tool in rsvg-convert magick iconutil node; do
  command -v "$tool" >/dev/null || { echo "缺少 ${tool}，见脚本头部的依赖说明" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- macOS：1024 画布，824 的圆角方块居中（Apple 图标网格），圆角半径约 22.4%
rsvg-convert -w 824 -h 824 "$SVG" -o "$TMP/body.png"
magick -size 824x824 xc:none -fill white -draw "roundrectangle 0,0 823,823 185,185" "$TMP/mask.png"
magick "$TMP/body.png" "$TMP/mask.png" -alpha off -compose CopyOpacity -composite "$TMP/rounded.png"
magick -size 1024x1024 xc:none "$TMP/rounded.png" -gravity center -composite "$TMP/icon-1024.png"

SET="$TMP/AppIcon.iconset"
mkdir "$SET"
for size in 16 32 128 256 512; do
  magick "$TMP/icon-1024.png" -filter Lanczos -resize "${size}x${size}" "$SET/icon_${size}x${size}.png"
  magick "$TMP/icon-1024.png" -filter Lanczos -resize "$((size * 2))x$((size * 2))" "$SET/icon_${size}x${size}@2x.png"
done
iconutil -c icns "$SET" -o "$ICNS"

# ---- Windows：直接用 logo 的方形满版，各尺寸分别从矢量渲染（小尺寸更清晰），每个尺寸以 PNG 存入 ico
PNGS=()
for size in 16 24 32 48 64 128 256; do
  rsvg-convert -w "$size" -h "$size" "$SVG" -o "$TMP/win-$size.png"
  PNGS+=("$TMP/win-$size.png")
done
node --input-type=module - "$ICO" "${PNGS[@]}" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const [out, ...pngs] = process.argv.slice(2);
const images = pngs.map((f) => readFileSync(f));
const head = Buffer.alloc(6 + 16 * images.length);
head.writeUInt16LE(1, 2); // type = icon
head.writeUInt16LE(images.length, 4);
let offset = head.length;
images.forEach((png, i) => {
  const e = 6 + 16 * i;
  const w = png.readUInt32BE(16); // PNG IHDR 宽高
  const h = png.readUInt32BE(20);
  head[e] = w >= 256 ? 0 : w;
  head[e + 1] = h >= 256 ? 0 : h;
  head.writeUInt16LE(1, e + 4); // planes
  head.writeUInt16LE(32, e + 6); // bpp
  head.writeUInt32LE(png.length, e + 8);
  head.writeUInt32LE(offset, e + 12);
  offset += png.length;
});
writeFileSync(out, Buffer.concat([head, ...images]));
JS

ls -l "$ICNS" "$ICO"
