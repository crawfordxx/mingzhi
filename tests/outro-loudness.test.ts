// 片尾响度校正与成片硬检查「片尾响度」（用 ffmpeg 合成的小片，不跑 Remotion）
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { limitTailLoudness } from '../src/audio/loudness.js';
import { run } from '../src/media/exec.js';
import { TAIL_MAX_LUFS, checkOutroLoudness, measureTailLufs } from '../src/qa/hard.js';

const cfg = loadConfig({});

/** 6 秒黑场视频：前 3 秒音轨增益 headDb、后 3 秒 tailDb（口播与片尾；sine 滤镜默认幅度 -18 dBFS，0 dB 增益约 -22 LUFS） */
async function makeClip(headDb: number, tailDb: number): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), 'mz-tail-'));
  const out = join(dir, 'clip.mp4');
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=64x64:r=30:d=6', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6',
    '-af', `volume='pow(10,if(lt(t,3),${headDb},${tailDb})/20)':eval=frame`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', out]);
  return out;
}

describe('片尾响度校正', () => {
  it('片尾高于 -18 LUFS：只衰减片尾直到达标，口播不动', async () => {
    const clip = await makeClip(8, 14);
    const speechBefore = await measureWindow(clip, 0.2, 2.8);
    expect(await measureTailLufs(clip, 3, cfg)).toBeGreaterThan(TAIL_MAX_LUFS);
    const r = await limitTailLoudness(clip, 6, 3, cfg);
    expect(r.before).toBeGreaterThan(TAIL_MAX_LUFS);
    expect(r.attenuatedDb).toBeGreaterThan(0);
    expect(await measureTailLufs(clip, 3, cfg)).toBeLessThanOrEqual(TAIL_MAX_LUFS);
    expect(Math.abs((await measureWindow(clip, 0.2, 2.8)) - speechBefore)).toBeLessThan(0.6);
  }, 60_000);

  it('已经达标时原样返回，不重编码', async () => {
    const clip = await makeClip(8, -8);
    const r = await limitTailLoudness(clip, 6, 3, cfg);
    expect(r).toMatchObject({ attenuatedDb: 0 });
    expect(r.after).toBe(r.before);
  }, 60_000);

  it('硬检查 outroLoudness：超标不通过、达标通过', async () => {
    expect((await checkOutroLoudness(await makeClip(8, 14), 6, cfg)).ok).toBe(false);
    const ok = await checkOutroLoudness(await makeClip(8, -8), 6, cfg);
    expect(ok).toMatchObject({ id: 'outroLoudness', ok: true });
    expect(ok.detail).toContain('LUFS');
  }, 60_000);
});

/** 一段时间内的积分响度 */
async function measureWindow(file: string, from: number, to: number): Promise<number> {
  const { stderr } = await run(cfg.ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `atrim=${from}:${to},asetpts=N/SR/TB,ebur128`, '-f', 'null', '-']);
  return Number(/I:\s*(-?[\d.]+)\s*LUFS/.exec(stderr.slice(stderr.lastIndexOf('Summary:')))?.[1]);
}
