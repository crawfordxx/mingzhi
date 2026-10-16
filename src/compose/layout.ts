import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';
import { FULL_CAPTION_Y } from '../captions/styles.js';
import { CANVAS, type Layout, type Rect, type Shot } from '../storyboard/schema.js';

export type { Rect } from '../storyboard/schema.js';

/** 人像可见窗口（画布坐标）；radius 为圆角，同时决定画中画描边与阴影的强度 */
export interface PersonClip { x: number; y: number; w: number; h: number; radius: number }
/** 人像视频的缩放与左上角位置；clip 省略表示整张画布可见（全屏、分屏） */
export interface PersonTransform { scale: number; x: number; y: number; clip?: PersonClip }
/** 分屏时头顶距分界线的距离（px） */
const HEAD_GAP = 60;
/** 抠不出人时按头顶在画面 12% 处估计 */
const DEFAULT_TOP = 0.12;

/**
 * 画中画窗口：360×480，右缘对齐字幕安全线（x=960，右侧 960–1080 是平台点赞栏），
 * 底边 1290 留在 y=1400 的两行字幕上方，人物不与字幕、平台按钮打架
 */
export const PIP = { x: 600, y: 810, w: 360, h: 480, radius: 36 } as const;
/** 画中画在铺满窗口的基础上再放大，取半身景 */
const PIP_ZOOM = 1.2;
/** 画中画里头顶距窗口上沿的比例 */
const PIP_HEAD = 0.1;
/** 整张画布的窗口（插值用） */
export const FULL_CLIP: PersonClip = { x: 0, y: 0, w: CANVAS.width, h: CANVAS.height, radius: 0 };

/** 全屏插入的 J-cut：画面比声音晚几帧切入 */
export const J_CUT_FRAMES = 2;

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** 线性插值；两端相同直接返回（避免浮点误差让「不动」变成「微动」） */
const mix = (p: number, q: number, t: number): number => (p === q ? p : p * (1 - t) + q * t);

/** 实际渲染的版式：broll/pip 没有素材、overlay 既无卡片也无素材时按全屏（坏数据不画空窗或空卡） */
export function visualLayout(shot: Shot): Layout {
  if ((shot.layout === 'broll' || shot.layout === 'pip') && !shot.broll) return 'full';
  if (shot.layout === 'overlay' && !shot.card && !shot.broll) return 'full';
  return shot.layout;
}

/** 字幕中心 y：分屏压在分界线上；其余版式（含全屏插入、画中画、浮层）在 y=1400 */
export function captionCenterY(layout: Layout): number {
  return layout === 'split' ? CANVAS.seam : FULL_CAPTION_Y;
}

/** 人物水平中心对齐画布中线，并夹住不让视频两侧露出底色 */
function centerX(subject: SubjectBox | null, w: number): number {
  const cx = subject ? (subject.left + subject.right) / 2 : 0.5;
  return Math.round(Math.min(0, Math.max(CANVAS.width - w, CANVAS.width / 2 - cx * w)));
}

/** 画中画：视频铺满窗口再放大 PIP_ZOOM，人物水平居中、头顶在窗口上方 PIP_HEAD 处，夹住不露底 */
function pipTransform(subject: SubjectBox | null, videoW: number, videoH: number): PersonTransform {
  const scale = Math.max(PIP.w / videoW, PIP.h / videoH) * PIP_ZOOM;
  const w = videoW * scale;
  const h = videoH * scale;
  const cx = subject ? (subject.left + subject.right) / 2 : 0.5;
  const top = subject?.top ?? DEFAULT_TOP;
  const x = PIP.x + clamp(PIP.w / 2 - cx * w, PIP.w - w, 0);
  const y = PIP.y + clamp(PIP.h * PIP_HEAD - top * h, PIP.h - h, 0);
  return { scale, x, y, clip: { x: PIP.x, y: PIP.y, w: PIP.w, h: PIP.h, radius: PIP.radius } };
}

/**
 * 视频铺满人像区域（cover）：竖屏按宽铺满；横屏等更宽的视频按区域高度放大，水平方向以人物为中心裁切。
 * 全屏的区域是整张画布；分屏的区域是分界线以下。分屏时把头顶放在分界线下 HEAD_GAP，且上不露分界线以上、下不露画布底。
 * 画中画缩进右下小窗；浮层、全屏插入与全屏相同（全屏插入时人像被素材盖住，位置由 PersonLayer 保持不动）
 */
export function personTransform(layout: Layout, subject: SubjectBox | null, videoW: number, videoH: number): PersonTransform {
  if (layout === 'pip') return pipTransform(subject, videoW, videoH);
  const isSplit = layout === 'split';
  const regionH = isSplit ? CANVAS.height - CANVAS.seam : CANVAS.height;
  const scale = Math.max(CANVAS.width / videoW, regionH / videoH);
  const w = videoW * scale;
  const h = videoH * scale;
  const x = centerX(subject, w);
  if (!isSplit) return { scale, x, y: Math.round((CANVAS.height - h) / 2) };
  const top = subject?.top ?? DEFAULT_TOP;
  const wanted = CANVAS.seam + HEAD_GAP - top * h;
  const y = Math.min(CANVAS.seam, Math.max(CANVAS.height - h, wanted));
  return { scale, x, y };
}

/** 两个人像状态之间插值；任一端有窗口时窗口也插值（另一端按整张画布） */
export function blendTransform(a: PersonTransform, b: PersonTransform, t: number): PersonTransform {
  const base = { scale: mix(a.scale, b.scale, t), x: mix(a.x, b.x, t), y: mix(a.y, b.y, t) };
  if (!a.clip && !b.clip) return base;
  const ca = a.clip ?? FULL_CLIP;
  const cb = b.clip ?? FULL_CLIP;
  return { ...base, clip: { x: mix(ca.x, cb.x, t), y: mix(ca.y, cb.y, t), w: mix(ca.w, cb.w, t), h: mix(ca.h, cb.h, t), radius: mix(ca.radius, cb.radius, t) } };
}

const jCuts = (shots: Shot[], i: number): boolean => {
  const delay = J_CUT_FRAMES / CANVAS.fps;
  const s = shots[i];
  return i > 0 && visualLayout(s) === 'broll' && s.end - s.start - delay >= 1 / CANVAS.fps - 1e-9;
};

/**
 * 画面时间轴：全屏插入镜头的画面晚 J_CUT_FRAMES 帧切入（声音与字幕仍按原时间，形成 J-cut），
 * 前一个镜头的画面相应延长到切入点。不足 3 帧的插入镜头、首个镜头不做。返回新数组，不改入参
 */
export function visualShots(shots: Shot[]): Shot[] {
  const delay = J_CUT_FRAMES / CANVAS.fps;
  return shots.map((s, i) => {
    const late = jCuts(shots, i) ? { start: s.start + delay } : {};
    const next = shots[i + 1];
    const extend = next && jCuts(shots, i + 1) && Math.abs(s.end - next.start) < 1e-6 ? { end: next.start + delay } : {};
    return { ...s, ...late, ...extend };
  });
}

// ---------- Ken Burns：起止裁框由主体焦点计算 ----------

/** 起点先放大到 1.06（留出平移余量），终点再推近 10%（8–12% 之间） */
const KB_START_ZOOM = 1.06;
export const KB_PUSH = 0.1;
/** 起点中心从画面中心朝焦点偏移的比例（终点落在焦点上，形成推向主体的运动） */
const KB_FROM_PULL = 0.25;

/** 以 (cx, cy) 为中心、边长 w 的同比例裁框，夹在画面内 */
function rectAround(cx: number, cy: number, w: number): Rect {
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - w / 2, 0, 1 - w), w, h: w };
}

/** 推向主体：起点接近画面中心，终点以焦点为中心并推近 KB_PUSH；两框都不出画 */
export function kenBurnsRects(focal: { x: number; y: number }): { from: Rect; to: Rect } {
  const wFrom = 1 / KB_START_ZOOM;
  const wTo = wFrom / (1 + KB_PUSH);
  const from = rectAround(0.5 + (focal.x - 0.5) * KB_FROM_PULL, 0.5 + (focal.y - 0.5) * KB_FROM_PULL, wFrom);
  return { from, to: rectAround(focal.x, focal.y, wTo) };
}

/** 进度 t（0–1，越界夹住）处的裁框：sin 型 inOut 缓动 */
export function kenBurnsAt(kb: { from: Rect; to: Rect }, t: number): Rect {
  const e = (1 - Math.cos(Math.PI * clamp(t, 0, 1))) / 2;
  const { from: a, to: b } = kb;
  return { x: mix(a.x, b.x, e), y: mix(a.y, b.y, e), w: mix(a.w, b.w, e), h: mix(a.h, b.h, e) };
}

export function captionAt(captions: TimedCaption[], sec: number): TimedCaption | null {
  return captions.find((c) => sec >= c.start && sec < c.end) ?? null;
}

export function shotAt(shots: Shot[], sec: number): { shot: Shot; index: number } | null {
  const index = shots.findIndex((s) => sec >= s.start && sec < s.end);
  return index < 0 ? null : { shot: shots[index], index };
}
