"""Seedance 花园循环 → 像素帧：每帧 BOX 降到 240×135 格（世界 8px 格的 88–328 列），
锁定到世界全景的调色板，左右各 6 格羽化，输出 32 帧 RGBA（7.5fps 播放约 4.3s 一圈，首尾同帧无缝）。
用法：python3 -I tools/garden.py"""
import subprocess, sys
from pathlib import Path
from PIL import Image
import numpy as np

HERE = Path(__file__).resolve().parents[1]
SRC = HERE / 'gen' / 'garden-loop.mp4'
OUT = HERE / 'public' / 'px' / 'garden'
OUT.mkdir(parents=True, exist_ok=True)
pal_img = Image.open(HERE / 'public' / 'px' / 'world-color.png').convert('RGB').quantize(colors=64, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)

raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', str(SRC), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], capture_output=True, check=True).stdout
W, H = 1280, 720
frames = np.frombuffer(raw, np.uint8).reshape(-1, H, W, 3)
n = len(frames)
N = 32
alpha = np.ones((135, 240), np.float32)
for i in range(6):
    alpha[:, i] = alpha[:, -1 - i] = (i + 1) / 7
a = Image.fromarray((alpha * 255).astype(np.uint8))
small = [np.asarray(Image.fromarray(frames[round(k * (n - 1) / N)]).resize((240, 135), Image.BOX), np.float32) for k in range(N)]
base = small[0]
T = 22.0  # 与首帧色差小于阈值的格子沿用首帧，压掉量化「沸腾」，只留真正在动的叶子和光斑
prev = None; diffs = []
for k in range(N):
    cur = small[k]
    moved = np.linalg.norm(cur - base, axis=2) > T
    mix = np.where(moved[..., None], cur, base).astype(np.uint8)
    q = Image.fromarray(mix).quantize(palette=pal_img, dither=Image.Dither.NONE).convert('RGBA')
    q.putalpha(a)
    q.save(OUT / f'g{k:02d}.png')
    arr = np.asarray(q.convert('RGB'), np.int16)
    if prev is not None: diffs.append(np.mean(np.any(arr != prev, axis=2)))
    prev = arr
print('frames', n, 'out', N, 'changed-cell ratio per step: mean %.3f max %.3f' % (np.mean(diffs), np.max(diffs)))
