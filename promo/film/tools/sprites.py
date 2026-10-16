"""像素精灵：ASCII → 1 像素 / 格的 PNG（自动 4 邻域描边 + 底沿阴影），页面里按整数倍放大。
小象轮廓来自 assets/brand/logo-512.png 的 BOX 降采样（24×22）后手修；只允许腿、鼻尖、眼睛变化。
用法：python3 -I tools/sprites.py  → public/sprites/*.png + src/kit/sprites.json"""
import json
from pathlib import Path
from PIL import Image

HERE = Path(__file__).resolve().parents[1]
OUT = HERE / 'public' / 'sprites'; OUT.mkdir(parents=True, exist_ok=True)
INK = (0x1b, 0x12, 0x06, 255)

BASE = [
'................######..',
'.............##########.',
'..........##############',
'......#############ee###',
'...################ee###',
'.#######################',
'########################',
'########################',
'##############....######',
'##############.....#####',
'##############.....#####',
'#####.########.....#####',
'#####..#######.....#####',
'####...#######.....#####',
'####....######.....#####',
'####....######.....#####',
'###......####......#####',
'###......####......#####',
'###.......###......#####',
'##........###......#####',
'##.........##......#####',
'...................####.']

def legs(rows, a, b, c):
    r = rows[:19] + [a, b, c]
    return r

def blink(rows):
    r = rows[:]; r[3] = r[3][:19] + '##' + r[3][21:]; return r

POSES = {
  'stand': BASE,
  'walk1': legs(BASE, '.##.......###......#####', '..##.......##......#####', '..................####..'),
  'walk2': legs(BASE, '##.........###.....#####', '##..........##.....#####', '....................####'),
  'jump':  BASE[:18] + ['.##.......##.......#####', '...................######', '......................##'],
  'squash': [r for i, r in enumerate(BASE) if i not in (6, 13)][:-1] + ['..................######'],
}
POSES['blink'] = blink(BASE)
POSES['cheer'] = blink(POSES['jump'])
PAL = {'#': (0xFA, 0xFA, 0xFA, 255), 'e': (0x01, 0x4D, 0xF9, 255), 's': (0xd8, 0xe1, 0xf7, 255), 'k': INK,
       'B': (0x01, 0x4D, 0xF9, 255), 'w': (255, 255, 255, 255), 'b': (0x5c, 0x81, 0xd6, 255), 'd': (0x00, 0x35, 0xB8, 255),
       'g': (0x8a, 0x8f, 0x99, 255), 'G': (0xc9, 0xcc, 0xd2, 255), 'D': (0x5d, 0x62, 0x6b, 255)}

def render(rows, outline=True, shade=True, pal=PAL):
    rows = [r.replace(' ', '') for r in rows]
    h, w = len(rows), max(len(r) for r in rows)
    P = 1 if outline else 0
    W, H = w + 2 * P, h + 2 * P
    g = [[None] * W for _ in range(H)]
    for y, r in enumerate(rows):
        for x, ch in enumerate(r):
            if ch != '.': g[y + P][x + P] = ch
    im = Image.new('RGBA', (W, H), (0, 0, 0, 0)); px = im.load()
    for y in range(H):
        for x in range(W):
            ch = g[y][x]
            if ch:
                col = pal[ch]
                if shade and ch == '#' and y + 1 < H and not g[y + 1][x]: col = pal['s']
                px[x, y] = col
            elif outline and any(0 <= y + dy < H and 0 <= x + dx < W and g[y + dy][x + dx] for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1))):
                px[x, y] = INK
    return im

meta = {}
for name, rows in POSES.items():
    im = render(rows); im.save(OUT / f'ele-{name}.png'); meta[f'ele-{name}'] = im.size
# 开场用：无描边、无阴影的纯白剪影（蓝底上）
flat = dict(PAL); flat['e'] = (0x01, 0x4D, 0xF9, 255); flat['s'] = PAL['#']
im = render(BASE, outline=False, shade=False, pal=flat); im.save(OUT / 'ele-flat.png'); meta['ele-flat'] = im.size

BLOCK = ['kkkkkkkkkkkk','kBBBBBBBBBBk','kBwwwwwwwwBk','kBwbbbbbbwBk','kBwwwwwwwwBk','kBwbbbbwwwBk','kBwwwwwwwwBk','kBwwwwwwwwBk','kBBBBBBBBBBk','kddddddddddk','kkkkkkkkkkkk']
im = render(BLOCK, outline=False, shade=False); im.save(OUT / 'block.png'); meta['block'] = im.size
used = [r.replace('B', 'g').replace('w', 'G').replace('b', 'g').replace('d', 'D') for r in BLOCK]
im = render(used, outline=False, shade=False); im.save(OUT / 'block-used.png'); meta['block-used'] = im.size
(HERE / 'src' / 'kit' / 'sprites.json').write_text(json.dumps({k: list(v) for k, v in meta.items()}, indent=1))
print(meta)

# 开场降采样的中间两档：logo 白色区域 BOX 降到 64 / 40 格宽（阈值化，白色无描边）
import numpy as np
logo = np.asarray(Image.open(HERE.parents[1] / 'assets' / 'brand' / 'logo-512.png').convert('RGB')).astype(int)
mask = (logo[:, :, 0] > 200) & (logo[:, :, 1] > 200)
ys, xs = np.where(mask)
m = Image.fromarray((mask[ys.min():ys.max() + 1, xs.min():xs.max() + 1] * 255).astype('uint8'))
for cols in (64, 40):
    rows = round(m.size[1] / m.size[0] * cols)
    small = np.asarray(m.resize((cols, rows), Image.BOX)) > 120
    im = Image.new('RGBA', (cols, rows), (0, 0, 0, 0)); px = im.load()
    for y in range(rows):
        for x in range(cols):
            if small[y, x]: px[x, y] = (0xFA, 0xFA, 0xFA, 255)
    im.save(OUT / f'ele-step{cols}.png'); meta[f'ele-step{cols}'] = im.size
(HERE / 'src' / 'kit' / 'sprites.json').write_text(json.dumps({k: list(v) for k, v in meta.items()}, indent=1))
print('steps ok')
