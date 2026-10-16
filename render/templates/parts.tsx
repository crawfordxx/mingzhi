import React from 'react';
import { Easing, interpolate, spring } from 'remotion';
import type { CardSpec, TemplateId } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

/** 某个模板的 props 类型 */
export type PropsOf<T extends TemplateId> = Extract<CardSpec, { template: T }>['props'];
/** local：镜头内秒数（从 0 开始）；dur：镜头总时长（秒），用来在出场前收拢动画 */
export type TemplateProps<T extends TemplateId> = { props: PropsOf<T>; local: number; dur: number };

/** 卡片出场：镜头最后 EXIT_SEC 秒淡出（CardLayer 与各模板的节奏收拢共用） */
export const EXIT_SEC = 0.25;

/** 卡片区安全区：左右边距 48；上方避开平台状态栏，下方给压在分界线（960）上的字幕留出 90px */
export const SAFE = { side: 48, top: 150, bottom: 870 } as const;
export const CONTENT_W = 1080 - SAFE.side * 2;
export const SAFE_H = SAFE.bottom - SAFE.top;

// ---------- 文字尺寸估算（不量 DOM：CJK 按 1em；W/M 约 0.9em，其他大写 0.7em，数字 0.6em，小写与其余 ASCII 约 0.55em） ----------

/** 单行不折行（nowrap）时的宽度余量，弥补估算误差 */
const ONE_LINE_MARGIN = 0.94;

const charEm = (ch: string): number => {
  if (ch === ' ') return 0.3;
  if (ch === 'W' || ch === 'M') return 0.9;
  if (/[A-Z]/.test(ch)) return 0.7;
  if (/[0-9]/.test(ch)) return 0.6;
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

/** 让文字放进 maxWidthPx：优先少折行——能以不小于 minPx 的字号排成 1 行就排 1 行（留 6% 余量），否则再试 2 行……；字号不超过 basePx，放不下时取 minPx（由 clampLines 兜底） */
export function fitFontSize(text: string, maxWidthPx: number, basePx: number, minPx: number, maxLines = 1): number {
  for (let lines = 1; lines <= maxLines; lines++) {
    const px = maxFontSize(text, lines === 1 ? maxWidthPx * ONE_LINE_MARGIN : maxWidthPx, lines);
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

/**
 * 卡片画在什么底上：paper 米色卡片区（默认）；image 分屏上半屏的素材图上（内容贴安全区底部、压在渐变暗部，白卡变磨砂玻璃）；
 * float 人物全屏上的顶部浮层（贴顶、白卡变磨砂玻璃）。玻璃卡内部重新回到 paper（深色字照常可读）
 */
export type Surface = 'paper' | 'image' | 'float';
export const SurfaceContext = React.createContext<Surface>('paper');

/** 磨砂玻璃卡：浅暖白半透明 + 背景模糊 + 内描边高光 + 深一点的投影（压在图像或人物上） */
export const GLASS: React.CSSProperties = {
  background: 'rgba(250, 248, 244, 0.8)', backdropFilter: 'blur(28px) saturate(1.3)', WebkitBackdropFilter: 'blur(28px) saturate(1.3)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.28), 0 4px 14px rgba(0, 0, 0, 0.12), inset 0 0 0 1.5px rgba(255, 255, 255, 0.55)',
};

/** 安全区容器：纸面与浮层时内容贴安全区顶部排（下方留给字幕），图上时贴底部排；scale < 1 时以贴边为基准整体缩小；glass 时在图上/浮层里给无卡框的模板套一层玻璃卡 */
export const SafeArea: React.FC<{ scale?: number; glass?: boolean; children: React.ReactNode }> = ({ scale = 1, glass = false, children }) => {
  const surface = React.useContext(SurfaceContext);
  const bottom = surface === 'image';
  const body = glass && surface !== 'paper'
    ? <div style={{ ...GLASS, borderRadius: THEME.radius, padding: '40px 44px 44px' }}><SurfaceContext.Provider value="paper">{children}</SurfaceContext.Provider></div>
    : children;
  return (
    <div style={{ position: 'absolute', left: SAFE.side, right: SAFE.side, top: SAFE.top, height: SAFE_H, display: 'flex', flexDirection: 'column', justifyContent: bottom ? 'flex-end' : 'flex-start', fontFamily: THEME.font, color: THEME.ink }}>
      <div style={{ transform: `scale(${scale})`, transformOrigin: bottom ? 'bottom center' : 'top center' }}>{body}</div>
    </div>
  );
};

/** 白色圆角卡片；在图上或浮层里变成磨砂玻璃卡 */
export const CardFrame: React.FC<{ padding?: string; style?: React.CSSProperties; children: React.ReactNode }> = ({ padding = '44px 48px', style, children }) => {
  const surface = React.useContext(SurfaceContext);
  const skin: React.CSSProperties = surface === 'paper' ? { background: THEME.card, boxShadow: THEME.shadow } : GLASS;
  return (
    <div style={{ ...skin, borderRadius: THEME.radius, padding, ...style }}>
      <SurfaceContext.Provider value="paper">{children}</SurfaceContext.Provider>
    </div>
  );
};

/** 面包屑：橙点 + 小字；直接压在图上或人物上时字改为近白（不给 color 时） */
export const Crumb: React.FC<{ text: string; size?: number; maxWidth?: number; color?: string }> = ({ text, size = 26, maxWidth = CONTENT_W, color }) => {
  const surface = React.useContext(SurfaceContext);
  const ink = color ?? (surface === 'paper' ? THEME.sub : 'rgba(255, 255, 255, 0.92)');
  const px = fitFontSize(text, maxWidth - 30, size, 18);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: px, fontWeight: 600, color: ink, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
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
