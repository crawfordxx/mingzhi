import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { buildCutFilter, renderCut } from '../src/cut/render-cut.js';
import { probe } from '../src/media/probe.js';

describe('buildCutFilter', () => {
  it('每段 trim/atrim + 20ms 淡入淡出，最后 concat', () => {
    const f = buildCutFilter([{ start: 0, end: 1 }, { start: 2.5, end: 3 }]);
    expect(f).toContain('[0:v]trim=start=0:end=1,setpts=PTS-STARTPTS[v0]');
    expect(f).toContain('[0:a]atrim=start=2.5:end=3,asetpts=PTS-STARTPTS,afade=t=in:st=0:d=0.02,afade=t=out:st=0.48:d=0.02[a1]');
    expect(f.endsWith('[v0][a0][v1][a1]concat=n=2:v=1:a=1[outv][outa]')).toBe(true);
  });

  it('没有保留区间时报错', () => {
    expect(() => buildCutFilter([])).toThrow('没有可保留的片段');
  });
});

describe('renderCut（ffmpeg）', () => {
  it('输出时长等于保留区间之和', async () => {
    const cfg = loadConfig({});
    const out = join(mkdtempSync(join(tmpdir(), 'mz-')), 'cut.mp4');
    await renderCut(join(import.meta.dirname, 'fixtures', 'talk.mp4'), [{ start: 0, end: 1 }, { start: 2, end: 3 }], out, cfg);
    const info = await probe(out, cfg);
    expect(info.durationSec).toBeGreaterThan(1.9);
    expect(info.durationSec).toBeLessThan(2.15);
    expect(info.fps).toBe(30);
  });
});
