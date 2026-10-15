import { displayWidth } from './lines.js';

export interface CaptionStyle {
  name: string;
  /** FontAsset.id */
  font: string;
  /** CSS font-family（与 FontAsset.family 一致） */
  family: string;
  size: number;
  weight: number;
  color: string;
  stroke?: { width: number; color: string };
  box?: { color: string; radius: number; padX: number; padY: number };
  /** 关键数字的染色 */
  highlight?: string;
}

/** 字幕可用宽度：1080 画布两侧各留 60 */
export const CAPTION_MAX_WIDTH = 960;

const DEFS = {
  blade: { name: '刀锋', font: 'noto-sans-sc', family: 'Noto Sans SC', size: 58, weight: 900, color: '#FFFFFF', stroke: { width: 10, color: '#000000' } },
  wenkai: { name: '文楷', font: 'lxgw-wenkai', family: 'LXGW WenKai', size: 60, weight: 500, color: '#FFF6E8', stroke: { width: 10, color: '#2A1810' } },
  smiley: { name: '得意', font: 'smiley-sans', family: 'Smiley Sans', size: 56, weight: 400, color: '#FFFFFF', stroke: { width: 10, color: '#000000' }, highlight: '#D4F23C' },
  minimal: { name: '简约', font: 'noto-sans-sc', family: 'Noto Sans SC', size: 54, weight: 600, color: '#FFFFFF', box: { color: 'rgba(0,0,0,0.55)', radius: 18, padX: 28, padY: 10 } },
  kuaile: { name: '快乐', font: 'zcool-kuaile', family: 'ZCOOL KuaiLe', size: 60, weight: 400, color: '#FFE14D', stroke: { width: 10, color: '#000000' } },
  song: { name: '宋韵', font: 'noto-serif-sc', family: 'Noto Serif SC', size: 58, weight: 800, color: '#FFFFFF', stroke: { width: 8, color: '#000000' } },
} as const satisfies Record<string, CaptionStyle>;

export type CaptionStyleId = keyof typeof DEFS;
export const CAPTION_STYLES: Record<CaptionStyleId, CaptionStyle> = DEFS;
export const DEFAULT_CAPTION_STYLE: CaptionStyleId = 'blade';

/** 按显示宽度估算，超出可用宽度（含底框左右内边距）时等比缩小字号 */
export function fitCaptionSize(text: string, style: CaptionStyle): number {
  const avail = CAPTION_MAX_WIDTH - 2 * (style.box?.padX ?? 0);
  const width = displayWidth(text);
  return width <= 0 ? style.size : Math.min(style.size, Math.floor(avail / width));
}

const NUMBER_RE = /\d+(?:\.\d+)?%?/g;

/** 把文本按数字（含小数、百分号）切成片段，数字片段标 hot */
export function splitHighlight(text: string): { text: string; hot: boolean }[] {
  const parts: { text: string; hot: boolean }[] = [];
  let last = 0;
  for (const m of text.matchAll(NUMBER_RE)) {
    if (m.index > last) parts.push({ text: text.slice(last, m.index), hot: false });
    parts.push({ text: m[0], hot: true });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ text: text.slice(last), hot: false });
  return parts;
}
