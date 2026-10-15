import React from 'react';
import { OffthreadVideo, staticFile } from 'remotion';
import { blendTransform, personTransform, shotAt } from '../../src/compose/layout.js';
import type { Shot, TalkProps } from '../../src/storyboard/schema.js';

/** 分屏/全屏切换的过渡时长（秒） */
export const LAYOUT_TRANSITION_SEC = 0.4;
const ease = (t: number): number => 1 - (1 - t) ** 3;

/** 当前时刻人像的位置：镜头开始的 LAYOUT_TRANSITION_SEC 内从上一个镜头的版式过渡过来 */
function transformAt(shots: Shot[], sec: number, p: TalkProps) {
  const hit = shotAt(shots, sec);
  const layout = hit?.shot.layout ?? 'full';
  const target = personTransform(layout, p.subject, p.personWidth, p.personHeight);
  if (!hit || hit.index === 0) return target;
  const prev = shots[hit.index - 1];
  const t = (sec - hit.shot.start) / LAYOUT_TRANSITION_SEC;
  if (prev.layout === layout || t >= 1) return target;
  return blendTransform(personTransform(prev.layout, p.subject, p.personWidth, p.personHeight), target, ease(Math.max(0, t)));
}

export const PersonLayer: React.FC<TalkProps & { sec: number }> = (p) => {
  const t = transformAt(p.shots, p.sec, p);
  return (
    <div style={{ position: 'absolute', left: t.x, top: t.y, width: p.personWidth * t.scale, height: p.personHeight * t.scale, overflow: 'hidden' }}>
      <OffthreadVideo src={staticFile(p.person)} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};
