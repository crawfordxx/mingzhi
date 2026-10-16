export interface Size { width: number; height: number }
/** 主体位置，0–1 相对源画面宽高 */
export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
/** 分辨率不够铺满时的降级版式：split 只占上半屏，pip 小窗 */
export type Downgrade = 'pip' | 'split';
export interface CropPlan { crop: Rect; output: Size; downgrade?: Downgrade }

/** 裁框放大到目标尺寸的倍数不超过 1/0.8（=1.25×）；再大就降级，不硬放大 */
export const MIN_COVER = 0.8;
/** 裁框宽度至少是目标宽度的多少：full 铺满目标、split 退到上半屏时各自的下限 */
export interface Cover { full: number; split: number }
export const DEFAULT_COVER: Cover = { full: MIN_COVER, split: MIN_COVER };
/** 主体离中心这么近时直接居中（对称构图），不硬推到三分线 */
const CENTER_DEADZONE = 0.04;

const even = (v: number): number => Math.max(2, Math.floor(v / 2) * 2);
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** 主体在左半边放左三分线、右半边放右三分线，接近中心则居中；再夹回源画面内 */
function placeAxis(focal: number, srcLen: number, cropLen: number): number {
  if (cropLen >= srcLen) return 0;
  const anchor = Math.abs(focal - 0.5) < CENTER_DEADZONE ? 0.5 : focal < 0.5 ? 1 / 3 : 2 / 3;
  return Math.round(clamp(focal * srcLen - anchor * cropLen, 0, srcLen - cropLen));
}

/** 源画面里按 aspect（宽/高）取最大的裁框，主体落在三分线附近 */
export function thirdsCrop(src: Size, focal: Point, aspect: number): Rect {
  const wide = src.width / src.height > aspect;
  const height = even(wide ? src.height : src.width / aspect);
  const width = even(wide ? src.height * aspect : src.width);
  return { x: placeAxis(focal.x, src.width, width), y: placeAxis(focal.y, src.height, height), width, height };
}

const covers = (crop: Rect, out: Size, minCover: number): boolean => crop.width >= out.width * minCover;

/** 小窗：不裁、保持原比例，只缩不放 */
function pipPlan(src: Size, target: Size): CropPlan {
  const s = Math.min(1, target.width / src.width, target.height / src.height);
  return {
    crop: { x: 0, y: 0, width: even(src.width), height: even(src.height) },
    output: { width: even(src.width * s), height: even(src.height * s) },
    downgrade: 'pip',
  };
}

/**
 * 目标裁框：能盖住目标尺寸（缺省允许 ≤1.25× 放大，cover 可放宽）就直接裁；竖屏目标盖不住时试上半屏 split；
 * 再不行降级为 pip。返回源画面里的裁框与输出尺寸。
 */
export function planCrop(src: Size, focal: Point, target: Size, cover: Cover = DEFAULT_COVER): CropPlan {
  if (!Number.isFinite(focal.x) || !Number.isFinite(focal.y)) throw new Error(`主体位置 focal 不是有效数字：${JSON.stringify(focal)}`);
  const full = thirdsCrop(src, focal, target.width / target.height);
  if (covers(full, target, cover.full)) return { crop: full, output: target };
  if (target.height > target.width) {
    const split = { width: target.width, height: even(target.height / 2) };
    const crop = thirdsCrop(src, focal, split.width / split.height);
    if (covers(crop, split, cover.split)) return { crop, output: split, downgrade: 'split' };
  }
  return pipPlan(src, target);
}
