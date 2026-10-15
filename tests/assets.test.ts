import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { SFX, fontPath, fontsReady, loadFonts, loadTracks, musicReady, parseFontsManifest, parseMusicManifest, sfxPath, trackPath } from '../src/assets/catalog.js';

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

describe('清单校验', () => {
  const SHA = 'a'.repeat(64);
  const track = { id: 't1', title: '曲', zip: 'z', entry: 'a/b.mp3', mood: 'chill', energy: 1, durationSec: 10 };
  const music = (over: object = {}, tracks = [track]) => ({ license: 'CC0', zips: { z: { url: 'https://x.example/z.zip', sha256: SHA } }, tracks, ...over });
  const font = { id: 'f1', family: 'F', url: 'https://x.example/f.ttf', file: 'f.ttf', sha256: SHA };

  it('合法清单通过', () => {
    expect(() => parseMusicManifest(music())).not.toThrow();
    expect(() => parseFontsManifest({ license: 'OFL', fonts: [font] })).not.toThrow();
  });

  it('曲目 id 含斜杠或 ..、zip 简称不在 zips 里、id 重复都报错', () => {
    expect(() => parseMusicManifest(music({}, [{ ...track, id: '../evil' }]))).toThrow();
    expect(() => parseMusicManifest(music({}, [{ ...track, id: 'a/b' }]))).toThrow();
    expect(() => parseMusicManifest(music({}, [{ ...track, id: '..' }]))).toThrow();
    expect(() => parseMusicManifest(music({}, [{ ...track, zip: 'nope' }]))).toThrow('不在 zips 里');
    expect(() => parseMusicManifest(music({}, [track, { ...track }]))).toThrow('重复');
    expect(() => parseMusicManifest(music({ zips: { '../z': { url: 'https://x.example/z.zip', sha256: SHA } } }))).toThrow();
  });

  it('字体 id / file 含路径分隔符、id 重复都报错', () => {
    expect(() => parseFontsManifest({ license: 'OFL', fonts: [{ ...font, file: '../f.ttf' }] })).toThrow();
    expect(() => parseFontsManifest({ license: 'OFL', fonts: [{ ...font, file: 'sub/f.ttf' }] })).toThrow();
    expect(() => parseFontsManifest({ license: 'OFL', fonts: [{ ...font, id: 'a/b' }] })).toThrow();
    expect(() => parseFontsManifest({ license: 'OFL', fonts: [font, { ...font, file: 'g.ttf' }] })).toThrow('重复');
  });
});
