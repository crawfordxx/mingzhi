import React from 'react';
import { OffthreadVideo, staticFile } from 'remotion';
import { blendTransform, personTransform, shotAt, type PersonTransform } from '../../src/compose/layout.js';
import type { Shot, TalkProps } from '../../src/storyboard/schema.js';

/** 分屏/全屏切换的过渡时长（秒） */
export const LAYOUT_TRANSITION_SEC = 0.4;
const ease = (t: number): number => 1 - (1 - t) ** 3;

/** 第 i 个镜头开始后 t 秒的人像位置：前 LAYOUT_TRANSITION_SEC 内从上一个镜头结束时的实际位置缓动到本镜头版式（上一个镜头短于过渡时长时，它结束时可能还在半路） */
function transformIn(shots: Shot[], i: number, t: number, p: TalkProps): PersonTransform {
  const target = personTransform(shots[i].layout, p.subject, p.personWidth, p.personHeight);
  if (i === 0 || t >= LAYOUT_TRANSITION_SEC) return target;
  const prev = shots[i - 1];
  const from = transformIn(shots, i - 1, prev.end - prev.start, p);
  return blendTransform(from, target, ease(Math.max(0, t) / LAYOUT_TRANSITION_SEC));
}

/** 当前时刻人像的位置；不在任何镜头内时按全屏 */
export function transformAt(shots: Shot[], sec: number, p: TalkProps): PersonTransform {
  const hit = shotAt(shots, sec);
  if (!hit) return personTransform('full', p.subject, p.personWidth, p.personHeight);
  return transformIn(shots, hit.index, sec - hit.shot.start, p);
}

export const PersonLayer: React.FC<TalkProps & { sec: number }> = (p) => {
  const t = transformAt(p.shots, p.sec, p);
  return (
    <div style={{ position: 'absolute', left: t.x, top: t.y, width: p.personWidth * t.scale, height: p.personHeight * t.scale, overflow: 'hidden' }}>
      <OffthreadVideo src={staticFile(p.person)} style={{ width: '100%', height: '100%' }} />
    </div>
  );
};
