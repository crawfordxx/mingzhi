import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { presetPath } from '../src/background/presets.js';
import { matteVideo, rvmReady } from '../src/matting/rvm.js';
import { hasRvm } from './helpers/models.js';

describe('rvmReady', () => {
  it('模型文件不存在时为 false', () => {
    expect(rvmReady(mkdtempSync(join(tmpdir(), 'mz-none-')))).toBe(false);
  });
});

describe.skipIf(!hasRvm())('matteVideo（需要 RVM 模型）', () => {
  it('输出与输入同尺寸、同时长、30fps、保留音轨，并报告进度与取景框', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-rvm-'));
    const input = join(dir, 'in.mp4');
    // 1.5 秒 180×320：灰底上一个移动的肤色圆（RVM 可能抠出也可能抠不出，断言不依赖抠像结果）
    await run(cfg.ffmpeg, ['-v', 'error', '-y',
      '-f', 'lavfi', '-i', 'color=c=0x808080:s=180x320:r=30:d=1.5,drawbox=x=50+t*20:y=80:w=80:h=160:color=0xd8a080:t=fill',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.5',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', input]);
    const output = join(dir, 'out.mp4');
    const progress: number[] = [];
    const res = await matteVideo({ input, output, backgroundPath: presetPath('cafe'), cfg, onProgress: (done) => progress.push(done) });
    const info = await probe(output, cfg);
    expect(info.width).toBe(180);
    expect(info.height).toBe(320);
    expect(info.fps).toBe(30);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.durationSec - 1.5)).toBeLessThan(0.1);
    expect(res.frames).toBe(45);
    expect(progress[progress.length - 1]).toBe(45);
    expect(res.gains).toHaveLength(3);
  });
});
