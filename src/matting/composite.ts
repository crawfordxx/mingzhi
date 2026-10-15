export type Rgb = readonly [number, number, number];
/** 人物在画面中的范围（0–1，相对宽高），供 P3 取景「下半屏人像」 */
export interface SubjectBox { top: number; bottom: number; left: number; right: number }

/** RVM 建议推理分辨率的长边在 256–512：长边缩到 512，小视频不放大 */
const TARGET_LONG_SIDE = 512;
/** 每个通道增益的上下限，避免把人调成别的颜色 */
const MIN_GAIN = 0.85;
const MAX_GAIN = 1.15;

export function chooseDownsample(width: number, height: number): number {
  return Math.min(1, TARGET_LONG_SIDE / Math.max(width, height));
}

const luma = ([r, g, b]: Rgb): number => 0.299 * r + 0.587 * g + 0.114 * b;
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

export function meanRgb(rgb: Uint8Array | Buffer): Rgb {
  const sum = [0, 0, 0];
  for (let i = 0; i < rgb.length; i += 1) sum[i % 3] += rgb[i];
  const n = rgb.length / 3;
  return [sum[0] / n / 255, sum[1] / n / 255, sum[2] / n / 255];
}

/** fgr 为 RVM 输出的平面 CHW（0–1）；只统计 alpha>0.5 的像素 */
export function foregroundMean(fgr: Float32Array, pha: Float32Array, pixels: number): Rgb | null {
  const sum = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < pixels; i += 1) {
    if (pha[i] <= 0.5) continue;
    sum[0] += fgr[i];
    sum[1] += fgr[pixels + i];
    sum[2] += fgr[2 * pixels + i];
    n += 1;
  }
  return n === 0 ? null : [sum[0] / n, sum[1] / n, sum[2] / n];
}

/** 人物朝背景靠拢的逐通道增益：白平衡按「色度比」的 wbStrength 次方、亮度按「亮度比」的 lumStrength 次方，各通道限制在 0.85–1.15 */
export function colorMatchGains(fg: Rgb, bg: Rgb, wbStrength = 0.3, lumStrength = 0.2): Rgb {
  const fgL = Math.max(luma(fg), 1e-4);
  const bgL = Math.max(luma(bg), 1e-4);
  const lumGain = (bgL / fgL) ** lumStrength;
  const gain = (c: 0 | 1 | 2): number => {
    const ratio = (bg[c] / bgL) / Math.max(fg[c] / fgL, 1e-4);
    return clamp(Math.max(ratio, 1e-4) ** wbStrength * lumGain, MIN_GAIN, MAX_GAIN);
  };
  return [gain(0), gain(1), gain(2)];
}

/**
 * out = alpha·(fgr·增益·255) + (1−alpha)·背景；fgr 平面 CHW 0–1，bg/out 为 rgb24 交错。
 * alpha 恰为 0 的像素直接复制背景（结果与公式一致，省去乘加）。
 * 运算顺序与旧实现保持一致（fgr·增益 先乘、再乘 255），保证结果逐位相同。
 */
export function compositeFrame(fgr: Float32Array, pha: Float32Array, bg: Buffer, gains: Rgb, out: Buffer): void {
  const pixels = pha.length;
  const [gr, gg, gb] = gains;
  for (let i = 0; i < pixels; i += 1) {
    const a = pha[i];
    const o = i * 3;
    if (a === 0) {
      out[o] = bg[o];
      out[o + 1] = bg[o + 1];
      out[o + 2] = bg[o + 2];
      continue;
    }
    const ia = 1 - a;
    out[o] = clamp(Math.round(a * (fgr[i] * gr * 255) + ia * bg[o]), 0, 255);
    out[o + 1] = clamp(Math.round(a * (fgr[pixels + i] * gg * 255) + ia * bg[o + 1]), 0, 255);
    out[o + 2] = clamp(Math.round(a * (fgr[2 * pixels + i] * gb * 255) + ia * bg[o + 2]), 0, 255);
  }
}

/** alpha>threshold 的像素外接框（归一化到 0–1，right/bottom 取像素右/下边界）；没有前景返回 null */
export function alphaBox(pha: Float32Array, width: number, height: number, threshold = 0.5): SubjectBox | null {
  let top = height, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      if (pha[y * width + x] <= threshold) continue;
      top = Math.min(top, y); bottom = Math.max(bottom, y);
      left = Math.min(left, x); right = Math.max(right, x);
    }
  }
  if (bottom < 0) return null;
  return { top: top / height, bottom: (bottom + 1) / height, left: left / width, right: (right + 1) / width };
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** 逐边取中位数，抗个别帧抠像抖动 */
export function medianBox(boxes: SubjectBox[]): SubjectBox | null {
  if (boxes.length === 0) return null;
  return { top: median(boxes.map((b) => b.top)), bottom: median(boxes.map((b) => b.bottom)), left: median(boxes.map((b) => b.left)), right: median(boxes.map((b) => b.right)) };
}
