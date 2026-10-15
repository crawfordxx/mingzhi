import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildEditPlan } from '../src/cut/plan.js';
import { buildCutFilter, renderCut } from '../src/cut/render-cut.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';

describe('buildCutFilter', () => {
  it('每段 fps=30 归一化、宽高取偶后 trim、atrim + 20ms 淡入淡出，最后 concat', () => {
    const f = buildCutFilter([{ start: 0, end: 1 }, { start: 2.5, end: 3 }]);
    expect(f).toContain('[0:v]fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2,trim=start=0:end=1,setpts=PTS-STARTPTS[v0]');
    expect(f).toContain('[0:a]apad,atrim=start=2.5:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.02,afade=t=out:st=0.48:d=0.02[a1]');
    expect(f.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]')).toBe(true);
  });

  it('没有保留区间时报错', () => {
    expect(() => buildCutFilter([])).toThrow('没有可保留的片段');
  });
});

describe('renderCut（ffmpeg）', () => {
  it('输出时长等于保留区间之和；滤镜写入输出同目录的文件（避开命令行长度上限）', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-'));
    const out = join(dir, 'cut.mp4');
    const keep = [{ start: 0, end: 1 }, { start: 2, end: 3 }];
    await renderCut(join(import.meta.dirname, 'fixtures', 'talk.mp4'), keep, out, cfg);
    expect(readFileSync(join(dir, 'cut.filter.txt'), 'utf8')).toBe(buildCutFilter(keep));
    const info = await probe(out, cfg);
    expect(info.durationSec).toBeGreaterThan(1.9);
    expect(info.durationSec).toBeLessThan(2.15);
    expect(info.fps).toBe(30);
  });

  it('奇数宽高的输入（181×321）也能渲染，输出宽高取偶', async () => {
    const cfg = loadConfig({});
    const dir = mkdtempSync(join(tmpdir(), 'mz-'));
    const input = join(dir, 'odd.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=181x321:r=30:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv444p', '-c:a', 'aac', input]);
    expect((await probe(input, cfg)).width).toBe(181);
    const out = join(dir, 'cut.mp4');
    await renderCut(input, [{ start: 0, end: 1 }], out, cfg);
    const info = await probe(out, cfg);
    expect([info.width, info.height]).toEqual([180, 320]);
  });

  it('切 60 段以上时成片时长与剪辑方案一致到 1 帧以内', async () => {
    const cfg = loadConfig({});
    const fixture = join(import.meta.dirname, 'fixtures', 'talk.mp4');
    const src = await probe(fixture, cfg);
    // 每 0.29 秒一段、每段约 0.19 秒，边界故意不落在帧上
    const segments = Array.from({ length: 64 }, (_, i) => ({ start: 0.013 + i * 0.29, end: 0.2071 + i * 0.29 })).filter((s) => s.end < src.durationSec);
    const plan = buildEditPlan(segments, [], src.durationSec, { pad: 0, mergeGap: 0.05, minKeep: 0.1 });
    expect(plan.keep.length).toBeGreaterThanOrEqual(60);
    const out = join(mkdtempSync(join(tmpdir(), 'mz-')), 'cut.mp4');
    await renderCut(fixture, plan.keep, out, cfg);
    const info = await probe(out, cfg);
    expect(Math.abs(info.durationSec - plan.outputDurationSec)).toBeLessThan(1 / 30);
    // 样片音轨比画面短约 1.4 秒，末尾几段也要补静音，保证每段音视频等长
    const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-show_entries', 'stream=duration', '-of', 'csv=p=0', out]);
    const streams = stdout.trim().split('\n').map(Number);
    expect(streams).toHaveLength(2);
    streams.forEach((d) => expect(Math.abs(d - plan.outputDurationSec)).toBeLessThan(1 / 30));
  });
});
