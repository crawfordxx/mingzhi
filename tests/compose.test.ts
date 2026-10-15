import { describe, expect, it } from 'vitest';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { availableParallelism } from 'node:os';
import { defaultConcurrency, renderCardStill, renderTalk, withBundle } from '../src/compose/render.js';

describe('renderTalk（真实 Remotion 渲染，首次运行会下载 Chrome Headless Shell）', () => {
  it('2 秒：分屏卡片 + 全屏，输出 1080×1920 30fps 带音轨', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-compose-'));
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=2', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workDir, 'person.mp4')]);
    const output = join(workDir, 'final.mp4');
    const ratios: number[] = [];
    await renderTalk({ workDir, output, onProgress: (r) => ratios.push(r), props: {
      person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 2,
      captions: [{ start: 0, end: 1, text: '第一行字幕' }, { start: 1, end: 2, text: '第二行字幕' }],
      shots: [{ start: 0, end: 1, layout: 'split', card: { template: 'title', props: { title: '标题卡' } } }, { start: 1, end: 2, layout: 'full' }],
    } });
    const info = await probe(output, cfg);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([1080, 1920, 30, true]);
    expect(Math.abs(info.durationSec - 2)).toBeLessThan(0.1);
    expect(ratios[ratios.length - 1]).toBe(1);
  }, 300_000);

  it('视频卡在 3 秒起的镜头里从头播放并循环：3.0 秒与 7.0 秒（相隔一个 4 秒素材）画面一致，5.0 秒不同', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-loop-'));
    mkdirSync(join(workDir, 'broll'));
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, 'person.mp4')]);
    // 4 秒 30fps 的色相循环素材：一整圈色相正好是 4 秒
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=720x720:r=30:d=4,hue=H=2*PI*t/4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, 'broll', 'c.mp4')]);
    const output = join(workDir, 'final.mp4');
    await renderTalk({ workDir, output, props: {
      person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 8, captions: [],
      shots: [{ start: 0, end: 3, layout: 'full' }, { start: 3, end: 8, layout: 'split', card: { template: 'photo', props: { video: 'broll/c.mp4' } } }],
    } });
    // 取卡片区（上半屏）一小块的 RGB（素材是纯色，任一点即可）；避开第 3 秒刚好的切换帧，各偏后 0.05 秒
    const pixel = async (sec: number, file = output): Promise<number[]> => [...(await runBuffer(cfg.ffmpeg, ['-v', 'error', '-ss', String(sec), '-i', file, '-frames:v', '1',
      '-vf', 'crop=4:4:540:100,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']))];
    const [start, mid, loop] = [await pixel(3.05), await pixel(5.05), await pixel(7.05)];
    const gap = (a: number[], b: number[]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    // 镜头 3.05 秒应对应素材 0.05 秒（从头播放；渲染与直接解码的色彩转换略有差异，容差放宽）；不对齐镜头起点时会落在素材的 3.05 秒，差别远大于容差
    expect(gap(start, await pixel(0.05, join(workDir, 'broll', 'c.mp4')))).toBeLessThanOrEqual(30);
    expect(gap(start, loop)).toBeLessThanOrEqual(12);
    expect(gap(start, mid)).toBeGreaterThan(60);
  }, 300_000);

  it('单卡静帧 1080×960 PNG', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-still-'));
    const output = join(workDir, 'card.png');
    await renderCardStill({ workDir, output, card: { template: 'title', props: { title: '标题卡' } } });
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(1000);
  }, 300_000);
});

describe('渲染封装', () => {
  it('默认并发不超过 CPU 核数', () => {
    expect(defaultConcurrency()).toBeLessThanOrEqual(availableParallelism());
    expect(defaultConcurrency()).toBeGreaterThanOrEqual(1);
  });

  it('打包目录在成功与失败后都被删除，且 publicDir 是软链而不是拷贝', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-bundle-'));
    writeFileSync(join(workDir, 'a.txt'), 'x');
    let okDir = '';
    await withBundle(workDir, async (serveUrl) => {
      okDir = serveUrl;
      expect(lstatSync(join(serveUrl, 'public')).isSymbolicLink()).toBe(true);
    });
    expect(existsSync(okDir)).toBe(false);
    let failDir = '';
    await expect(withBundle(workDir, async (serveUrl) => { failDir = serveUrl; throw new Error('boom'); })).rejects.toThrow('boom');
    expect(existsSync(failDir)).toBe(false);
  }, 120_000);
});
