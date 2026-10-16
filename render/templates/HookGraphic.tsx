import React from 'react';
import { AbsoluteFill } from 'remotion';
import { THEME } from '../theme.js';
import { textEm, type PropsOf } from './parts.js';

/**
 * 钩子没有素材时的本地图形兜底（不是纯文字黑底）：大号关键词缓慢横移的动态排版 + 同心圆、旋转弧段、环绕光点与点阵（单双张左右镜像）。
 * 全部由帧时间驱动、从第 0 帧起就是完整构图（不从空白画出来）
 */
const LIME = THEME.hookLime;
const lime = (a: number): string => `rgba(212, 242, 60, ${a})`;
const W = 1080;
const H = 960;
/** 同心圆的圆心与半径：单数张在右上、双数张镜像到左上（同一组钩子不重复构图） */
const CENTERS = [{ x: 842, y: 330 }, { x: 238, y: 300 }] as const;
const R1 = 236;
const R2 = 168;
const ARC = 2 * Math.PI * R1;
/** 关键词：字宽撑到画面的 1.45 倍左右，夹在 260–600px */
const WORD_W = W * 1.45;
const WORD_MIN = 260;
const WORD_MAX = 600;
/** 关键词每秒横移多少 px、弧段每秒转多少度、光点每秒绕多少度 */
const DRIFT = 16;
const ARC_SPIN = 26;
const ORBIT = -40;
const GRID = { cols: 7, rows: 4, gap: 34, y: 196 } as const;
/** 点阵放在圆的另一侧 */
const gridX = (cx: number): number => (cx > W / 2 ? 72 : W - 72 - (GRID.cols - 1) * GRID.gap);

/** 关键词：第一个高亮词 → 数据值 → 标题前 4 个字 */
export function hookKeyword(props: PropsOf<'hook'>): string {
  return props.highlight[0] ?? props.stat?.value ?? [...props.headline].slice(0, 4).join('');
}

const wordPx = (word: string): number => Math.max(WORD_MIN, Math.min(WORD_MAX, Math.floor(WORD_W / Math.max(1, textEm(word)))));

const Rings: React.FC<{ local: number; C: { x: number; y: number } }> = ({ local, C }) => {
  const orbit = ((local * ORBIT - 40) * Math.PI) / 180;
  return (
    <svg width={W} height={H} style={{ position: 'absolute', inset: 0 }}>
      <line x1={0} y1={C.y} x2={W} y2={C.y} stroke={lime(0.1)} strokeWidth={1.5} />
      <line x1={C.x} y1={0} x2={C.x} y2={H} stroke={lime(0.1)} strokeWidth={1.5} />
      <circle cx={C.x} cy={C.y} r={R1} fill="none" stroke={lime(0.26)} strokeWidth={2} />
      <circle cx={C.x} cy={C.y} r={R2} fill="none" stroke={lime(0.34)} strokeWidth={2} strokeDasharray="4 12" transform={`rotate(${-local * 10} ${C.x} ${C.y})`} />
      <circle cx={C.x} cy={C.y} r={R1} fill="none" stroke={LIME} strokeWidth={7} strokeLinecap="round" strokeDasharray={`${ARC * 0.16} ${ARC}`} transform={`rotate(${local * ARC_SPIN - 120} ${C.x} ${C.y})`} />
      <circle cx={C.x + R2 * Math.cos(orbit)} cy={C.y + R2 * Math.sin(orbit)} r={9} fill={LIME} />
      <circle cx={C.x} cy={C.y} r={5} fill={lime(0.6)} />
      {Array.from({ length: GRID.cols * GRID.rows }, (_, k) => (
        <circle key={k} cx={gridX(C.x) + (k % GRID.cols) * GRID.gap} cy={GRID.y + Math.floor(k / GRID.cols) * GRID.gap} r={3} fill={lime(0.22)} />
      ))}
    </svg>
  );
};

/** 图形兜底底图：暗底 + 光晕 + 同心圆几何 + 底部大号关键词（实心淡色与描边各一层，缓慢反向横移形成视差） */
export const HookGraphic: React.FC<{ props: PropsOf<'hook'>; local: number }> = ({ props, local }) => {
  const word = hookKeyword(props);
  const C = CENTERS[(props.index - 1) % CENTERS.length];
  const px = wordPx(word);
  const base: React.CSSProperties = { position: 'absolute', left: -20, bottom: -px * 0.2, fontFamily: THEME.font, fontSize: px, fontWeight: 900, lineHeight: 1, letterSpacing: '-0.04em', whiteSpace: 'nowrap' };
  return (
    <AbsoluteFill style={{ background: THEME.hookBg, overflow: 'hidden' }}>
      <AbsoluteFill style={{ background: `radial-gradient(circle at ${(C.x / W) * 100}% ${(C.y / H) * 100}%, ${lime(0.16)} 0%, ${lime(0.04)} 32%, rgba(0, 0, 0, 0) 60%)` }} />
      <div style={{ ...base, color: lime(0.08), transform: `translateX(${-local * DRIFT}px)` }}>{word}</div>
      <div style={{ ...base, color: 'transparent', WebkitTextStroke: `2px ${lime(0.22)}`, transform: `translate(${60 + local * DRIFT * 0.6}px, ${-px * 0.08}px)` }}>{word}</div>
      <Rings local={local} C={C} />
    </AbsoluteFill>
  );
};
