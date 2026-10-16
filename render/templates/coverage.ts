/**
 * 上半屏空白率估算（按卡片内容框尺寸，不量 DOM）：卡片区 = 画布宽 × 安全区下沿（0–870，下面是压在分界线上的字幕）；
 * 空白 = 卡片区里没被内容框（白卡、窗口、模板固定底）盖住的米色比例。纸面上的卡片撑满安全区，空白率约 25%；
 * 带固定底的模板（钩子、图片）整块铺满，空白率 0。cta 只叠在全屏人物上，不适用（返回 0）
 */
import type { CardSpec } from '../../src/storyboard/schema.js';
import { CONTENT_W, SAFE, SAFE_H } from './parts.js';

export const BLANK_MAX = 0.35;
const ZONE = 1080 * SAFE.bottom;

/** 撑满安全区的白卡（宽 CONTENT_W、高 SAFE_H）留下的米色比例 */
const PANEL_BLANK = 1 - (CONTENT_W * SAFE_H) / ZONE;

/** 卡片在纸面分屏上的空白率估算（0–1） */
export function estimateBlank(card: CardSpec): number {
  switch (card.template) {
    case 'hook':
    case 'photo':
    case 'cta':
      return 0;
    default:
      // 其余模板都在撑满安全区的白卡或窗口里
      return PANEL_BLANK;
  }
}
