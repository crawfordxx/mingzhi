import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';

/** 颗粒强度：中灰上每像素的平均偏差占满幅的比例（要求 3–5%，取偏轻的 3.5%：静帧看得见，H.264 压缩后在运动画面里只剩一层质感） */
export const GRAIN_STRENGTH = 0.035;
/** 暗角：四角最多压暗的比例 */
export const VIGNETTE = 0.16;
/** 固定种子：同一帧号永远出同一张噪声，渲染可复现 */
export const GRAIN_SEED = 0x6d7a6869;
/** 颗粒粒径（像素）：按 1/2 分辨率生成再平滑放大，颗粒更像胶片而不是数字噪点 */
const GRAIN_PX = 2;
/** 噪声灰度的标准差（0–255 灰阶），近似正态 */
const NOISE_STD = 64;
/**
 * 叠加后中灰上的平均偏差 ≈ 不透明度 × 噪声平均偏差 × 放大平滑损失。
 * 正态分布平均偏差 = 0.798σ；2× 双线性放大后实测约剩 0.62（Remotion 静帧在中灰上量得）。用它把强度换算成不透明度。
 */
const NOISE_MAD = (0.798 * NOISE_STD * 0.62) / 255;

/** mulberry32：32 位种子的小型伪随机数发生器 */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 帧号 + 种子 → 灰度噪声（RGBA，均值 128）；三个均匀数之和近似正态 */
export function grainNoise(frame: number, width: number, height: number, seed = GRAIN_SEED): Uint8ClampedArray {
  const rand = mulberry32(Math.imul(frame + 1, 0x9e3779b1) ^ seed);
  const out = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < out.length; i += 4) {
    const g = (rand() + rand() + rand() - 1.5) / 0.5;
    const v = 128 + g * NOISE_STD;
    out[i] = v;
    out[i + 1] = v;
    out[i + 2] = v;
    out[i + 3] = 255;
  }
  return out;
}

const vignetteGradient = (amount: number): string =>
  `radial-gradient(ellipse farthest-corner at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${(amount * 0.45).toFixed(3)}) 78%, rgba(0,0,0,${amount.toFixed(3)}) 100%)`;

/**
 * 质感层：动态颗粒（按帧号确定性生成，overlay 叠加，暗部和高光自然减弱）+ 轻暗角。
 * 叠在全片最上层、字幕之下；不拦截任何内容，不改变画面尺寸。
 */
export const GrainLayer: React.FC<{ strength?: number; vignette?: number; seed?: number }> = ({ strength = GRAIN_STRENGTH, vignette = VIGNETTE, seed = GRAIN_SEED }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement>(null);
  const w = Math.ceil(width / GRAIN_PX);
  const h = Math.ceil(height / GRAIN_PX);
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx) return;
    ctx.putImageData(new ImageData(grainNoise(frame, w, h, seed), w, h), 0, 0);
  }, [frame, w, h, seed]);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {strength > 0 ? (
        <canvas ref={ref} width={w} height={h}
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', mixBlendMode: 'overlay', opacity: Math.min(1, strength / NOISE_MAD) }} />
      ) : null}
      {vignette > 0 ? <AbsoluteFill style={{ background: vignetteGradient(vignette) }} /> : null}
    </AbsoluteFill>
  );
};
