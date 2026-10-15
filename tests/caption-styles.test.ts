import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { fontPath, fontsReady, loadFonts } from '../src/assets/catalog.js';
import { CAPTION_MAX_WIDTH, CAPTION_STYLES, DEFAULT_CAPTION_STYLE, fitCaptionSize, splitHighlight, type CaptionStyleId } from '../src/captions/styles.js';
import { stageCaptionFont } from '../src/compose/stage-assets.js';
import { renderCaptionStill } from '../src/compose/render.js';
import { run } from '../src/media/exec.js';
import { displayWidth } from '../src/captions/lines.js';

const IDS = Object.keys(CAPTION_STYLES) as CaptionStyleId[];

describe('字幕样式表', () => {
  it('6 套，默认 blade；字体 id 都在素材清单里', () => {
    expect(IDS).toEqual(['blade', 'wenkai', 'smiley', 'minimal', 'kuaile', 'song']);
    expect(DEFAULT_CAPTION_STYLE).toBe('blade');
    const fonts = loadFonts();
    for (const id of IDS) {
      const f = fonts.find((x) => x.id === CAPTION_STYLES[id].font);
      expect(f, id).toBeDefined();
      expect(f?.family, id).toBe(CAPTION_STYLES[id].family);
    }
  });

  it('关键配色与描边符合设计', () => {
    expect(CAPTION_STYLES.blade).toMatchObject({ color: '#FFFFFF', weight: 900, stroke: { width: 10, color: '#000000' } });
    expect(CAPTION_STYLES.wenkai.color).toBe('#FFF6E8');
    expect(CAPTION_STYLES.smiley.highlight).toBe('#D4F23C');
    expect(CAPTION_STYLES.minimal.box?.color).toBe('rgba(0,0,0,0.55)');
    expect(CAPTION_STYLES.kuaile.color).toBe('#FFE14D');
    expect(CAPTION_STYLES.song).toMatchObject({ weight: 800, stroke: { width: 8, color: '#000000' } });
  });
});

describe('splitHighlight', () => {
  it('把数字（含小数、百分号）切成高亮片段，其余保持原样', () => {
    expect(splitHighlight('成本降了80%，快3.5倍')).toEqual([
      { text: '成本降了', hot: false }, { text: '80%', hot: true }, { text: '，快', hot: false }, { text: '3.5', hot: true }, { text: '倍', hot: false },
    ]);
  });
  it('没有数字时只有一段', () => {
    expect(splitHighlight('没有数字')).toEqual([{ text: '没有数字', hot: false }]);
  });
});

describe('fitCaptionSize', () => {
  it('字幕最大宽度 840（左右各留 120），居中后右缘不进入点赞栏 x≥960', () => {
    expect(CAPTION_MAX_WIDTH).toBe(840);
    expect((1080 + CAPTION_MAX_WIDTH) / 2).toBeLessThanOrEqual(960);
  });
  it('14 字整行放得下时用基准字号', () => {
    for (const id of IDS) expect(fitCaptionSize('一二三四五六七八九十一二三四', CAPTION_STYLES[id])).toBe(CAPTION_STYLES[id].size);
  });
  it('超宽按可用宽度缩小，且每套样式的最终宽度不超过画布内边距', () => {
    const text = '一二三四五六七八九十一二三四五六七八九十';
    for (const id of IDS) {
      const s = CAPTION_STYLES[id];
      const size = fitCaptionSize(text, s);
      expect(size).toBeLessThan(s.size);
      expect(displayWidth(text) * size + 2 * (s.box?.padX ?? 0)).toBeLessThanOrEqual(CAPTION_MAX_WIDTH);
    }
  });
});

describe('stageCaptionFont', () => {
  const cfgWith = (dataDir: string) => ({ ...loadConfig({}), dataDir });

  it('字体已下载：复制到 workDir/fonts/，fallback=false', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mz-cf-data-'));
    const cfg = cfgWith(dataDir);
    const font = loadFonts().find((f) => f.id === CAPTION_STYLES.song.font)!;
    mkdirSync(join(dataDir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(fontPath(cfg, font), 'FONTDATA');
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cf-work-'));
    const out = await stageCaptionFont(workDir, cfg, 'song');
    expect(out).toEqual({ file: font.file, fallback: false });
    expect(readFileSync(join(workDir, 'fonts', font.file), 'utf8')).toBe('FONTDATA');
    expect(existsSync(join(workDir, 'fonts', 'NotoSansSC-VF.ttf'))).toBe(false);
  });

  it('字体文件为 0 字节（损坏）：按未下载处理，返回 fallback=true', async () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'mz-cf-zero-'));
    const cfg = cfgWith(dataDir);
    const font = loadFonts().find((f) => f.id === CAPTION_STYLES.song.font)!;
    mkdirSync(join(dataDir, 'assets', 'fonts'), { recursive: true });
    writeFileSync(fontPath(cfg, font), '');
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cf-work-'));
    expect(await stageCaptionFont(workDir, cfg, 'song')).toEqual({ file: '', fallback: true });
  });

  it('字体未下载：不报错，返回 fallback=true 且文件名为空', async () => {
    const cfg = cfgWith(mkdtempSync(join(tmpdir(), 'mz-cf-empty-')));
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cf-work-'));
    expect(await stageCaptionFont(workDir, cfg, 'blade')).toEqual({ file: '', fallback: true });
  });
});

describe.skipIf(!fontsReady(loadConfig({})))('字幕样式静帧（需已下载字体）', () => {
  const cfg = loadConfig({});
  const workDir = mkdtempSync(join(tmpdir(), 'mz-capstill-'));
  const outDir = join(import.meta.dirname, '..', 'work', 'caption-styles');
  const text = '省下80%的钱，效果反而更好';
  const stills = new Map<CaptionStyleId, Buffer>();

  it.each(IDS)('%s 渲染出静帧（>5KB）', async (id) => {
    mkdirSync(outDir, { recursive: true });
    if (!existsSync(join(workDir, 'bg.jpg'))) {
      await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x600', '-frames:v', '1', join(workDir, 'bg.jpg')]);
    }
    const { file } = await stageCaptionFont(workDir, cfg, id);
    const output = join(outDir, `${id}.png`);
    await renderCaptionStill({ workDir, captionStyle: id, captionFontFile: file, text, bg: 'bg.jpg', output });
    expect(statSync(output).size).toBeGreaterThan(5000);
    stills.set(id, readFileSync(output));
  }, 300_000);

  it('6 套样式渲染结果两两不同', () => {
    expect(stills.size).toBe(6);
    const hashes = new Set([...stills.values()].map((b) => b.toString('base64')));
    expect(hashes.size).toBe(6);
  });
});
