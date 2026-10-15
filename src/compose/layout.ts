import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';
import { CANVAS, type Shot } from '../storyboard/schema.js';

export interface PersonTransform { scale: number; x: number; y: number }
/** 分屏时头顶距分界线的距离（px） */
const HEAD_GAP = 60;
/** 抠不出人时按头顶在画面 12% 处估计 */
const DEFAULT_TOP = 0.12;

/** 人物水平中心对齐画布中线，并夹住不让视频两侧露出底色 */
function centerX(subject: SubjectBox | null, w: number): number {
  const cx = subject ? (subject.left + subject.right) / 2 : 0.5;
  return Math.round(Math.min(0, Math.max(CANVAS.width - w, CANVAS.width / 2 - cx * w)));
}

/**
 * 视频铺满人像区域（cover）：竖屏按宽铺满；横屏等更宽的视频按区域高度放大，水平方向以人物为中心裁切。
 * 全屏的区域是整张画布；分屏的区域是分界线以下。分屏时把头顶放在分界线下 HEAD_GAP，且上不露分界线以上、下不露画布底。
 */
export function personTransform(layout: 'split' | 'full', subject: SubjectBox | null, videoW: number, videoH: number): PersonTransform {
  const regionH = layout === 'full' ? CANVAS.height : CANVAS.height - CANVAS.seam;
  const scale = Math.max(CANVAS.width / videoW, regionH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  const x = centerX(subject, w);
  if (layout === 'full') return { scale, x, y: Math.round((CANVAS.height - h) / 2) };
  const top = subject?.top ?? DEFAULT_TOP;
  const wanted = CANVAS.seam + HEAD_GAP - top * h;
  const y = Math.min(CANVAS.seam, Math.max(CANVAS.height - h, wanted));
  return { scale, x, y };
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
