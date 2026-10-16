// 片色推导：暗背景深色玻璃卡、亮暖背景暖白卡、强调色跟背景走、所有文字对比度 ≥ 4.5、默认配色与原 THEME 一致
import { describe, expect, it } from 'vitest';
import { THEME } from '../render/theme.js';
import { hexOf, hslOf, rgbOfHex, type Rgb } from '../src/compose/color.js';
import { DEFAULT_PALETTE, PaletteSchema, backdropTone, ctaIdle, fitLightness, paletteFor } from '../src/compose/palette.js';
import { contrastRatio } from '../src/qa/contrast.js';
import { defaultPalette, palettePairs } from '../src/qa/palette.js';
import { backdropPixels, samplePalette } from '../src/compose/palette-sample.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
import { shotHash } from '../src/compose/segments.js';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cfg = loadConfig({});

/** 一张背景的小图：base 色铺满，按比例混入几种点缀色 */
function backdrop(base: string, spots: [string, number][] = [], n = 576): Rgb[] {
  const counts = spots.map(([c, f]) => [c, Math.round(n * f)] as const);
  const rest = n - counts.reduce((a, [, k]) => a + k, 0);
  return [...counts.flatMap(([c, k]) => Array.from({ length: k }, () => rgbOfHex(c))), ...Array.from({ length: rest }, () => rgbOfHex(base))];
}

/** 夜景落地窗：蓝黑底 + 少量橙色灯光 + 少量青蓝 */
const NIGHT = backdrop('#1B1D22', [['#E08A3C', 0.08], ['#3D6E8C', 0.06]]);
/** 暖色台灯客厅：米色墙 + 琥珀灯光 */
const LIVING = backdrop('#8C7A68', [['#E2B27A', 0.15], ['#5E4A3A', 0.2]]);
const hueOf = (hex: string): number => hslOf(rgbOfHex(hex)).h;
const warm = (h: number): boolean => h >= 10 && h <= 50;

describe('backdropTone', () => {
  it('夜景：暗、强调色相取橙色灯光', () => {
    const t = backdropTone(NIGHT);
    expect(t.luma).toBeLessThan(0.2);
    expect(warm(t.accentHue)).toBe(true);
  });
  it('中性灰背景按冷暖兜底：偏暖给橙、偏冷给青蓝', () => {
    expect(warm(backdropTone(backdrop('#7A7672')).accentHue)).toBe(true);
    const cool = backdropTone(backdrop('#70767A')).accentHue;
    expect(cool).toBeGreaterThan(180);
    expect(cool).toBeLessThan(230);
  });
  it('没有像素时抛错', () => {
    expect(() => backdropTone([])).toThrow('背景像素');
  });
});

describe('paletteFor', () => {
  it('夜景 → 深色：深底、深色卡、浅色字，强调色是暖色', () => {
    const p = paletteFor(NIGHT);
    expect(p.tone).toBe('dark');
    expect(hslOf(rgbOfHex(p.stage)).l).toBeLessThan(0.12);
    expect(hslOf(rgbOfHex(p.card)).l).toBeLessThan(0.2);
    expect(hslOf(rgbOfHex(p.ink)).l).toBeGreaterThan(0.85);
    expect(warm(hueOf(p.accent))).toBe(true);
  });
  it('暖色客厅 → 亮色：暖白底（色相偏暖、明度 > 0.88）、近白卡、深色字、暖色强调', () => {
    const p = paletteFor(LIVING);
    expect(p.tone).toBe('light');
    const stage = hslOf(rgbOfHex(p.stage));
    expect(stage.l).toBeGreaterThan(0.88);
    expect(warm(stage.h)).toBe(true);
    expect(hslOf(rgbOfHex(p.ink)).l).toBeLessThan(0.2);
    expect(warm(hueOf(p.accent))).toBe(true);
  });
  it('钩子不再固定暗绿荧光：深底取背景色相，强调色跟背景强调色相', () => {
    for (const p of [paletteFor(NIGHT), paletteFor(LIVING)]) {
      expect(p.hook.accent).not.toBe(THEME.hookLime);
      expect(hslOf(rgbOfHex(p.hook.bg)).l).toBeLessThan(0.1);
      expect(warm(hueOf(p.hook.accent))).toBe(true);
    }
  });
  it('冷色科技背景 → 青蓝强调', () => {
    const p = paletteFor(backdrop('#15202A', [['#2E9BD6', 0.15]]));
    expect(p.tone).toBe('dark');
    expect(hueOf(p.accent)).toBeGreaterThan(180);
    expect(hueOf(p.accent)).toBeLessThan(230);
  });
  it('结果符合 PaletteSchema（可落盘）', () => {
    expect(PaletteSchema.safeParse(paletteFor(NIGHT)).success).toBe(true);
    expect(PaletteSchema.safeParse(DEFAULT_PALETTE).success).toBe(true);
  });
  it('色轮 × 明度扫一遍：所有文字/底色组合都 ≥ 4.5', () => {
    for (let h = 0; h < 360; h += 30) {
      for (const l of [0.05, 0.15, 0.3, 0.4, 0.55, 0.7, 0.85, 0.97]) {
        for (const s of [0, 0.3, 0.8]) {
          const base = hexOf({ h, s, l });
          const p = paletteFor(backdrop(base, [[hexOf({ h: (h + 150) % 360, s: 0.8, l: 0.55 }), 0.1]]));
          for (const pair of palettePairs(p)) expect(contrastRatio(pair.fg, pair.bg), `${base} ${pair.label}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});

describe('默认配色（旧项目）', () => {
  it('与原 THEME 一致', () => {
    expect(DEFAULT_PALETTE.stage).toBe(THEME.stage);
    expect(DEFAULT_PALETTE.card).toBe(THEME.card);
    expect(DEFAULT_PALETTE.ink).toBe(THEME.ink);
    expect(DEFAULT_PALETTE.hook.bg).toBe(THEME.hookBg);
    expect(DEFAULT_PALETTE.hook.accent).toBe(THEME.hookLime);
  });
  it('默认配色的组合也都 ≥ 4.5，且进了成片检查的配色表', () => {
    for (const pair of palettePairs(DEFAULT_PALETTE)) expect(contrastRatio(pair.fg, pair.bg), pair.label).toBeGreaterThanOrEqual(4.5);
    const night = paletteFor(NIGHT);
    const labels = defaultPalette(night).map((p) => `${p.fg}/${p.bg}`);
    expect(labels).toContain(`${night.ink}/${night.card}`);
    expect(labels).toContain(`${night.hook.accent}/${night.hook.bg}`);
  });
});

describe('fitLightness', () => {
  it('往亮处调到对深底 ≥ 4.5', () => {
    const c = fitLightness(30, 0.8, 0.3, ['#101010'], 'up');
    expect(contrastRatio(c, '#101010')).toBeGreaterThanOrEqual(4.5);
  });
  it('往暗处调到对浅底 ≥ 4.5', () => {
    const c = fitLightness(30, 0.8, 0.7, ['#FFFFFF', '#F2EEE8'], 'down');
    expect(contrastRatio(c, '#F2EEE8')).toBeGreaterThanOrEqual(4.5);
  });
});

describe('片色随分镜落盘、进分段哈希', () => {
  const shots = [{ start: 0, end: 2, layout: 'split' as const, card: { template: 'title' as const, props: { title: '标题' } } }, { start: 2, end: 4, layout: 'full' as const }];
  it('归一化（编辑、素材步骤都会再走一遍）保留合法的片色，不合法的丢掉', () => {
    const palette = paletteFor(NIGHT);
    expect(normalizeStoryboard({ shots, palette }, 4, []).storyboard.palette).toEqual(palette);
    expect(normalizeStoryboard({ shots, palette: { tone: 'dark' } }, 4, []).storyboard.palette).toBeUndefined();
    expect('palette' in normalizeStoryboard({ shots }, 4, []).storyboard).toBe(false);
  });
  it('片色不同哈希不同（没有片色、夜景、客厅三种各不相同）', () => {
    const rest = { person: 'p.mp4', personWidth: 360, personHeight: 640, subject: null, captions: [], durationSec: 4 };
    const range = { start: 0, end: 60 };
    const a = shotHash(shots[0], rest, 0, { shots, range });
    const b = shotHash(shots[0], { ...rest, palette: paletteFor(NIGHT) }, 0, { shots, range });
    const c = shotHash(shots[0], { ...rest, palette: paletteFor(LIVING) }, 0, { shots, range });
    expect(new Set([a, b, c]).size).toBe(3);
  });
});

describe('backdropPixels / samplePalette（真实 ffmpeg）', () => {
  it('纯色图套 LUT 后取样：深蓝夜色 → 深色片色', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-palette-'));
    const file = join(dir, 'bg.png');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x182030:s=320x180', '-frames:v', '1', file]);
    const px = await backdropPixels(cfg.ffmpeg, file);
    expect(px.length).toBe(32 * 18);
    expect((await samplePalette(cfg.ffmpeg, file)).tone).toBe('dark');
    rmSync(dir, { recursive: true, force: true });
  });
  it('读不到画面时抛错', async () => {
    await expect(backdropPixels(cfg.ffmpeg, '/nonexistent/bg.png')).rejects.toThrow();
  });
});

describe('ctaIdle', () => {
  it('暗色片：未点胶囊是深色玻璃底 + 次文字色；亮色片沿用原白底灰字', () => {
    const night = paletteFor(NIGHT);
    expect(ctaIdle(night)).toMatchObject({ bg: night.glass.bg, fg: night.sub });
    expect(ctaIdle(paletteFor(LIVING))).toMatchObject({ bg: THEME.cta.idle.bg, fg: THEME.cta.idle.fg });
  });
});
