import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { renderCardStill, renderTalk } from '../src/compose/render.js';

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

  it('单卡静帧 1080×960 PNG', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-still-'));
    const output = join(workDir, 'card.png');
    await renderCardStill({ workDir, output, card: { template: 'title', props: { title: '标题卡' } } });
    expect(existsSync(output)).toBe(true);
    expect(statSync(output).size).toBeGreaterThan(1000);
  }, 300_000);
});
