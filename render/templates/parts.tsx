import React from 'react';
import { Easing, interpolate, spring } from 'remotion';
import type { CardSpec, TemplateId } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

/** 某个模板的 props 类型 */
export type PropsOf<T extends TemplateId> = Extract<CardSpec, { template: T }>['props'];
export type TemplateProps<T extends TemplateId> = { props: PropsOf<T>; local: number };

/** 卡片区安全区：左右边距 60；上方避开平台状态栏，下方避开压在分界线上的字幕 */
export const SAFE = { side: 60, top: 120, bottom: 850 } as const;
export const CONTENT_W = 1080 - SAFE.side * 2;
export const SAFE_H = SAFE.bottom - SAFE.top;

// ---------- 文字尺寸估算（不量 DOM：CJK 按 1em，ASCII 约 0.55em） ----------

const charEm = (ch: string): number => {
  if (ch === ' ') return 0.3;
  return ch.charCodeAt(0) < 128 ? 0.55 : 1;
};

/** 估算一段文字的宽度（em） */
export function textEm(text: string): number {
  return [...text].reduce((sum, ch) => sum + charEm(ch), 0);
}

/** n 行放下整段文字的最大字号；多行时每行预留 1 个字的断行损耗 */
export function maxFontSize(text: string, widthPx: number, lines: number): number {
  const em = textEm(text) + (lines - 1);
  return em <= 0 ? Infinity : Math.floor((widthPx * lines) / em);
}

/** 让文字放进 maxWidthPx：优先少折行——能以不小于 minPx 的字号排成 1 行就排 1 行，否则再试 2 行……；字号不超过 basePx，放不下时取 minPx（由 clampLines 兜底） */
export function fitFontSize(text: string, maxWidthPx: number, basePx: number, minPx: number, maxLines = 1): number {
  for (let lines = 1; lines <= maxLines; lines++) {
    const px = maxFontSize(text, maxWidthPx, lines);
    if (px >= minPx) return Math.min(basePx, px);
  }
  return minPx;
}

/** 估算文字在给定字号与行宽下占几行 */
export function lineCount(text: string, widthPx: number, fontPx: number): number {
  return Math.max(1, Math.ceil((textEm(text) * fontPx) / widthPx));
}

/** 内容估算高度超过可用高度时的整体缩放系数 */
export function fitScale(estimatedPx: number, availablePx = SAFE_H, minScale = 0.7): number {
  return Math.max(minScale, Math.min(1, availablePx / estimatedPx));
}

// ---------- 帧驱动的动画进度 ----------

const SOFT = { damping: 18, mass: 0.7 };

/** 从 delay 秒开始的弹簧进度（0→1，可能略过冲） */
export function springAt(local: number, delay: number, fps: number, config: { damping?: number; mass?: number } = SOFT): number {
  return spring({ frame: Math.max(0, (local - delay) * fps), fps, config });
}

/** 从 delay 秒开始、dur 秒内缓出的进度（0→1） */
export function easeAt(local: number, delay: number, dur: number): number {
  return interpolate(local, [delay, delay + dur], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.out(Easing.cubic) });
}

/** 按进度 p 淡入并位移/缩放到位 */
export const Reveal: React.FC<{ p: number; dx?: number; dy?: number; from?: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ p, dx = 0, dy = 24, from = 1, style, children }) => (
  <div style={{ ...style, opacity: Math.min(1, Math.max(0, p)), transform: `translate(${(1 - p) * dx}px, ${(1 - p) * dy}px) scale(${from + (1 - from) * p})` }}>
    {children}
  </div>
);

// ---------- 共用小部件 ----------

/** 安全区容器：内容在安全区内垂直居中；scale < 1 时整体缩小 */
export const SafeArea: React.FC<{ scale?: number; children: React.ReactNode }> = ({ scale = 1, children }) => (
  <div style={{ position: 'absolute', left: SAFE.side, right: SAFE.side, top: SAFE.top, height: SAFE_H, display: 'flex', flexDirection: 'column', justifyContent: 'center', fontFamily: THEME.font, color: THEME.ink }}>
    <div style={{ transform: `scale(${scale})`, transformOrigin: 'center center' }}>{children}</div>
  </div>
);

/** 白色圆角卡片 */
export const CardFrame: React.FC<{ padding?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ padding = '44px 48px', style, children }) => (
  <div style={{ background: THEME.card, borderRadius: THEME.radius, boxShadow: THEME.shadow, padding, ...style }}>{children}</div>
);

/** 面包屑：橙点 + 小字 */
export const Crumb: React.FC<{ text: string; size?: number; maxWidth?: number; color?: string }> = ({ text, size = 26, maxWidth = CONTENT_W, color = THEME.sub }) => {
  const px = fitFontSize(text, maxWidth - 30, size, 18);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: px, fontWeight: 600, color, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
      <span style={{ width: 11, height: 11, borderRadius: 6, background: THEME.crumbDot, flex: 'none' }} />
      <span>{text}</span>
    </div>
  );
};

export const BADGE_PAD_X = 26;

/** 彩色胶囊标签（白字）；不给 width 时左右内边距 BADGE_PAD_X */
export const Badge: React.FC<{ text: string; color: string; size?: number; width?: number; height?: number }> = ({ text, color, size = 26, width, height = 50 }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flex: 'none', width, height, padding: width ? 0 : `0 ${BADGE_PAD_X}px`,
    borderRadius: height / 2, background: color, color: '#FFFFFF', fontSize: size, fontWeight: 700, letterSpacing: '0.04em', whiteSpace: 'nowrap' }}>
    {text}
  </div>
);

/** 多行截断（估算字号的兜底，保证不溢出） */
export const clampLines = (lines: number): React.CSSProperties => ({ display: '-webkit-box', WebkitLineClamp: lines, WebkitBoxOrient: 'vertical', overflow: 'hidden' });
