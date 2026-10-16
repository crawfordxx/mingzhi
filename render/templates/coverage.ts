/**
 * 上半屏空白率估算（按卡片内容尺寸，不量 DOM）。卡片区 = 画布宽 × 安全区下沿（0–870，下面是压在分界线上的字幕）。两个口径：
 * - stage：露出的米色底比例（白卡、窗口、模板固定底之外的部分）。brief 的「空白率 ≤ 35%」用这个口径；纸面卡片撑满安全区，约 25%
 * - flat：stage 再加上白卡/窗口里没有内容的平坦留白（白卡面积 − 内容高 × 卡内宽）。近似审片报告的「平坦块」口径
 *   （6×6 块标准差 < 2.5，白卡内部的纯白也算平坦），两者关系：flat = stage + 卡内留白 / 卡片区面积
 * 带固定底的模板（钩子、图片）整块铺满，两个口径都按 0 计（图片与钩子图形的纹理不建模）；cta 叠在全屏人物上，不适用（0）
 */
import type { CardSpec } from '../../src/storyboard/schema.js';
import type { PropsOf } from './parts.js';
import { CONTENT_W, SAFE, SAFE_H, fitFontSize, lineCount } from './parts.js';
import { TERMINAL_WIN_H } from './Terminal.js';
import { estimateChipsHeight } from './Chips.js';
import { estimateCompareHeight } from './CompareBars.js';
import { estimateEvidenceHeight } from './EvidenceList.js';
import { estimateFlowHeight } from './Flow.js';
import { estimateStrikeHeight } from './StrikeList.js';
import { titleLines, titlePx } from './Title.js';

export const BLANK_MAX = 0.35;
const ZONE = 1080 * SAFE.bottom;
/** 白卡左右内边距约 48，内容宽按卡内宽算 */
const INNER_W = CONTENT_W - 96;
const PANEL = CONTENT_W * SAFE_H;
const BROWSER_WIN_H = 700;

export interface BlankEstimate { stage: number; flat: number }

const title = (p: PropsOf<'title'>): number => {
  const sub = p.subtitle ? 30 + Math.min(2, lineCount(p.subtitle, INNER_W, fitFontSize(p.subtitle, INNER_W, 46, 30, 2))) * 46 * 1.4 : 0;
  return (p.crumb ? 30 * 1.3 + 34 : 0) + titleLines(p.title).length * titlePx(p.title) * 1.16 + sub;
};
const bigNumber = (p: PropsOf<'bigNumber'>): number => {
  const chips = p.chips?.length ?? 0;
  if (chips === 0) return 330 * 0.92 + 28 + 2 * 48 * 1.3;
  const cols = chips <= 3 ? 3 : chips <= 8 ? 4 : 6;
  return 260 + 52 + Math.ceil(chips / cols) * (76 + 14);
};
const toggles = (p: PropsOf<'toggles'>): number => (p.title ? 70 : 0) + p.rows.length * 132 + (p.footnote ? 18 + 2 * 31 * 1.4 : 0);

/** 白卡里的内容高度（不含卡片内边距）；带窗口的模板返回窗口内的内容高度 */
function contentHeight(card: CardSpec): number {
  switch (card.template) {
    case 'title': return title(card.props);
    case 'bigNumber': return bigNumber(card.props);
    case 'chips': return estimateChipsHeight(card.props.groups) - 48;
    case 'compareBars': return estimateCompareHeight(card.props);
    case 'evidenceList': return estimateEvidenceHeight(card.props) - 88;
    case 'strikeList': return estimateStrikeHeight(card.props.items.length, Boolean(card.props.title)) - 96;
    case 'toggles': return toggles(card.props);
    case 'flow': return estimateFlowHeight(card.props);
    case 'terminal': return 92 + card.props.lines.length * 38 * 1.6;
    case 'browser': return card.props.image ? BROWSER_WIN_H : 220;
    default: return SAFE_H;
  }
}

/** 白卡（或窗口）占的面积 */
const surfaceArea = (card: CardSpec): number => (card.template === 'terminal' ? CONTENT_W * TERMINAL_WIN_H : card.template === 'browser' ? CONTENT_W * BROWSER_WIN_H : PANEL);

/** 卡片在纸面分屏上的空白率估算（0–1） */
export function estimateBlank(card: CardSpec): BlankEstimate {
  if (card.template === 'hook' || card.template === 'photo' || card.template === 'cta') return { stage: 0, flat: 0 };
  const surface = surfaceArea(card);
  const stage = 1 - surface / ZONE;
  const filled = Math.min(surface, INNER_W * Math.max(0, contentHeight(card)));
  return { stage, flat: stage + (surface - filled) / ZONE };
}
