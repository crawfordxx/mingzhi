import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SFX, fontPath, fontsReady, loadFonts, loadTracks, musicReady, sfxPath, trackPath } from '../src/assets/catalog.js';

describe('素材清单', () => {
  it('配乐 19 首，三种情绪各至少 4 首，id 不重复', () => {
    const tracks = loadTracks();
    expect(tracks).toHaveLength(19);
    expect(new Set(tracks.map((t) => t.id)).size).toBe(19);
    for (const mood of ['chill', 'tech', 'upbeat'] as const) {
      expect(tracks.filter((t) => t.mood === mood).length).toBeGreaterThanOrEqual(4);
    }
  });

  it('字体 6 款，sha256 均为 64 位十六进制', () => {
    const fonts = loadFonts();
    expect(fonts).toHaveLength(6);
    for (const f of fonts) expect(f.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('SFX 每个文件都在 assets/sfx/ 中存在', () => {
    for (const id of Object.keys(SFX) as (keyof typeof SFX)[]) {
      expect(existsSync(sfxPath(id)), id).toBe(true);
    }
    expect(existsSync(join(sfxPath('click'), '..', 'LICENSE.txt'))).toBe(true);
  });
});

describe('素材就绪检查', () => {
  it('空数据目录下 musicReady / fontsReady 为 false', () => {
    const cfg = loadConfig({ MINGZHI_DATA_DIR: mkdtempSync(join(tmpdir(), 'mz-assets-')) });
    expect(musicReady(cfg)).toBe(false);
    expect(fontsReady(cfg)).toBe(false);
  });

  it('素材路径位于 <dataDir>/assets 下', () => {
    const cfg = loadConfig({ MINGZHI_DATA_DIR: '/data' });
    expect(trackPath(cfg, loadTracks()[0])).toBe(join('/data', 'assets', 'music', 'families.mp3'));
    expect(fontPath(cfg, loadFonts()[0])).toBe(join('/data', 'assets', 'fonts', 'NotoSansSC-VF.ttf'));
  });
});
