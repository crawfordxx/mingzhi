import React from 'react';
import { DEFAULT_PALETTE, type Palette } from '../src/compose/palette.js';
import { toRgba } from '../src/qa/contrast.js';

/** 整条片的配色（分镜阶段从人物背景推导，经 TalkProps.palette 传入）；没有时是原 THEME 配色 */
export const PaletteContext = React.createContext<Palette>(DEFAULT_PALETTE);
export const usePalette = (): Palette => React.useContext(PaletteContext);

/** 磨砂玻璃卡：片色的玻璃底（半透明）+ 背景模糊 + 内描边高光 + 投影；solid 为铺图变体（几乎不透明） */
export function glassStyle(p: Palette, solid: boolean): React.CSSProperties {
  const dark = p.tone === 'dark';
  return {
    background: toRgba(p.glass.bg, solid ? p.glass.solidAlpha : p.glass.alpha), backdropFilter: 'blur(28px) saturate(1.3)', WebkitBackdropFilter: 'blur(28px) saturate(1.3)',
    boxShadow: `0 24px 64px rgba(0, 0, 0, ${dark ? 0.4 : 0.28}), 0 4px 14px rgba(0, 0, 0, 0.12), inset 0 0 0 1.5px rgba(255, 255, 255, ${dark ? 0.1 : 0.55})`,
  };
}

/**
 * 卡片区底（分屏上半屏没有素材时）：片色底上一团极淡的强调色光晕（右上）和压向四周的暗角，
 * 让深色卡片区有纵深、不是一块死平的色块；亮色片只留很轻的暖光
 */
export function stageBackground(p: Palette): string {
  const glow = toRgba(p.accent, p.tone === 'dark' ? 0.07 : 0.05);
  const edge = p.tone === 'dark' ? 'rgba(0, 0, 0, 0.35)' : 'rgba(60, 40, 20, 0.05)';
  return `radial-gradient(120% 90% at 82% 8%, ${glow} 0%, rgba(0, 0, 0, 0) 55%), radial-gradient(140% 120% at 50% 40%, rgba(0, 0, 0, 0) 55%, ${edge} 100%), ${p.stage}`;
}

/** 纸面卡片：亮色是白卡 + 暖色软投影；暗色是深色卡 + 顶部一道极淡的高光与细描边（玻璃质感，不靠投影分层） */
export function paperCardStyle(p: Palette, shadow: string): React.CSSProperties {
  if (p.tone !== 'dark') return { background: p.card, boxShadow: shadow };
  return {
    background: `linear-gradient(180deg, ${toRgba('#FFFFFF', 0.035)} 0%, ${toRgba('#FFFFFF', 0)} 38%), ${p.card}`,
    boxShadow: `0 24px 60px rgba(0, 0, 0, 0.45), inset 0 0 0 1.5px ${toRgba('#FFFFFF', 0.07)}, inset 0 1.5px 0 ${toRgba('#FFFFFF', 0.08)}`,
  };
}
