/**
 * 字幕样式的 CSS 占位预览（后端 /api/options 还没给出 CaptionStill 渲染的 PNG 时使用）。
 * 参数抄自 src/captions/styles.ts；字体换成本机系统近似字体，只用于示意，不代表成片效果。
 */
import type { CSSProperties } from 'react';

interface Look { family: string; weight: number; color: string; stroke?: string; ratio?: number; box?: string; highlight?: string; skew?: boolean }

const LOOKS: Record<string, Look> = {
  blade: { family: '"PingFang SC", system-ui, sans-serif', weight: 900, color: '#FFFFFF', stroke: '#000000', ratio: 10 / 58 },
  wenkai: { family: '"Kaiti SC", "STKaiti", "KaiTi", serif', weight: 700, color: '#FFF6E8', stroke: '#2A1810', ratio: 10 / 60 },
  smiley: {
    family: '"PingFang SC", system-ui, sans-serif', weight: 800, color: '#FFFFFF', stroke: '#000000', ratio: 10 / 56, highlight: '#D4F23C', skew: true,
  },
  minimal: { family: '"PingFang SC", system-ui, sans-serif', weight: 600, color: '#FFFFFF', box: 'rgba(0,0,0,0.55)' },
  kuaile: { family: '"Yuanti SC", "PingFang SC", system-ui, sans-serif', weight: 800, color: '#FFE14D', stroke: '#000000', ratio: 10 / 60 },
  song: { family: '"Songti SC", "Noto Serif SC", "STSong", serif', weight: 900, color: '#FFFFFF', stroke: '#000000', ratio: 8 / 58 },
};

export const SAMPLE = { before: '少花 ', hot: '30%', after: ' 冤枉钱' };

/** fontSize 为预览字号（px）；描边按原样式的描边/字号比例换算，paint-order 让描边在字外侧 */
export function captionCss(id: string, fontSize: number): { text: CSSProperties; hot: CSSProperties } {
  const look = LOOKS[id] ?? LOOKS.blade;
  const strokeW = look.stroke && look.ratio ? Math.max(1.5, fontSize * look.ratio * 2) : 0;
  const text: CSSProperties = {
    fontFamily: look.family, fontWeight: look.weight, fontSize, color: look.color, lineHeight: 1.2, whiteSpace: 'nowrap',
    ...(strokeW ? { WebkitTextStroke: `${strokeW}px ${look.stroke}`, paintOrder: 'stroke fill' } : {}),
    ...(look.box ? { background: look.box, borderRadius: fontSize * 0.3, padding: `${fontSize * 0.18}px ${fontSize * 0.5}px` } : {}),
    ...(look.skew ? { display: 'inline-block', transform: 'skewX(-8deg)' } : {}),
  };
  return { text, hot: look.highlight ? { color: look.highlight } : {} };
}
