import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';

const EXE = process.platform === 'win32' ? '.exe' : '';

describe('loadConfig', () => {
  it('默认数据目录为 ~/.mingzhi', () => {
    const cfg = loadConfig({});
    expect(cfg.dataDir).toBe(join(homedir(), '.mingzhi'));
    expect(cfg.modelsDir).toBe(join(homedir(), '.mingzhi', 'models'));
    expect(cfg.kexiangKey).toBeUndefined();
    expect(cfg.pexelsKey).toBeUndefined();
    expect(cfg.pixabayKey).toBeUndefined();
  });

  it('MINGZHI_PIXABAY_KEY 注入 pixabayKey，空串视为未设置', () => {
    expect(loadConfig({ MINGZHI_PIXABAY_KEY: 'pk' }).pixabayKey).toBe('pk');
    expect(loadConfig({ MINGZHI_PIXABAY_KEY: '' }).pixabayKey).toBeUndefined();
  });

  it('MINGZHI_DATA_DIR 为空串时回退默认数据目录', () => {
    expect(loadConfig({ MINGZHI_DATA_DIR: '' }).dataDir).toBe(join(homedir(), '.mingzhi'));
  });

  it('数据目录 bin 下没有自带 ffmpeg 时用系统 ffmpeg', () => {
    const cfg = loadConfig({ MINGZHI_DATA_DIR: mkdtempSync(join(tmpdir(), 'mz-')) });
    expect(cfg.ffmpeg).toBe('ffmpeg');
    expect(cfg.ffprobe).toBe('ffprobe');
  });

  it('优先使用数据目录 bin 下自带的 ffmpeg/ffprobe（启动器下载的带 libass 版本）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-'));
    mkdirSync(join(dir, 'bin'));
    writeFileSync(join(dir, 'bin', `ffmpeg${EXE}`), '');
    writeFileSync(join(dir, 'bin', `ffprobe${EXE}`), '');
    const cfg = loadConfig({ MINGZHI_DATA_DIR: dir });
    expect(cfg.ffmpeg).toBe(join(dir, 'bin', `ffmpeg${EXE}`));
    expect(cfg.ffprobe).toBe(join(dir, 'bin', `ffprobe${EXE}`));
  });

  it('环境变量可覆盖', () => {
    const cfg = loadConfig({ MINGZHI_DATA_DIR: '/tmp/mz', MINGZHI_FFMPEG: '/opt/ff', MINGZHI_FFPROBE: '/opt/fp', MINGZHI_KX_KEY: 'abc', MINGZHI_PEXELS_KEY: 'pk' });
    expect(cfg.modelsDir).toBe('/tmp/mz/models');
    expect(cfg.ffmpeg).toBe('/opt/ff');
    expect(cfg.ffprobe).toBe('/opt/fp');
    expect(cfg.kexiangKey).toBe('abc');
    expect(cfg.pexelsKey).toBe('pk');
  });

  it('Pexels key 为空串时视为未配置', () => {
    expect(loadConfig({ MINGZHI_PEXELS_KEY: '' }).pexelsKey).toBeUndefined();
  });
});
