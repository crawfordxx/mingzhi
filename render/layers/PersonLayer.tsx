import React from 'react';
import { OffthreadVideo, staticFile } from 'remotion';
import { FULL_CLIP, LAYOUT_TRANSITION_SEC, PIP, blendTransform, personTransform, shotAt, visualLayout, type PersonTransform } from '../../src/compose/layout.js';
import type { Shot, TalkProps } from '../../src/storyboard/schema.js';

/** 版式切换的过渡时长（秒），定义在 compose/layout（素材垫底与分段指纹共用） */
export { LAYOUT_TRANSITION_SEC };
const ease = (t: number): number => 1 - (1 - t) ** 3;

/** 第 i 个镜头的目标位置：全屏插入时人像被素材盖住，停在上一个镜头结束时的位置（切回同版式时不动）；首个镜头按全屏 */
function targetOf(shots: Shot[], i: number, p: TalkProps): PersonTransform {
  const layout = visualLayout(shots[i]);
  if (layout !== 'broll') return personTransform(layout, p.subject, p.personWidth, p.personHeight);
  if (i === 0) return personTransform('full', p.subject, p.personWidth, p.personHeight);
  const prev = shots[i - 1];
  return transformIn(shots, i - 1, prev.end - prev.start, p);
}

/** 第 i 个镜头开始后 t 秒的人像位置：前 LAYOUT_TRANSITION_SEC 内从上一个镜头结束时的实际位置缓动到本镜头版式（上一个镜头短于过渡时长时，它结束时可能还在半路） */
function transformIn(shots: Shot[], i: number, t: number, p: TalkProps): PersonTransform {
  const target = targetOf(shots, i, p);
  if (i === 0 || t >= LAYOUT_TRANSITION_SEC) return target;
  const prev = shots[i - 1];
  const from = transformIn(shots, i - 1, prev.end - prev.start, p);
  return blendTransform(from, target, ease(Math.max(0, t) / LAYOUT_TRANSITION_SEC));
}

/** 当前时刻人像的位置；不在任何镜头内时按全屏。shots 应为画面时间轴（visualShots 之后） */
export function transformAt(shots: Shot[], sec: number, p: TalkProps): PersonTransform {
  const hit = shotAt(shots, sec);
  if (!hit) return personTransform('full', p.subject, p.personWidth, p.personHeight);
  return transformIn(shots, hit.index, sec - hit.shot.start, p);
}

/** 画中画的描边与阴影强度：随窗口圆角从 0（全屏）到 1（小窗）连续变化，收拢过程中逐渐出现 */
const chromeOf = (radius: number): number => Math.min(1, Math.max(0, radius / PIP.radius));

/** 人像：在可见窗口（全屏时为整张画布）里按缩放与位置放视频；画中画带白色细描边与柔和投影 */
export const PersonLayer: React.FC<TalkProps & { sec: number }> = (p) => {
  const t = transformAt(p.shots, p.sec, p);
  const c = t.clip ?? FULL_CLIP;
  const k = chromeOf(c.radius);
  return (
    <div style={{ position: 'absolute', left: c.x, top: c.y, width: c.w, height: c.h, borderRadius: c.radius, overflow: 'hidden',
      boxShadow: k > 0 ? `0 ${28 * k}px ${72 * k}px rgba(0, 0, 0, ${0.42 * k}), 0 ${6 * k}px ${18 * k}px rgba(0, 0, 0, ${0.22 * k})` : undefined }}>
      <div style={{ position: 'absolute', left: t.x - c.x, top: t.y - c.y, width: p.personWidth * t.scale, height: p.personHeight * t.scale }}>
        <OffthreadVideo src={staticFile(p.person)} style={{ width: '100%', height: '100%' }} />
      </div>
      {k > 0 ? <div style={{ position: 'absolute', inset: 0, borderRadius: c.radius, boxShadow: `inset 0 0 0 ${3 * k}px rgba(255, 255, 255, ${0.92 * k})` }} /> : null}
    </div>
  );
};
