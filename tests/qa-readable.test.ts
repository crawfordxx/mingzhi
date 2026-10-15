import { describe, expect, it } from 'vitest';
import { THEME } from '../render/theme.js';
import { blend, contrastRatio, readableOn, toRgba } from '../src/qa/contrast.js';
import { defaultPalette } from '../src/qa/palette.js';

const FILLS = ['#F2334B', '#FF7A2F', '#F5A623', '#2F6FE0', '#7B4FD6', '#2F9E58', '#8D97A2', '#FFFFFF', '#000000', '#777777', '#808080', '#999999'];

describe('readableOn', () => {
  it('任意底色上选出的字色对比度 ≥ 4.5', () => {
    for (const fill of FILLS) expect(contrastRatio(readableOn(fill), fill), fill).toBeGreaterThanOrEqual(4.5);
  });
  it('整个灰阶与色轮抽样都 ≥ 4.5', () => {
    for (let v = 0; v <= 255; v += 5) {
      const hex = `#${v.toString(16).padStart(2, '0').repeat(3)}`;
      expect(contrastRatio(readableOn(hex), hex), hex).toBeGreaterThanOrEqual(4.5);
    }
  });
  it('深底给白字、浅底给近黑字', () => {
    expect(readableOn('#7B4FD6')).toBe('#FFFFFF');
    expect(readableOn('#F5A623')).toBe(THEME.ink);
  });
  it('近黑字也不够（#F2334B）时退到纯黑', () => {
    expect(readableOn('#F2334B')).toBe('#000000');
  });
  it('非法颜色抛错', () => {
    expect(() => readableOn('red')).toThrow('#RRGGBB');
  });
});

describe('blend / toRgba', () => {
  it('半透明前景叠在底色上', () => {
    expect(blend('#FFFFFF', 0.5, '#000000')).toBe('#808080');
    expect(blend('#FFFFFF', 1, '#123456')).toBe('#FFFFFF');
  });
  it('toRgba 输出 CSS rgba', () => {
    expect(toRgba('#FAF9F7', 0.94)).toBe('rgba(250, 249, 247, 0.94)');
  });
});

describe('defaultPalette 覆盖模板里的文字配色', () => {
  const pairs = defaultPalette();
  const has = (fg: string, bg: string) => pairs.some((p) => p.fg.toUpperCase() === fg.toUpperCase() && p.bg.toUpperCase() === bg.toUpperCase());
  it('CTA 每个彩色胶囊的字色/底色', () => {
    for (const fill of [...Object.values(THEME.cta.actions), ...THEME.cta.fallback]) expect(has(readableOn(fill), fill), fill).toBe(true);
  });
  it('maybe 胶囊、加载提示、终端、地址栏、瓶身标签', () => {
    expect(has(THEME.maybe.fg, THEME.maybe.bg)).toBe(true);
    expect(has(THEME.hint, THEME.card)).toBe(true);
    expect(has(THEME.termInk.prompt, THEME.terminal)).toBe(true);
    expect(has(THEME.url.fg, THEME.url.bg)).toBe(true);
    expect(has(readableOn(THEME.neutral), THEME.neutral)).toBe(true);
  });
  it('每组都 ≥ 4.5', () => {
    for (const p of pairs) expect(contrastRatio(p.fg, p.bg), p.label).toBeGreaterThanOrEqual(4.5);
  });
});
