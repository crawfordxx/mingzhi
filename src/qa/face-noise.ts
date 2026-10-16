/**
 * 人脸区域高频噪声（整片自检指标，对应验收报告第 3.3 节「人脸全是彩色麻点」）：
 * 在成片里取人脸区域，算亮度的拉普拉斯能量（高通能量），除以同一区域在无颗粒人像视频上的能量（基准）。
 * 比值 1.0 表示颗粒没有给人脸加任何高频；颗粒越重、编码越糙，比值越大。本文件只做纯计算；抽帧在 face-noise-measure.ts
 */
import { personTransform, visualLayout, type PersonTransform } from '../compose/layout.js';
import type { SubjectBox } from '../matting/composite.js';
import { CANVAS, type Shot } from '../storyboard/schema.js';

/** 画布像素下的矩形 */
export interface PixelRect { x: number; y: number; w: number; h: number }

/**
 * 阈值：成片人脸区域的拉普拉斯能量 ≤ 基准的 1.5 倍。
 * 依据（横屏 mock 的两个分屏取样点）：同一成片不加颗粒 0.99×；新颗粒（亮度 σ≈2.6 灰阶，人物区域降到 1/3）0.93×；
 * P7 旧颗粒（平均偏差约 9 灰阶的带色麻点）4.44×。1.5 给编码与缩放造成的偏差留足余量，又远低于旧颗粒
 */
export const FACE_NOISE_MAX_RATIO = 1.5;
/** 基准能量的下限：人像视频本身极平坦（能量接近 0）时，比值不能被一个极小的分母放大 */
export const FACE_BASE_FLOOR = 2;
/** 取样点个数上限 */
export const FACE_SAMPLES = 4;
/** 版式切换过渡之后再取样（秒）：过渡里人像在移动，位置对不上基准 */
const SETTLE_SEC = 0.6;
/** 取样版式：人物全屏、分屏（分屏时人在分界线以下）；浮层、素材全屏、画中画的人脸被遮挡或太小，不取 */
const FACE_LAYOUTS = ['full', 'split'] as const;

/**
 * 人脸区域（相对人物框）：水平取中间一半，竖直从头顶下 6% 到下 26%（眼、鼻、脸颊；避开发际线外的背景和压在分界线上的字幕）。
 * 返回画布像素，夹在画布内；t 为人像在画布上的缩放与位置（personTransform 的结果）
 */
export function faceRect(t: PersonTransform, subject: SubjectBox, videoW: number, videoH: number): PixelRect | null {
  const w = videoW * t.scale;
  const h = videoH * t.scale;
  const sw = (subject.right - subject.left) * w;
  const sh = (subject.bottom - subject.top) * h;
  const left = Math.max(0, t.x + subject.left * w + sw * 0.25);
  const top = Math.max(0, t.y + subject.top * h + sh * 0.06);
  const right = Math.min(CANVAS.width, t.x + subject.left * w + sw * 0.75);
  const bottom = Math.min(CANVAS.height, t.y + subject.top * h + sh * 0.26);
  // 取偶数起点与尺寸，避免 4:2:0 的色度对齐问题
  const x = Math.ceil(left / 2) * 2;
  const y = Math.ceil(top / 2) * 2;
  const rw = Math.floor((right - x) / 2) * 2;
  const rh = Math.floor((bottom - y) / 2) * 2;
  return rw >= 16 && rh >= 16 ? { x, y, w: rw, h: rh } : null;
}

/** 亮度的拉普拉斯能量：4 邻域拉普拉斯的平方均值。σ 的白噪声贡献 20σ²，平坦或平滑渐变的皮肤接近 0 */
export function laplacianEnergy(gray: Uint8Array, width: number, height: number): number {
  if (width < 3 || height < 3) return 0;
  let sum = 0;
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      const i = y * width + x;
      const l = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - width] - gray[i + width];
      sum += l * l;
    }
  }
  return sum / ((width - 2) * (height - 2));
}

export interface FaceSample { time: number; shotIndex: number; rect: PixelRect }

/** 取样点：在人物全屏（不带卡片和素材）与分屏的镜头里，每镜头取过渡之后的一个时刻（均匀分布），最多 FACE_SAMPLES 个；人物框未知时没有取样点 */
export function faceSamples(shots: Shot[], subject: SubjectBox | null, videoW: number, videoH: number): FaceSample[] {
  if (!subject) return [];
  const usable = shots.flatMap((s, i) => {
    const layout = visualLayout(s);
    if (!(FACE_LAYOUTS as readonly string[]).includes(layout) || s.end - s.start < SETTLE_SEC + 0.4) return [];
    // 人物全屏的镜头里若有卡片（行动号召的按钮等压在头部上方）或素材，脸上有别的高频内容，不取
    if (layout === 'full' && (s.card || s.broll)) return [];
    const rect = faceRect(personTransform(layout, subject, videoW, videoH), subject, videoW, videoH);
    return rect ? [{ time: Math.round((s.start + SETTLE_SEC + (s.end - s.start - SETTLE_SEC) / 2) * 100) / 100, shotIndex: i, rect }] : [];
  });
  if (usable.length <= FACE_SAMPLES) return usable;
  const step = usable.length / FACE_SAMPLES;
  return Array.from({ length: FACE_SAMPLES }, (_, k) => usable[Math.floor(k * step)]);
}

/** 一个取样点的能量：film 为成片人脸区域，base 为无颗粒人像视频同一区域 */
export interface FaceEnergy { time: number; film: number; base: number }

/** 汇总：比值 = 成片能量合计 / 基准能量合计（每个基准不低于 FACE_BASE_FLOOR） */
export function faceNoiseRatio(energies: FaceEnergy[]): number {
  const film = energies.reduce((n, e) => n + e.film, 0);
  const base = energies.reduce((n, e) => n + Math.max(FACE_BASE_FLOOR, e.base), 0);
  return base > 0 ? film / base : 0;
}
