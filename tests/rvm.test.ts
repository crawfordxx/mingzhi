import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
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

  async function makeClip(cfg: ReturnType<typeof loadConfig>, dir: string): Promise<string> {
    const input = join(dir, 'clip.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=180x320:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    return input;
  }

  it('输出目录不存在时报错退出，不挂起也不产生未处理的 rejection', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-rvm-err-'));
    const input = await makeClip(cfg, dir);
    const unhandled: unknown[] = [];
    const onUnhandled = (e: unknown): void => { unhandled.push(e); };
    process.on('unhandledRejection', onUnhandled);
    try {
      await expect(matteVideo({ input, output: join(dir, 'no-such-dir', 'out.mp4'), backgroundPath: presetPath('cafe'), cfg })).rejects.toThrow(/失败|错误/);
      await new Promise((r) => setTimeout(r, 200));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  }, 20000);

  it('输入不是视频时以中文错误拒绝', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-rvm-bad-'));
    const input = join(dir, 'x.mp4');
    writeFileSync(input, 'not a video');
    await expect(matteVideo({ input, output: join(dir, 'out.mp4'), backgroundPath: presetPath('cafe'), cfg })).rejects.toThrow(/[\u4e00-\u9fa5]/);
  }, 20000);
});
