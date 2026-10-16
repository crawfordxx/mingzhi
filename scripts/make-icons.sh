#!/usr/bin/env bash
# 从 assets/brand/logo.svg 生成 Windows 启动器图标：
#   launcher/windows/mingzhi.ico  16～256 像素，各尺寸都是 PNG
# （macOS 只发 .command 与命令行二进制，没有图标。）
# 生成结果已入库，CI 不需要重新生成；改了 logo 之后手动运行一次再提交。
# 依赖：rsvg-convert（brew install librsvg）、node
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SVG="$ROOT/assets/brand/logo.svg"
ICO="$ROOT/launcher/windows/mingzhi.ico"

for tool in rsvg-convert node; do
  command -v "$tool" >/dev/null || { echo "缺少 ${tool}，见脚本头部的依赖说明" >&2; exit 1; }
done

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

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

ls -l "$ICO"
