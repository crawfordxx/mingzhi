import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { THEME } from '../render/theme.js';
import { contrastRatio } from '../src/qa/contrast.js';
import { defaultPalette } from '../src/qa/palette.js';
import { checkContrast, checkSafeArea, hardChecks, parseBlackSegments, parseEbur128, type HardCheck } from '../src/qa/hard.js';

const cfg = loadConfig({});
const byId = (checks: HardCheck[], id: HardCheck['id']): HardCheck => checks.find((c) => c.id === id)!;
const PALETTE = [{ fg: '#000000', bg: '#FFFFFF', label: '黑白' }];
const LAYOUT = { captionCenters: [960, 1400] };

describe('contrastRatio', () => {
  it('黑白为 21，同色为 1，与顺序无关', () => {
    expect(contrastRatio('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastRatio('#FFFFFF', '#000000')).toBeCloseTo(21, 5);
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });
  it('#777777 对白约 4.48', () => {
    expect(contrastRatio('#777777', '#FFFFFF')).toBeCloseTo(4.48, 2);
  });
  it('格式非法时抛错', () => {
    expect(() => contrastRatio('red', '#FFFFFF')).toThrow('#RRGGBB');
  });
});

describe('解析', () => {
  it('parseEbur128 取 Summary 的 I 与 Peak（忽略过程中的 I:）', () => {
    const stderr = `[Parsed_ebur128_0 @ 0x1] t: 1  M: -20 S: -20 I: -99.0 LUFS LRA: 0.0 LU FTPK: -3 dBFS
[Parsed_ebur128_0 @ 0x1] Summary:

  Integrated loudness:
    I:         -14.2 LUFS
    Threshold: -24.2 LUFS

  Loudness range:
    LRA:         0.0 LU

  True peak:
    Peak:       -1.8 dBFS
`;
    expect(parseEbur128(stderr)).toEqual({ lufs: -14.2, peak: -1.8 });
  });
  it('静音输出 -inf，没有 Summary 时报错', () => {
    const silent = 'Summary:\n  Integrated loudness:\n    I:         -inf LUFS\n  True peak:\n    Peak:       -inf dBFS\n';
    expect(parseEbur128(silent)).toEqual({ lufs: -Infinity, peak: -Infinity });
    expect(() => parseEbur128('nothing')).toThrow('Summary');
  });
  it('parseBlackSegments', () => {
    expect(parseBlackSegments('[blackdetect @ 0x1] black_start:1 black_end:2 black_duration:1')).toEqual([{ start: 1, end: 2 }]);
  });
});

describe('checkSafeArea', () => {
  it('默认（与 CaptionLayer 共用的 CAPTION_MAX_WIDTH=840）通过', () => {
    const c = checkSafeArea(LAYOUT);
    expect(c.ok).toBe(true);
    expect(c.detail).toContain('840');
  });
  it('宽度 960 时右缘 1020 进入点赞栏，detail 含数字', () => {
    const c = checkSafeArea({ captionCenters: [960, 1400], captionMaxWidth: 960 });
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('1020');
  });
  it('字幕中心太靠下或太靠上都失败', () => {
    expect(checkSafeArea({ captionCenters: [1560], captionMaxWidth: 840 }).ok).toBe(false);
    expect(checkSafeArea({ captionCenters: [200], captionMaxWidth: 840 }).ok).toBe(false);
  });
});

describe('checkContrast', () => {
  it('低于 4.5 的配色被列出', () => {
    const c = checkContrast([...PALETTE, { fg: '#777777', bg: '#FFFFFF', label: '灰字' }]);
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('灰字 4.48');
  });
  it('默认配色（THEME 文字/底色 + 6 套字幕）全部 ≥ 4.5', () => {
    const c = checkContrast(defaultPalette());
    expect(c.detail).toContain('均 ≥ 4.5');
    expect(c.ok).toBe(true);
  });
  it('faint 仅用于划掉文字与装饰点，不进文字配色表', () => {
    expect(defaultPalette().some((p) => p.fg === THEME.faint)).toBe(false);
  });
  it('6 套字幕样式的字色/描边（或底框）全部达标', () => {
    const captions = defaultPalette().filter((p) => p.label.startsWith('字幕'));
    expect(captions.length).toBeGreaterThanOrEqual(6);
    expect(checkContrast(captions).ok).toBe(true);
  });
});

describe('hardChecks（真实 ffmpeg）', () => {
  let dir: string;
  const make = async (name: string, volume: string, vfExtra = ''): Promise<string> => {
    const out = join(dir, name);
    await run(cfg.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=4', '-f', 'lavfi', '-i', `sine=f=440:d=4,volume=${volume}`,
      '-vf', `format=yuv420p${vfExtra}`, '-c:v', 'libx264', '-c:a', 'aac', '-shortest', out]);
    return out;
  };
  beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'qa-hard-')); });
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });

  it('正常视频：七项全部通过', async () => {
    const checks = await hardChecks(await make('ok.mp4', '7dB'), LAYOUT, PALETTE, cfg);
    expect(checks.map((c) => [c.id, c.ok])).toEqual([
      ['resolution', true], ['fps', true], ['loudness', true], ['truePeak', true], ['blackFrames', true], ['safeArea', true], ['contrast', true],
    ]);
  }, 60_000);

  it('-30 dB 正弦：响度失败', async () => {
    const c = byId(await hardChecks(await make('quiet.mp4', '-9dB'), LAYOUT, PALETTE, cfg), 'loudness');
    expect(c.ok).toBe(false);
    expect(c.detail).toContain('LUFS');
  }, 60_000);

  it('含 1 秒黑场：blackFrames 失败；片尾黑场不算', async () => {
    const mid = await make('black-mid.mp4', '7dB', ",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,2)'");
    expect(byId(await hardChecks(mid, LAYOUT, PALETTE, cfg), 'blackFrames').ok).toBe(false);
    const tail = await make('black-tail.mp4', '7dB', ",drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='gte(t,3.5)'");
    expect(byId(await hardChecks(tail, LAYOUT, PALETTE, cfg), 'blackFrames').ok).toBe(true);
  }, 60_000);

  it('尺寸不对：resolution 失败', async () => {
    const out = join(dir, 'small.mp4');
    await run(cfg.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=25:d=2', '-f', 'lavfi', '-i', 'sine=d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
    const checks = await hardChecks(out, LAYOUT, PALETTE, cfg);
    expect(byId(checks, 'resolution').ok).toBe(false);
    expect(byId(checks, 'fps').ok).toBe(false);
  }, 60_000);
});
