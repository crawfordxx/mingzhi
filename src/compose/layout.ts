import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';
import { CANVAS, type Shot } from '../storyboard/schema.js';

export interface PersonTransform { scale: number; x: number; y: number }
/** 分屏时头顶距分界线的距离（px） */
const HEAD_GAP = 60;
/** 抠不出人时按头顶在画面 12% 处估计 */
const DEFAULT_TOP = 0.12;

/** 视频按宽铺满画布；分屏时把头顶放在分界线下 HEAD_GAP，且上不露分界线以上、下不露画布底 */
export function personTransform(layout: 'split' | 'full', subject: SubjectBox | null, videoW: number, videoH: number): PersonTransform {
  const scale = CANVAS.width / videoW;
  const h = videoH * scale;
  if (layout === 'full') return { scale, x: 0, y: Math.round((CANVAS.height - h) / 2) };
  const top = subject?.top ?? DEFAULT_TOP;
  const wanted = CANVAS.seam + HEAD_GAP - top * h;
  const y = Math.min(CANVAS.seam, Math.max(CANVAS.height - h, wanted));
  return { scale, x: 0, y };
}

export function blendTransform(a: PersonTransform, b: PersonTransform, t: number): PersonTransform {
  const mix = (p: number, q: number): number => p + (q - p) * t;
  return { scale: mix(a.scale, b.scale), x: mix(a.x, b.x), y: mix(a.y, b.y) };
}

export function captionAt(captions: TimedCaption[], sec: number): TimedCaption | null {
  return captions.find((c) => sec >= c.start && sec < c.end) ?? null;
}

export function shotAt(shots: Shot[], sec: number): { shot: Shot; index: number } | null {
  const index = shots.findIndex((s) => sec >= s.start && sec < s.end);
  return index < 0 ? null : { shot: shots[index], index };
}
