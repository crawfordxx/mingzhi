import React from 'react';
import { Easing, interpolate } from 'remotion';

/** 光标的一次点击：在 t 秒点到 (x, y) */
export interface Click { x: number; y: number; t: number }
export interface Point { x: number; y: number }

/** 每段移动耗时、到位后停顿多久再按下（秒） */
const TRAVEL = 0.35;
const DWELL = 0.1;
const FADE_IN = 0.15;
const RING_SEC = 0.4;
const PRESS_SEC = 0.16;
const CURSOR_PX = 52;
const RING_COLOR = '#FF5A4E';

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const glide = Easing.inOut(Easing.cubic);

export interface CursorState { x: number; y: number; opacity: number; clickAge: number | null }

/** 光标在 local 秒的状态：从 start 出发，依次滑到每个点击点（到位停顿 DWELL 后按下）；之后停在最后一个点上 */
export function cursorAt(local: number, start: Point, clicks: Click[]): CursorState {
  const pos = clicks.reduce<Point>((from, c) => {
    const p = glide(clamp01((local - (c.t - DWELL - TRAVEL)) / TRAVEL));
    return { x: from.x + (c.x - from.x) * p, y: from.y + (c.y - from.y) * p };
  }, start);
  const appear = clicks.length ? clicks[0].t - DWELL - TRAVEL - FADE_IN : 0;
  const last = [...clicks].reverse().find((c) => c.t <= local);
  return { ...pos, opacity: clicks.length ? clamp01((local - appear) / FADE_IN) : 0, clickAge: last ? local - last.t : null };
}

/** 箭头光标（SVG，尖端对准 (x, y)）；按下时略缩小，尖端扩散一圈红色波纹 */
export const Cursor: React.FC<{ state: CursorState }> = ({ state }) => {
  const { x, y, opacity, clickAge } = state;
  if (opacity <= 0) return null;
  const age = clickAge ?? Infinity;
  const ring = clamp01(age / RING_SEC);
  const press = age < PRESS_SEC ? Math.sin((Math.PI * age) / PRESS_SEC) : 0;
  return (
    <div style={{ position: 'absolute', left: x, top: y, opacity, pointerEvents: 'none', zIndex: 10 }}>
      {age < RING_SEC ? (
        <div style={{ position: 'absolute', left: 0, top: 0, width: 72, height: 72, borderRadius: 36, border: `4px solid ${RING_COLOR}`, boxSizing: 'border-box',
          opacity: 1 - ring, transform: `translate(-50%, -50%) scale(${interpolate(ring, [0, 1], [0.2, 1], { easing: Easing.out(Easing.cubic) })})` }} />
      ) : null}
      <svg width={CURSOR_PX} height={CURSOR_PX} viewBox="0 0 24 24" style={{ position: 'absolute', left: -6, top: -4, transform: `scale(${1 - press * 0.14})`, transformOrigin: '6px 4px',
        filter: 'drop-shadow(0 3px 5px rgba(0, 0, 0, 0.35))' }}>
        <path d="M3 2 L3 20.5 L7.6 16.4 L10.6 23.2 L13.9 21.8 L10.9 15 L17 15 Z" fill="#111111" stroke="#FFFFFF" strokeWidth={1.6} strokeLinejoin="round" />
      </svg>
    </div>
  );
};
