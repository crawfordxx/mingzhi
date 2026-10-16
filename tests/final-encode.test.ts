import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { FINAL_ENCODE, finalVideoArgs } from '../src/media/encode.js';
import { normalizeLoudness } from '../src/audio/loudness.js';

const cfg = loadConfig({});

interface VideoInfo { pix_fmt: string; width: number; height: number; r_frame_rate: string; bit_rate: string; codec_name: string }

async function videoInfo(file: string): Promise<VideoInfo> {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=pix_fmt,width,height,r_frame_rate,bit_rate,codec_name', '-of', 'json', file]);
  return (JSON.parse(stdout) as { streams: VideoInfo[] }).streams[0];
}

/** 成片整体平均亮度（0–255），用来看编码有没有把色彩范围搞错 */
async function meanLuma(file: string): Promise<number> {
  const raw = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', 'scale=108:192', '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  return raw.reduce((s, v) => s + v, 0) / raw.length;
}

describe('成片最终编码参数', () => {
  it('H.264 crf 18–20 + maxrate 8–12 Mbps + bufsize，yuv420p，faststart', () => {
    expect(FINAL_ENCODE.crf).toBeGreaterThanOrEqual(18);
    expect(FINAL_ENCODE.crf).toBeLessThanOrEqual(20);
    expect(FINAL_ENCODE.maxrateKbps).toBeGreaterThanOrEqual(8000);
    expect(FINAL_ENCODE.maxrateKbps).toBeLessThanOrEqual(12000);
    expect(FINAL_ENCODE.bufsizeKbps).toBeGreaterThanOrEqual(FINAL_ENCODE.maxrateKbps);
    const args = finalVideoArgs();
    const at = (flag: string): string => args[args.indexOf(flag) + 1];
    expect(at('-c:v')).toBe('libx264');
    expect(at('-crf')).toBe(String(FINAL_ENCODE.crf));
    expect(at('-maxrate')).toBe(`${FINAL_ENCODE.maxrateKbps}k`);
    expect(at('-bufsize')).toBe(`${FINAL_ENCODE.bufsizeKbps}k`);
    expect(at('-pix_fmt')).toBe('yuv420p');
  });
});

describe('响度统一步骤同时做最终视频编码', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mz-final-enc-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('带噪的 1080×1920 全幅 yuvj420p 渲染件：输出码率被压到 maxrate 附近，yuv420p，尺寸帧率不变，亮度不偏', async () => {
    const input = join(dir, 'noisy.mp4');
    // 模拟 Remotion 渲染件：crf 18、全幅范围（yuvj420p）、满屏时域噪声（最坏情况）
    await run(cfg.ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1920:r=30:d=4,noise=alls=28:allf=t', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4:sample_rate=48000',
      '-t', '4', '-c:v', 'libx264', '-crf', '18', '-pix_fmt', 'yuvj420p', '-c:a', 'aac', input,
    ]);
    const output = join(dir, 'noisy-final.mp4');
    await normalizeLoudness(input, output, cfg);
    const [a, b] = await Promise.all([videoInfo(input), videoInfo(output)]);
    expect(Number(a.bit_rate)).toBeGreaterThan(FINAL_ENCODE.maxrateKbps * 1000 * 1.5);
    expect(b.codec_name).toBe('h264');
    expect(b.pix_fmt).toBe('yuv420p');
    expect([b.width, b.height, b.r_frame_rate]).toEqual([1080, 1920, '30/1']);
    // 约束码率的理论上限：maxrate + bufsize / 片长（起始缓冲区可以先用掉）
    expect(Number(b.bit_rate)).toBeLessThanOrEqual((FINAL_ENCODE.maxrateKbps + FINAL_ENCODE.bufsizeKbps / 4) * 1000 * 1.03);
    expect(Math.abs((await meanLuma(output)) - (await meanLuma(input)))).toBeLessThan(2);
  }, 120_000);
});
