import { FULL_CLIP, shotAt, visualLayout } from '../../src/compose/layout.js';
import type { TalkProps } from '../../src/storyboard/schema.js';
import { transformAt } from './PersonLayer.js';
import type { PixelRegion } from './grain-field.js';

/**
 * 某一时刻人物在画布上的区域（像素）：人物框按当前缩放与位置映射到画布，再与可见窗口（全屏为整张画布，画中画为小窗，分屏为分界线以下）取交集。
 * 没有人物框时保守地取整块人像视频；全屏插入素材时人物被盖住，返回 null；交集为空也返回 null。
 * props.shots 应为画面时间轴（visualShots 之后），sec 用画面时间
 */
export function personRegionAt(props: TalkProps, sec: number): PixelRegion | null {
  const hit = shotAt(props.shots, sec);
  if (hit && visualLayout(hit.shot) === 'broll') return null;
  const t = transformAt(props.shots, sec, props);
  const clip = t.clip ?? FULL_CLIP;
  const vw = props.personWidth * t.scale;
  const vh = props.personHeight * t.scale;
  const s = props.subject;
  const box = s
    ? { left: t.x + s.left * vw, top: t.y + s.top * vh, right: t.x + s.right * vw, bottom: t.y + s.bottom * vh }
    : { left: t.x, top: t.y, right: t.x + vw, bottom: t.y + vh };
  const left = Math.max(box.left, clip.x);
  const top = Math.max(box.top, clip.y);
  const right = Math.min(box.right, clip.x + clip.w);
  const bottom = Math.min(box.bottom, clip.y + clip.h);
  return right > left && bottom > top ? { x: left, y: top, w: right - left, h: bottom - top } : null;
}
