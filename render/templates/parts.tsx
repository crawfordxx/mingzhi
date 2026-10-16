import React from 'react';
import { Easing, interpolate, spring } from 'remotion';
import type { CardSpec, TemplateId } from '../../src/storyboard/schema.js';
import { REVEAL_TAIL_SEC } from '../../src/storyboard/reveal.js';
import { THEME } from '../theme.js';
import { glassStyle, paperCardStyle, usePalette } from '../palette.js';

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
 * float 人物全屏上的浮层（胸前下三分之一，贴底、白卡变磨砂玻璃）。玻璃卡内部重新回到 paper（深色字照常可读）
 * imageTop 同 image，但内容贴安全区顶部（整片自检的「换文字位置」）；
 */
export type Surface = 'paper' | 'image' | 'imageTop' | 'float';
export const SurfaceContext = React.createContext<Surface>('paper');

/** 磨砂玻璃卡：浅暖白半透明 + 背景模糊 + 内描边高光 + 深一点的投影（压在图像或人物上） */
export const GLASS: React.CSSProperties = {
  background: 'rgba(250, 248, 244, 0.8)', backdropFilter: 'blur(28px) saturate(1.3)', WebkitBackdropFilter: 'blur(28px) saturate(1.3)',
  boxShadow: '0 24px 64px rgba(0, 0, 0, 0.28), 0 4px 14px rgba(0, 0, 0, 0.12), inset 0 0 0 1.5px rgba(255, 255, 255, 0.55)',
};

/** 当前卡片是否铺在「铺图变体」的素材上（CardLayer 提供）：玻璃卡几乎不透明，图上的字回到纸面卡的对比度 */
export const SolidGlassContext = React.createContext(false);
/** 当前片色下的玻璃卡（铺图变体几乎不透明）；暗色片是深色玻璃 */
const useGlass = (): React.CSSProperties => glassStyle(usePalette(), React.useContext(SolidGlassContext));

/** 浮层整块卡片区的缩放（CardLayer 用）；浮层里文字的字号下限按缩放后 ≥ 28px（以 1080 宽计）折算 */
export const FLOAT_SCALE = 0.64;
export const FLOAT_MIN_PX = Math.ceil(28 / FLOAT_SCALE);
/** 当前表面的字号下限：浮层为 FLOAT_MIN_PX，其余 0。要在卡框（CardFrame / 玻璃 SafeArea）之外读（卡框内部会重置为 paper） */
export const useMinPx = (): number => (React.useContext(SurfaceContext) === 'float' ? FLOAT_MIN_PX : 0);

/**
 * 安全区容器：纸面上内容在安全区里垂直居中，带 fill 的卡框（CardFrame fill）撑满安全区（上半屏空白率 ≤ 35%）；
 * 浮层与图上时贴安全区底部排（浮层是胸前的下三分之一字条，图上压在渐变暗部）。scale < 1 时整体缩小，纸面上缩小后仍撑满安全区；
 * glass 时在图上/浮层里给无卡框的模板套一层玻璃卡
 */
export const SafeArea: React.FC<{ scale?: number; glass?: boolean; children: React.ReactNode }> = ({ scale = 1, glass = false, children }) => {
  const surface = React.useContext(SurfaceContext);
  const bottom = surface === 'image' || surface === 'float';
  const paper = surface === 'paper';
  const skin = useGlass();
  const pal = usePalette();
  const body = glass && !paper
    ? <div style={{ ...skin, borderRadius: THEME.radius, padding: '40px 44px 44px' }}><SurfaceContext.Provider value="paper">{children}</SurfaceContext.Provider></div>
    : children;
  const inner: React.CSSProperties = paper
    ? { height: SAFE_H / scale, display: 'flex', flexDirection: 'column', justifyContent: 'center', transform: `scale(${scale})`, transformOrigin: 'top center' }
    : { transform: `scale(${scale})`, transformOrigin: bottom ? 'bottom center' : 'top center' };
  return (
    <div style={{ position: 'absolute', left: SAFE.side, right: SAFE.side, top: SAFE.top, height: SAFE_H, display: 'flex', flexDirection: 'column', justifyContent: bottom ? 'flex-end' : 'flex-start', fontFamily: THEME.font, color: pal.ink }}>
      <div style={inner}>{body}</div>
    </div>
  );
};

/** 圆角卡片（片色的卡片底：亮色白卡、暗色深色卡）；在图上或浮层里变成磨砂玻璃卡。fill：纸面上撑满安全区、内容垂直居中（图上与浮层仍按内容高度） */
export const CardFrame: React.FC<{ padding?: string; fill?: boolean; style?: React.CSSProperties; children: React.ReactNode }> = ({ padding = '44px 48px', fill = false, style, children }) => {
  const surface = React.useContext(SurfaceContext);
  const glass = useGlass();
  const pal = usePalette();
  const skin: React.CSSProperties = surface === 'paper' ? paperCardStyle(pal, THEME.shadow) : glass;
  const stretch: React.CSSProperties = fill && surface === 'paper' ? { flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' } : {};
  return (
    <div style={{ ...skin, borderRadius: THEME.radius, padding, ...stretch, ...style }}>
      <SurfaceContext.Provider value="paper">{children}</SurfaceContext.Provider>
    </div>
  );
};

/** 面包屑：强调色圆点 + 小字；直接压在图上或人物上时字改为近白（不给 color 时） */
export const Crumb: React.FC<{ text: string; size?: number; maxWidth?: number; color?: string; minPx?: number }> = ({ text, size = 26, maxWidth = CONTENT_W, color, minPx = 18 }) => {
  const surface = React.useContext(SurfaceContext);
  const pal = usePalette();
  const ink = color ?? (surface === 'paper' ? pal.sub : 'rgba(255, 255, 255, 0.92)');
  const px = fitFontSize(text, maxWidth - 30, Math.max(size, minPx), minPx);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, fontSize: px, fontWeight: 600, color: ink, letterSpacing: '0.02em', whiteSpace: 'nowrap' }}>
      <span style={{ width: 11, height: 11, borderRadius: 6, background: pal.accent, flex: 'none' }} />
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

// ---------- 持续演进 ----------

/**
 * 条目出现的时刻（镜头内秒数）：reveal 条数对得上且都在 [0, dur − REVEAL_TAIL_SEC] 里就按它（随字幕逐条出现）；
 * 条数对但越界（如镜头被截短）时在镜头内均匀重排；条数不对按模板默认节奏
 */
export function itemTimes(reveal: readonly number[] | undefined, n: number, fallback: (i: number) => number, dur: number): number[] {
  if (!reveal || reveal.length !== n) return Array.from({ length: n }, (_, i) => fallback(i));
  const hi = Math.max(0, dur - REVEAL_TAIL_SEC);
  if (reveal.every((t) => t >= 0 && t <= hi + 1e-6)) return [...reveal];
  return Array.from({ length: n }, (_, i) => (n > 1 ? (i * hi) / (n - 1) : 0));
}

/** 当前点亮的条目：已出现的最后一条（都没出现时为 -1） */
export function litIndex(times: readonly number[], local: number): number {
  return times.reduce((last, t, i) => (local >= t ? i : last), -1);
}
