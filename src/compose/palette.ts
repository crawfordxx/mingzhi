/**
 * 片色：从人物背景（预设图、上传图或没换背景时的人像画面，套项目 LUT 后缩成小图）推导整条片的卡片与钩子配色，
 * 让卡片、钩子、片尾和下半屏的人物背景是同一个色彩世界。分镜阶段算一次、随分镜落盘，渲染时经 TalkProps.palette 传入。
 * - 暗背景（亮度 < DARK_LUMA）：深色底 + 深色玻璃卡 + 浅色字；亮背景：暖白底 + 白卡 + 深色字
 * - 强调色取背景里最显眼的有彩色（饱和度 × 明度加权的色相峰值），中性背景按冷暖兜底
 * - 钩子始终是深底：背景主色压深 + 强调色（不再固定暗绿荧光）
 * - 所有文字与底色的对比度 ≥ 4.5：文字色沿明度方向逐步调到达标（fitLightness），玻璃卡的不透明度按最不利的底反推
 */
import { z } from 'zod';
import { THEME } from '../../render/theme.js';
import { blend, contrastRatio, readableOn } from '../qa/contrast.js';
import { hexOf, hslOf, rgbOfHex, type Rgb } from './color.js';

export type { Rgb } from './color.js';

const HEX = z.string().regex(/^#[0-9A-F]{6}$/i);
export const PaletteSchema = z.object({
  tone: z.enum(['dark', 'light']),
  /** 卡片区底色（分屏上半屏、片尾） */
  stage: HEX,
  /** 卡片底（暗色时是深色玻璃卡的实色） */
  card: HEX,
  ink: HEX,
  sub: HEX,
  /** 只用于划掉的文字与装饰 */
  faint: HEX,
  /** 卡内浅色块（格子、条目底） */
  inset: HEX,
  /** 轨道、连线、关闭的开关 */
  track: HEX,
  /** 未点亮的流程节点描边与文字 */
  idle: HEX,
  idleInk: HEX,
  /** 强调色（填充）、填充上的字、做文字用的强调色（对卡片 ≥ 4.5） */
  accent: HEX,
  accentInk: HEX,
  accentText: HEX,
  red: HEX, gold: HEX, green: HEX, redText: HEX, goldText: HEX, greenText: HEX,
  tint: z.object({ yes: HEX, no: HEX, hot: HEX }),
  maybe: z.object({ bg: HEX, fg: HEX }),
  /** 钩子：深底、标题字、强调色（高亮词、数字、图形）与强调色上的字 */
  hook: z.object({ bg: HEX, ink: HEX, accent: HEX, accentInk: HEX }),
  /** 图上与浮层的玻璃卡：底色、不透明度、铺图变体（几乎不透明）的不透明度 */
  glass: z.object({ bg: HEX, alpha: z.number().min(0).max(1), solidAlpha: z.number().min(0).max(1) }),
});
export type Palette = z.infer<typeof PaletteSchema>;

const MIN = 4.5;

/** 旧项目与没有背景信息时的配色：与原 THEME 一致（米白卡片区 + 白卡 + 暗绿荧光钩子） */
export const DEFAULT_PALETTE: Palette = {
  tone: 'light', stage: THEME.stage, card: THEME.card, ink: THEME.ink, sub: THEME.sub, faint: THEME.faint,
  inset: '#F4F1EC', track: '#ECE8E1', idle: '#D9D4CB', idleInk: '#6E6962',
  accent: THEME.crumbDot, accentInk: readableOn(THEME.crumbDot), accentText: '#C2410C',
  red: THEME.red, gold: THEME.gold, green: THEME.green, redText: THEME.redText, goldText: THEME.goldText, greenText: THEME.greenText,
  tint: { ...THEME.tint }, maybe: { ...THEME.maybe },
  hook: { bg: THEME.hookBg, ink: '#FFFFFF', accent: THEME.hookLime, accentInk: THEME.hookBg },
  glass: { bg: '#FAF8F4', alpha: 0.8, solidAlpha: 0.96 },
};

/** 背景平均亮度（Rec.709，编码域）低于它按暗背景配色：夜景、暗色科技、深色木书房在下，咖啡馆、客厅、天台在上 */
export const DARK_LUMA = 0.34;
const HUE_BINS = 24;
/** 有彩色的总权重低于像素数的这个比例时视为中性背景，强调色按冷暖兜底 */
const CHROMA_MIN = 0.04;
const WARM_HUE = 28;
const COOL_HUE = 205;

export interface BackdropTone { hue: number; sat: number; luma: number; accentHue: number }

const luma = (c: Rgb): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;

/** 色相峰值：按饱和度 × 明度加权的 24 格直方图取最高格，再与左右两格做加权圆周平均；中性背景返回 null */
function accentHueOf(pixels: Rgb[]): number | null {
  const bins = new Array<number>(HUE_BINS).fill(0);
  for (const p of pixels) {
    const { h, s, l } = hslOf(p);
    const v = Math.max(p.r, p.g, p.b);
    bins[Math.floor((h / 360) * HUE_BINS) % HUE_BINS] += s * v * (l > 0.08 ? 1 : 0);
  }
  if (bins.reduce((a, b) => a + b, 0) < pixels.length * CHROMA_MIN) return null;
  const peak = bins.indexOf(Math.max(...bins));
  const near = [-1, 0, 1].map((d) => (peak + d + HUE_BINS) % HUE_BINS);
  const [x, y] = near.reduce(([sx, sy], i) => {
    const a = (((i + 0.5) * 360) / HUE_BINS) * (Math.PI / 180);
    return [sx + bins[i] * Math.cos(a), sy + bins[i] * Math.sin(a)];
  }, [0, 0]);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** 背景的基调：平均色的色相与饱和度、平均亮度、强调色相 */
export function backdropTone(pixels: Rgb[]): BackdropTone {
  if (pixels.length === 0) throw new Error('推导片色需要背景像素');
  const n = pixels.length;
  const mean = { r: pixels.reduce((a, p) => a + p.r, 0) / n, g: pixels.reduce((a, p) => a + p.g, 0) / n, b: pixels.reduce((a, p) => a + p.b, 0) / n };
  const { h, s } = hslOf(mean);
  const warm = mean.r >= mean.b;
  return { hue: h, sat: s, luma: luma(mean), accentHue: accentHueOf(pixels) ?? (warm ? WARM_HUE : COOL_HUE) };
}

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));
const hsl = (h: number, s: number, l: number): string => hexOf({ h, s: clamp(s, 0, 1), l: clamp(l, 0, 1) });

/** 文字色：从 (h,s,l) 出发沿明度方向（up 变亮、down 变暗）每次 1%，直到对每个底色都 ≥ MIN；到头仍不够时取纯白/纯黑 */
export function fitLightness(h: number, s: number, l: number, against: string[], dir: 'up' | 'down', min = MIN): string {
  for (let k = 0; k <= 100; k++) {
    const c = hsl(h, s, dir === 'up' ? l + k / 100 : l - k / 100);
    if (against.every((bg) => contrastRatio(c, bg) >= min)) return c;
  }
  return dir === 'up' ? '#FFFFFF' : '#000000';
}

/** 已达标就原样保留（旧配色不变），否则从它自己的色相饱和度出发沿明度方向调到达标 */
function ensure(fg: string, against: string[], dir: 'up' | 'down'): string {
  if (against.every((bg) => contrastRatio(fg, bg) >= MIN)) return fg;
  const { h, s, l } = hslOf(rgbOfHex(fg));
  return fitLightness(h, s, l, against, dir);
}

/** 玻璃卡不透明度：从 base 起每次加 0.02，直到这些文字叠在最不利的底（worst）上合成后仍 ≥ MIN；上限 0.96 */
export function glassAlpha(glass: string, inks: string[], worst: string, base: number): number {
  for (let a = base; a < 0.96; a += 0.02) {
    const bg = blend(glass, a, worst);
    if (inks.every((ink) => contrastRatio(ink, bg) >= MIN)) return Math.round(a * 100) / 100;
  }
  return 0.96;
}

/** 钩子：背景主色压到很深做底，强调色提亮到对底 ≥ 4.5（高亮词、数字、图形都用它） */
function hookOf(t: BackdropTone): Palette['hook'] {
  const bg = hsl(t.hue, clamp(t.sat * 0.9 + 0.2, 0.18, 0.45), 0.08);
  const accent = fitLightness(t.accentHue, 0.86, 0.6, [bg], 'up');
  return { bg, ink: hsl(t.hue, 0.3, 0.97), accent, accentInk: readableOn(accent) };
}

/** 暗背景：深色底 + 深色玻璃卡，文字与强调色往亮处调；语义色（红绿金）的文字版本也往亮处调 */
function darkOf(t: BackdropTone): Palette {
  const s = clamp(t.sat * 0.8 + 0.08, 0.06, 0.3);
  const card = hsl(t.hue, s * 0.8, 0.135);
  const inset = hsl(t.hue, s * 0.8, 0.18);
  const ink = hsl(t.hue, 0.25, 0.95);
  const sub = fitLightness(t.hue, 0.1, 0.7, [card, inset], 'up');
  const accent = fitLightness(t.accentHue, 0.82, 0.58, [], 'up');
  const red = '#E5484D';
  const green = '#3DB26E';
  const tint = { yes: blend(green, 0.18, card), no: blend(red, 0.18, card), hot: blend(green, 0.12, card) };
  const glassBg = hsl(t.hue, s, 0.11);
  return {
    tone: 'dark', stage: hsl(t.hue, s, 0.07), card, ink, sub, faint: hsl(t.hue, 0.06, 0.45), inset, track: hsl(t.hue, s * 0.7, 0.23),
    idle: hsl(t.hue, s * 0.5, 0.34), idleInk: fitLightness(t.hue, 0.06, 0.66, [card], 'up'),
    accent, accentInk: readableOn(accent), accentText: fitLightness(t.accentHue, 0.85, 0.62, [card, inset], 'up'),
    red, gold: '#E0A33A', green,
    redText: fitLightness(358, 0.85, 0.66, [card, tint.no], 'up'), goldText: fitLightness(38, 0.8, 0.6, [card], 'up'), greenText: fitLightness(145, 0.55, 0.55, [card, tint.yes, tint.hot], 'up'),
    tint, maybe: { bg: inset, fg: sub },
    hook: hookOf(t),
    glass: { bg: glassBg, alpha: glassAlpha(glassBg, [ink, sub], '#FFFFFF', 0.72), solidAlpha: 0.94 },
  };
}

/** 亮背景：带背景色调的暖白底 + 近白卡，文字与强调色往暗处调；语义色沿用原 THEME（白卡上已达标） */
function lightOf(t: BackdropTone): Palette {
  const s = clamp(t.sat * 0.8 + 0.14, 0.1, 0.32);
  const card = hsl(t.hue, 0.7, 0.984);
  const stage = hsl(t.hue, s, 0.915);
  const inset = hsl(t.hue, s * 1.1, 0.95);
  const ink = hsl(t.hue, 0.12, 0.11);
  const sub = fitLightness(t.hue, 0.07, 0.42, [card, stage, inset], 'down');
  const accent = hsl(t.accentHue, 0.8, 0.52);
  const glassBg = hsl(t.hue, 0.4, 0.975);
  return {
    ...DEFAULT_PALETTE, tone: 'light', stage, card, ink, sub, faint: hsl(t.hue, 0.06, 0.63), inset, track: hsl(t.hue, s * 0.8, 0.9),
    idle: hsl(t.hue, s * 0.7, 0.82), idleInk: fitLightness(t.hue, 0.05, 0.43, [card], 'down'),
    accent, accentInk: readableOn(accent), accentText: fitLightness(t.accentHue, 0.8, 0.42, [card, inset], 'down'),
    redText: ensure(THEME.redText, [card, THEME.tint.no], 'down'), goldText: ensure(THEME.goldText, [card], 'down'),
    greenText: ensure(THEME.greenText, [card, THEME.tint.yes, THEME.tint.hot], 'down'),
    maybe: { bg: hsl(t.hue, s * 0.5, 0.93), fg: fitLightness(t.hue, 0.04, 0.42, [hsl(t.hue, s * 0.5, 0.93)], 'down') },
    hook: hookOf(t),
    glass: { bg: glassBg, alpha: glassAlpha(glassBg, [ink], '#000000', 0.8), solidAlpha: 0.96 },
  };
}

/** CTA 未点胶囊（压在人物画面上）：亮色片沿用原白底灰字；暗色片是深色玻璃底 + 次文字色，与卡片同一套玻璃 */
export function ctaIdle(p: Palette): { bg: string; alpha: number; fg: string; edge: string } {
  if (p.tone !== 'dark') return { ...THEME.cta.idle, edge: 'none' };
  return { bg: p.glass.bg, alpha: Math.max(p.glass.alpha, 0.86), fg: p.sub, edge: 'inset 0 0 0 1.5px rgba(255, 255, 255, 0.12)' };
}

/** 从背景像素（0–1，已套项目 LUT）推导整条片的配色 */
export function paletteFor(pixels: Rgb[]): Palette {
  const t = backdropTone(pixels);
  return t.luma < DARK_LUMA ? darkOf(t) : lightOf(t);
}
