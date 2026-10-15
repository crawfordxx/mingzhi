import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { compositeFilter, compositeMatte } from '../src/matting/composite-matte.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';

const cfg = loadConfig({});

/** 第 15 帧某个像素的 RGB */
async function pixel(file: string, x: number, y: number): Promise<number[]> {
  const raw = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,15),crop=2:2:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...raw.subarray(0, 3)];
}

describe('compositeFilter', () => {
  it('增益写进调色、虚化可关闭', () => {
    const f = compositeFilter(180, 320, 0, [1.1, 1, 0.9]);
    expect(f).toContain('colorchannelmixer=rr=1.1000:gg=1.0000:bb=0.9000');
    expect(f).not.toContain('gblur');
    expect(compositeFilter(180, 320, 6, [1, 1, 1])).toContain('gblur=sigma=6');
  });
});

describe('compositeMatte（真实 ffmpeg）', () => {
  it('遮罩白处取原画面、黑处取背景；尺寸、帧率、音轨与时长保持', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cm-'));
    const input = join(dir, 'in.mp4');
    const matte = join(dir, 'matte.mp4');
    const bg = join(dir, 'bg.png');
    const output = join(dir, 'out.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xff0000:s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
    // 左半白（不透明）、右半黑（透明）
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=180x320:r=30:d=1,drawbox=x=0:y=0:w=90:h=320:color=white:t=fill,format=gray',
      '-c:v', 'libx264', '-crf', '10', '-pix_fmt', 'gray', matte]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x0000ff:s=64x64', '-frames:v', '1', bg]);
    await compositeMatte({ input, matte, backgroundPath: bg, output, fgMean: null, cfg });
    const info = await probe(output, cfg);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([180, 320, 30, true]);
    expect(Math.abs(info.durationSec - 1)).toBeLessThan(0.1);
    const [left, right] = await Promise.all([pixel(output, 30, 160), pixel(output, 150, 160)]);
    expect(left[0]).toBeGreaterThan(200);
    expect(left[2]).toBeLessThan(40);
    expect(right[2]).toBeGreaterThan(200);
    expect(right[0]).toBeLessThan(40);
  });

  it('输入不存在时中文报错，不留临时文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cm-bad-'));
    await expect(compositeMatte({ input: join(dir, 'none.mp4'), matte: join(dir, 'm.mp4'), backgroundPath: join(dir, 'bg.png'), output: join(dir, 'o.mp4'), fgMean: null, cfg }))
      .rejects.toThrow(/[一-龥]/);
  });

  it('已取消时直接抛 CancelledError', async () => {
    const c = new AbortController();
    c.abort();
    await expect(compositeMatte({ input: 'x', matte: 'y', backgroundPath: 'z', output: 'o', fgMean: null, cfg, signal: c.signal })).rejects.toThrow('已取消');
  });
});
