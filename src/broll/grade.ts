import type { Rgb } from '../matting/composite.js';

/** B-roll 白平衡增益上下限：只做微调，避免把素材调成别的颜色 */
export const WB_MIN = 0.9;
export const WB_MAX = 1.1;
/** 色度比的指数：0.3 = 向参考色走三成（与抠像人物向背景靠拢的 wbStrength 相同；B-roll 是另一个镜头，不必完全同色） */
const WB_STRENGTH = 0.3;

const luma = ([r, g, b]: Rgb): number => 0.2126 * r + 0.7152 * g + 0.0722 * b;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/**
 * 素材向人物背景平均色靠拢的逐通道增益（参考 src/matting/composite.ts 的 colorMatchGains）：
 * 只看色度比（各通道除以亮度），按 WB_STRENGTH 次方取一部分，再整体归一使亮度不变，最后限幅 0.9–1.1。
 * asset 与 ref 都是 0–1 的平均 RGB（编码域）。
 */
export function wbGains(asset: Rgb, ref: Rgb): Rgb {
  const aL = Math.max(luma(asset), 1e-4);
  const rL = Math.max(luma(ref), 1e-4);
  const ratio = (c: 0 | 1 | 2): number => (Math.max(ref[c] / rL, 1e-4) / Math.max(asset[c] / aL, 1e-4)) ** WB_STRENGTH;
  const raw: Rgb = [ratio(0), ratio(1), ratio(2)];
  const norm = luma(raw);
  return [clamp(raw[0] / norm, WB_MIN, WB_MAX), clamp(raw[1] / norm, WB_MIN, WB_MAX), clamp(raw[2] / norm, WB_MIN, WB_MAX)];
}

/** 增益是否值得加滤镜（任一通道偏离 1 超过 0.5%） */
export const needsWb = (g: Rgb): boolean => g.some((v) => Math.abs(v - 1) > 0.005);

/** colorchannelmixer 滤镜：逐通道乘增益 */
export const wbFilter = (g: Rgb): string => `colorchannelmixer=rr=${g[0].toFixed(4)}:gg=${g[1].toFixed(4)}:bb=${g[2].toFixed(4)}`;
