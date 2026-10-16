// 动画工具：全部是帧号的纯函数（确定性渲染）。motion 只当缓动函数库用，不用它的运行时动画循环。
import { cubicBezier } from 'motion';

export const FPS = 30;
export const expoOut = cubicBezier(0.16, 1, 0.3, 1);
export const overshoot = cubicBezier(0.34, 1.56, 0.64, 1);
export const camInOut = cubicBezier(0.65, 0, 0.35, 1);
export const follow = cubicBezier(0.33, 0, 0.15, 1);
export const easeIn = cubicBezier(0.55, 0, 1, 0.45);

export const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
/** f 在 [start, start+dur] 上的 0→1 进度，带缓动 */
export const prog = (f: number, start: number, dur: number, ease: (t: number) => number = (t) => t) =>
  ease(clamp((f - start) / Math.max(1e-6, dur)));
/** 入场 0→1、退场 1→0 的组合（退场线性 6f） */
export const inOut = (f: number, a: number, inDur: number, b: number, outDur = 6, ease = expoOut) =>
  Math.min(prog(f, a, inDur, ease), 1 - prog(f, b, outDur));
/** 像素网格吸附 */
export const snap = (v: number, g = 6) => Math.round(v / g) * g;
/** 抛物线跳跃：t∈[0,1]，返回 0→峰值→0 的高度 */
export const arc = (t: number, h: number) => 4 * h * t * (1 - t);

/** mulberry32 种子随机（禁止 Math.random） */
export function seeded(seed: number) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 分段关键帧插值：keys = [[frame, value], ...] */
export function keys(f: number, ks: [number, number][], ease: (t: number) => number = camInOut) {
  if (f <= ks[0][0]) return ks[0][1];
  for (let i = 1; i < ks.length; i++) {
    const [f1, v1] = ks[i];
    const [f0, v0] = ks[i - 1];
    if (f <= f1) return lerp(v0, v1, ease(clamp((f - f0) / Math.max(1e-6, f1 - f0))));
  }
  return ks[ks.length - 1][1];
}

/** 数字逐位滚动：from→to 文本等长，每位在 [start, start+dur] 内滚过 */
export function rollText(f: number, from: string, to: string, start: number, dur: number) {
  const t = prog(f, start, dur, expoOut);
  return [...to].map((ch, i) => (t >= (i + 1) / to.length || from[i] === ch ? ch : t > 0 ? String((Number(from[i]) + Math.floor(t * 9 * (i + 1))) % 10) : from[i])).join('');
}
