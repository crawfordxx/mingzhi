import { CAPTION_STYLES } from '../captions/styles.js';
import { THEME } from '../../render/theme.js';
import { blend, readableOn } from './contrast.js';
import { ctaIdle, type Palette } from '../compose/palette.js';

export interface PalettePair { fg: string; bg: string; label: string }

const WHITE = '#FFFFFF';
/** StrikeList 胶囊底 rgba(255,255,255, 0.82 - strike×0.22) 划到底时的最低 alpha */
const STRIKE_PILL_MIN_ALPHA = 0.6;

/** 把黑色半透明底框叠在最亮的画面（纯白）上，得到字幕底框的最不利底色；底框必须是纯黑，否则按纯黑算会失真，直接报错 */
function worstCaseBox(boxColor: string): string {
  const m = /^rgba\(\s*0\s*,\s*0\s*,\s*0\s*,\s*([\d.]+)\s*\)$/.exec(boxColor);
  if (!m) throw new Error(`字幕底框目前只支持纯黑半透明 rgba(0,0,0,a)：${boxColor}`);
  return blend('#000000', Number(m[1]), '#FFFFFF');
}

function captionPairs(): PalettePair[] {
  return Object.entries(CAPTION_STYLES).flatMap(([id, s]) => {
    const pairs: PalettePair[] = [];
    if (s.stroke) pairs.push({ fg: s.color, bg: s.stroke.color, label: `字幕 ${id} 字色/描边` });
    if (s.box) {
      pairs.push({ fg: s.color, bg: worstCaseBox(s.box.color), label: `字幕 ${id} 字色/底框（叠白底最不利）` });
    }
    if (s.highlight && s.stroke) pairs.push({ fg: s.highlight, bg: s.stroke.color, label: `字幕 ${id} 数字高亮/描边` });
    return pairs;
  });
}

/** 彩色底（CTA 胶囊、瓶身）：字色由 readableOn 按底色自动选 */
function filledPairs(): PalettePair[] {
  const cta = [...Object.entries(THEME.cta.actions).map(([k, c]) => ({ name: k, c })), ...THEME.cta.fallback.map((c, i) => ({ name: `备用${i + 1}`, c }))];
  return [
    ...cta.map(({ name, c }) => ({ fg: readableOn(c), bg: c, label: `CTA ${name} 字色/底色 ${c}` })),
    { fg: readableOn(THEME.neutral), bg: THEME.neutral, label: `瓶身标签 warn 字色/灰底 ${THEME.neutral}` },
    { fg: readableOn(THEME.green), bg: THEME.green, label: `瓶身标签 good 字色/绿底 ${THEME.green}` },
    { fg: readableOn(THEME.red), bg: THEME.red, label: `瓶身标签 bad 字色/红底 ${THEME.red}` },
  ];
}

/** 叠在视频/照片上的半透明底，按最不利的纯黑画面合成底色后检查 */
function glassPairs(): PalettePair[] {
  const idle = blend(THEME.cta.idle.bg, THEME.cta.idle.alpha, '#000000');
  const glass = blend(THEME.glass.bg, THEME.glass.alpha, '#000000');
  const strike = blend('#FFFFFF', STRIKE_PILL_MIN_ALPHA, '#000000');
  return [
    { fg: THEME.cta.idle.fg, bg: idle, label: 'CTA 未点胶囊 灰字/半透明白底（叠黑最不利）' },
    { fg: THEME.ink, bg: glass, label: '图片卡标签 ink/玻璃底（叠黑最不利）' },
    { fg: THEME.subOnGlass, bg: glass, label: '图片卡副标题 subOnGlass/玻璃底（叠黑最不利）' },
    { fg: THEME.ink, bg: strike, label: '划掉列表 ink/半透明白底（划掉后 alpha 最低，叠黑最不利）' },
    { fg: THEME.hookLime, bg: blend(THEME.hookLime, 0.12, THEME.hookBg), label: 'Hook 数据条 hookLime/浅荧光底' },
  ];
}

/** CTA 未点胶囊（叠在人物画面上，按最不利的底合成） */
function ctaIdlePair(p: Palette): [string, string, string][] {
  const idle = ctaIdle(p);
  return [[idle.fg, blend(idle.bg, idle.alpha, p.tone === 'dark' ? '#FFFFFF' : '#000000'), 'CTA 未点胶囊（叠最不利底）']];
}

/** 片色（背景推导出的卡片与钩子配色）里的文字/底色组合；玻璃卡按最不利的底（暗色卡叠白、亮色卡叠黑）合成后检查 */
export function palettePairs(p: Palette): PalettePair[] {
  const glass = blend(p.glass.bg, p.glass.alpha, p.tone === 'dark' ? '#FFFFFF' : '#000000');
  const pairs: [string, string, string][] = [
    [p.ink, p.card, 'ink/card'], [p.sub, p.card, 'sub/card'], [p.ink, p.stage, 'ink/stage'], [p.sub, p.stage, 'sub/stage'],
    [p.ink, p.inset, 'ink/inset'], [p.sub, p.inset, 'sub/inset'], [p.idleInk, p.card, '流程未点亮 idleInk/card'], [p.card, p.ink, '流程点亮序号 card/ink'],
    [p.accentText, p.card, '强调字 accentText/card'], [p.accentInk, p.accent, '强调底上的字 accentInk/accent'],
    [p.redText, p.card, 'redText/card'], [p.redText, p.tint.no, 'redText/tint.no'], [p.goldText, p.card, 'goldText/card'],
    [p.greenText, p.card, 'greenText/card'], [p.greenText, p.tint.yes, 'greenText/tint.yes'], [p.greenText, p.tint.hot, 'greenText/tint.hot'],
    [p.maybe.fg, p.maybe.bg, 'maybe.fg/bg'],
    [p.hook.ink, p.hook.bg, '钩子标题 hook.ink/bg'], [p.hook.accent, p.hook.bg, '钩子强调 hook.accent/bg'], [p.hook.accentInk, p.hook.accent, '钩子胶囊 accentInk/accent'],
    [p.ink, glass, '玻璃卡 ink（叠最不利底）'],
    ...(p.tone === 'dark' ? [[p.sub, glass, '玻璃卡 sub（叠白最不利）'] as [string, string, string]] : []),
    ...ctaIdlePair(p),
  ];
  return pairs.map(([fg, bg, label]) => ({ fg, bg, label: `片色 ${label}` }));
}

/** 卡片模板里的文字/底色组合 + 字幕样式的字/描边（或底框）；给了片色时再加上片色的组合（成片检查按这条片实际的配色查）。
 *  有意不在表内：
 *  - THEME.faint：只用于「划掉」文字（刻意弱化的已删除项）和装饰分隔点；
 *  - Hook 白色标题压在视频上：真实底色是「视频 + 55% 深色蒙层」，随画面变，无法静态计算，表内只按 hookBg 实色检查；
 *  - EvidenceList 高亮行的 12% 彩色浅底：叠在白卡上仍极浅，ink 字对比度 > 14；
 *  - 光标、进度条、开关、色点、瓶盖等无文字的装饰色块。 */
export function defaultPalette(palette?: Palette): PalettePair[] {
  const badges = Object.entries(THEME.badge).map(([name, color]) => ({ fg: WHITE, bg: color, label: `徽标 ${name} 白字/底色` }));
  return [
    { fg: THEME.ink, bg: THEME.card, label: '卡片正文 ink/card' },
    { fg: THEME.sub, bg: THEME.card, label: '卡片副文 sub/card' },
    { fg: THEME.ink, bg: THEME.stage, label: '舞台文字 ink/stage' },
    { fg: THEME.sub, bg: THEME.stage, label: '舞台面包屑 sub/stage' },
    { fg: THEME.redText, bg: THEME.card, label: '警示红字 redText/card' },
    { fg: THEME.redText, bg: THEME.tint.no, label: '叉号胶囊 redText/tint.no' },
    { fg: THEME.goldText, bg: THEME.card, label: '金色字 goldText/card' },
    { fg: THEME.greenText, bg: THEME.card, label: '绿色字 greenText/card' },
    { fg: THEME.greenText, bg: THEME.tint.yes, label: '对勾胶囊 greenText/tint.yes' },
    { fg: THEME.greenText, bg: THEME.tint.hot, label: '高亮格子 greenText/tint.hot' },
    { fg: THEME.hookBg, bg: THEME.hookLime, label: 'Hook 标签 hookBg/hookLime' },
    { fg: THEME.hookLime, bg: THEME.hookBg, label: 'Hook 荧光字 hookLime/hookBg' },
    ...badges,
    { fg: THEME.maybe.fg, bg: THEME.maybe.bg, label: '不确定胶囊 maybe.fg/bg' },
    { fg: THEME.hint, bg: THEME.card, label: '浏览器加载提示 hint/card' },
    { fg: THEME.url.fg, bg: THEME.url.bg, label: '地址栏 url.fg/bg' },
    { fg: WHITE, bg: THEME.hookBg, label: 'Hook 标题 白/hookBg' },
    { fg: WHITE, bg: THEME.ink, label: '对比条结论按钮 白字/ink 底' },
    ...Object.entries(THEME.termInk).map(([k, fg]) => ({ fg, bg: THEME.terminal, label: `终端 ${k} 字/terminal` })),
    ...filledPairs(),
    ...glassPairs(),
    ...captionPairs(),
    ...(palette ? palettePairs(palette) : []),
  ];
}
