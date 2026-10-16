"""油画 → 像素：BOX 降采样到格子分辨率 + 中值切分量化（无抖动）。
输出的小图在 HTML/Remotion 里用 image-rendering:pixelated 按整数倍放大。
用法：python3 -I pixelize.py   （路径相对 promo/）"""
from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter
import glob

ROOT = Path(__file__).resolve().parents[2]          # promo/
OUT = ROOT / 'storyboard' / 'px'
OUT.mkdir(exist_ok=True)

def quant(im, colors):
    return im.quantize(colors=colors, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE).convert('RGB')

def pixelize(im, cells_w, cells_h, colors):
    small = im.convert('RGB').resize((cells_w, cells_h), Image.BOX)
    return quant(small, colors)

# 1) 世界全景：显示高 1080 → 宽 3240，8px 一格 = 405×135 格
pano = Image.open(ROOT / 'storyboard/gen/world-panorama.png').convert('RGB')
color = pixelize(ImageEnhance.Contrast(ImageEnhance.Color(pano).enhance(1.18)).enhance(1.06), 405, 135, 64)
color.save(OUT / 'world-color.png')

# 2) 原片态：16px 一格（分辨率减半）+ 去饱和 + 压对比 + 冷灰调
raw = pano.resize((203, 68), Image.BOX)
raw = ImageEnhance.Color(raw).enhance(0.12)
raw = ImageEnhance.Contrast(raw).enhance(0.72)
raw = ImageEnhance.Brightness(raw).enhance(0.92)
raw = Image.blend(raw, Image.new('RGB', raw.size, (150, 156, 166)), 0.18)
quant(raw, 12).save(OUT / 'world-raw.png')

# 3) 10 种背景预设：9:16 中心裁切，6px 一格，显示 324×576 → 54×96 格
for f in sorted(glob.glob(str(ROOT.parent / 'assets/backgrounds/*.jpg'))):
    im = Image.open(f).convert('RGB')
    w, h = im.size
    cw = int(h * 9 / 16)
    im = im.crop(((w - cw) // 2, 0, (w - cw) // 2 + cw, h))
    pixelize(im, 54, 96, 32).save(OUT / ('preset-' + Path(f).stem + '.png'))

# 4) 无面孔磨砂剪影（分镜卡下半屏用），6px 一格
# 原图是白色 + alpha 的磨砂玻璃剪影，要叠在背景上用；alpha 量化成 4 档，保留像素感
sil = Image.open(ROOT / 'assets/art/silhouette.webp').convert('RGBA').resize((54, 72), Image.BOX)
r, g, b, a = sil.split()
a = a.point(lambda v: 0 if v < 40 else (110 if v < 120 else (180 if v < 200 else 235)))
Image.merge('RGBA', (r, g, b, a)).save(OUT / 'silhouette.png')

# 6) 影院内景（终点关）：03-cinema 8px 一格，显示 1920×1280 → 240×160 格；观众只有背影
cin = Image.open(ROOT / 'assets/art/03-cinema.webp').convert('RGB')
pixelize(ImageEnhance.Color(cin).enhance(1.1), 240, 160, 64).save(OUT / 'cinema.png')

# 5) 前景视差层（品红抠像），8px 一格
fgp = ROOT / 'storyboard/gen/fg-foliage.png'
if fgp.exists():
    fg = Image.open(fgp).convert('RGB').resize((405, 135), Image.BOX)
    px = fg.load(); a = Image.new('L', fg.size, 255); pa = a.load()
    for y in range(fg.size[1]):
        for x in range(fg.size[0]):
            r, g, b = px[x, y]
            if r - g > 70 and b - g > 50:            # 品红键（含边缘混色）
                pa[x, y] = 0
    q = quant(fg, 32).convert('RGBA'); q.putalpha(a)
    q.save(OUT / 'fg-foliage.png')
print('ok', sorted(p.name for p in OUT.iterdir()))
