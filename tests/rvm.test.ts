import { describe, expect, it, vi } from 'vitest';
import ort from 'onnxruntime-node';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { presetPath } from '../src/background/presets.js';
import { matteVideo, rvmReady } from '../src/matting/rvm.js';
import { compositeMatte } from '../src/matting/composite-matte.js';
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

  it('抠像结束（成功或失败）都释放 ORT 会话', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-rvm-rel-'));
    const input = await makeClip(cfg, dir);
    const released: string[] = [];
    const realCreate = ort.InferenceSession.create.bind(ort.InferenceSession);
    const spy = vi.spyOn(ort.InferenceSession, 'create').mockImplementation(async (...a) => {
      const session = await realCreate(...a);
      const realRelease = session.release.bind(session);
      session.release = async () => { released.push('released'); await realRelease(); };
      return session;
    });
    try {
      await matteVideo({ input, output: join(dir, 'ok.mp4'), backgroundPath: presetPath('cafe'), cfg });
      expect(released).toHaveLength(1);
      await expect(matteVideo({ input, output: join(dir, 'no-such-dir', 'out.mp4'), backgroundPath: presetPath('cafe'), cfg })).rejects.toThrow(/失败|错误/);
      expect(released).toHaveLength(2);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

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

describe.skipIf(!hasRvm())('灰度遮罩与只合成换背景（需要 RVM 模型）', () => {
  /** 取第 n 帧的 rgb24 / gray 原始像素 */
  const frameAt = (cfg: ReturnType<typeof loadConfig>, file: string, n: number, pixFmt: 'rgb24' | 'gray'): Promise<Buffer> =>
    runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n})`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-']);

  it('matteOutput 输出同尺寸灰度遮罩；compositeMatte 只用遮罩换背景（不建推理会话），同一背景下与抠像合成结果接近', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-matte-'));
    const input = join(dir, 'in.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', join(import.meta.dirname, 'fixtures', 'talk.mp4'), '-t', '2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const matte = join(dir, 'matte.mp4');
    const person = join(dir, 'person.mp4');
    const res = await matteVideo({ input, output: person, backgroundPath: presetPath('cafe'), cfg, matteOutput: matte });
    const m = await probe(matte, cfg);
    expect([m.width, m.height, m.fps]).toEqual([540, 960, 30]);
    const alpha = await frameAt(cfg, matte, 30, 'gray');
    expect(alpha.length).toBe(540 * 960);
    // 样片是纯色底（没有人），不对遮罩内容做断言；遮罩取值的正确性见 composite-matte.test.ts
    expect(res.fgMean === null || res.fgMean.length === 3).toBe(true);

    const spy = vi.spyOn(ort.InferenceSession, 'create');
    try {
      const same = join(dir, 'same.mp4');
      await compositeMatte({ input, matte, backgroundPath: presetPath('cafe'), output: same, fgMean: res.fgMean, cfg });
      await compositeMatte({ input, matte, backgroundPath: presetPath('study'), output: join(dir, 'study.mp4'), fgMean: res.fgMean, cfg });
      expect(spy).not.toHaveBeenCalled();
      const info = await probe(same, cfg);
      expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([540, 960, 30, true]);
      expect(Math.abs(info.durationSec - (await probe(person, cfg)).durationSec)).toBeLessThan(0.1);
      const [a, b] = await Promise.all([frameAt(cfg, person, 30, 'rgb24'), frameAt(cfg, same, 30, 'rgb24')]);
      const meanDiff = a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
      expect(meanDiff).toBeLessThan(8);
    } finally {
      spy.mockRestore();
    }
  }, 120_000);
});
