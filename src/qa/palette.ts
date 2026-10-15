import { CAPTION_STYLES } from '../captions/styles.js';
import { THEME } from '../../render/theme.js';

export interface PalettePair { fg: string; bg: string; label: string }

const WHITE = '#FFFFFF';

/** 把黑色半透明底框叠在最亮的画面（纯白）上，得到字幕底框的最不利底色 */
function worstCaseBox(alpha: number): string {
  const v = Math.round(255 * (1 - alpha)).toString(16).padStart(2, '0').toUpperCase();
  return `#${v}${v}${v}`;
}

function captionPairs(): PalettePair[] {
  return Object.entries(CAPTION_STYLES).flatMap(([id, s]) => {
    const pairs: PalettePair[] = [];
    if (s.stroke) pairs.push({ fg: s.color, bg: s.stroke.color, label: `字幕 ${id} 字色/描边` });
    if (s.box) {
      const alpha = Number(/rgba\([^)]*,\s*([\d.]+)\)/.exec(s.box.color)?.[1] ?? 1);
      pairs.push({ fg: s.color, bg: worstCaseBox(alpha), label: `字幕 ${id} 字色/底框（叠白底最不利）` });
    }
    if (s.highlight && s.stroke) pairs.push({ fg: s.highlight, bg: s.stroke.color, label: `字幕 ${id} 数字高亮/描边` });
    return pairs;
  });
}

/** 卡片与舞台上实际出现的文字/底色组合，字幕样式的字/描边（或底框） */
export function defaultPalette(): PalettePair[] {
  const badges = Object.entries(THEME.badge).map(([name, color]) => ({ fg: WHITE, bg: color, label: `徽标 ${name} 白字/底色` }));
  return [
    { fg: THEME.ink, bg: THEME.card, label: '卡片正文 ink/card' },
    { fg: THEME.sub, bg: THEME.card, label: '卡片副文 sub/card' },
    { fg: THEME.faint, bg: THEME.card, label: '划掉/分隔 faint/card' },
    { fg: THEME.ink, bg: THEME.stage, label: '舞台文字 ink/stage' },
    { fg: THEME.sub, bg: THEME.stage, label: '舞台面包屑 sub/stage' },
    { fg: THEME.red, bg: THEME.card, label: '警示红 red/card' },
    { fg: THEME.gold, bg: THEME.card, label: '金色 gold/card' },
    { fg: THEME.hookBg, bg: THEME.hookLime, label: 'Hook 标签 hookBg/hookLime' },
    { fg: THEME.hookLime, bg: THEME.hookBg, label: 'Hook 荧光字 hookLime/hookBg' },
    ...badges,
    ...captionPairs(),
  ];
}
