import type { Broll } from '../../src/storyboard/schema.js';

/**
 * 分屏上半屏素材图的压暗层：base 是 CardLayer 里按铺图变体选好的竖向渐变（顶部到底部）。
 * 整片自检对付「图上文字对比度不够」的两个办法在这里生效：
 * - shade（压暗加深）：渐变之下再整体叠一层统一的暗色
 * - textTop（换文字位置）：卡片文字改排在上半屏，渐变翻转成上深下浅，文字依然落在最暗的一端
 */
export function splitShadeBackground(base: string, broll: Pick<Broll, 'shade' | 'textTop'>): string {
  const gradient = broll.textTop ? base.replace('linear-gradient(180deg', 'linear-gradient(0deg') : base;
  const s = broll.shade ?? 0;
  return s > 0 ? `${gradient}, linear-gradient(rgba(10, 9, 8, ${s}), rgba(10, 9, 8, ${s}))` : gradient;
}
