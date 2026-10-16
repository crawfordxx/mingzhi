// 摄影级画面覆盖只算压暗不超过 50% 的底图；更深的不计入，并写进 film.unfixed
import { describe, expect, it } from 'vitest';
import { coverageMetric, deepShadeNotes, deepShadedShots, photoSeconds, type FilmReport } from '../src/qa/film.js';
import { runQaFilm } from '../src/pipeline/qa-step.js';
import type { Broll, CardSpec, Shot, Storyboard } from '../src/storyboard/schema.js';

const title = (t: string): CardSpec => ({ template: 'title', props: { title: t } });
const photo = (file: string, shade?: number): Broll => ({ file, kind: 'photo', focal: { x: 0.5, y: 0.5 }, ...(shade === undefined ? {} : { shade, legible: true }) });
const split = (start: number, end: number, broll: Broll): Shot => ({ start, end, layout: 'split', card: title('标题'), broll });
const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
const sb = (shots: Shot[]): Storyboard => ({ shots, bgm: 'chill' });

describe('覆盖率与压暗', () => {
  it('压暗 45% 的铺图照常计入；65% 的不计入，detail 写明是哪一镜', () => {
    const shots = [split(0, 4, photo('broll/a.jpg', 0.45)), split(4, 8, photo('broll/b.jpg', 0.65)), full(8, 16)];
    expect(photoSeconds(shots)).toBe(4);
    expect(deepShadedShots(shots)).toEqual([1]);
    const m = coverageMetric(shots, 16);
    expect(m.value).toBeCloseTo(0.25, 5);
    expect(m.detail).toMatch(/第 2 镜底图压暗超过 50%，不计入/);
    // 正好 50% 仍计入
    expect(photoSeconds([split(0, 4, photo('broll/a.jpg', 0.5))])).toBe(4);
  });

  it('全屏插入素材压暗过深同样不计入；没压暗的不受影响', () => {
    const deep: Shot = { start: 0, end: 3, layout: 'broll', broll: photo('broll/a.jpg', 0.7) };
    expect(photoSeconds([deep])).toBe(0);
    expect(photoSeconds([{ ...deep, broll: photo('broll/a.jpg') }])).toBe(3);
  });

  it('deepShadeNotes：逐镜写出压暗量', () => {
    expect(deepShadeNotes([full(0, 2), split(2, 6, photo('broll/b.jpg', 0.65))])).toEqual(['第 2 镜底图压暗 65%（超过 50%），不计入摄影级画面覆盖']);
  });
});

describe('整片自检把过深的压暗写进 film.unfixed', () => {
  const ok: FilmReport = { ok: true, durationSec: 8, metrics: [], templates: [], skipped: [] };
  const ctx = { cfg: { ffmpeg: 'ffmpeg' } as never, workDir: '/tmp', redo: true };
  const sink = () => {
    const patches: { message: string; patch?: Record<string, unknown> }[] = [];
    return { patches, complete: (_s: string, message: string, patch?: unknown) => { patches.push({ message, patch: patch as Record<string, unknown> }); return {} as never; } };
  };

  it('没做重做：按当前分镜写', async () => {
    const { complete } = sink();
    const shots = [split(0, 4, photo('broll/b.jpg', 0.65)), full(4, 8)];
    const res = await runQaFilm({ ...ctx, measure: async () => ok }, { video: 'out.mp4', storyboard: sb(shots) }, [], async () => { throw new Error('不应重渲'); }, complete);
    expect(res.film?.unfixed).toContain('第 1 镜底图压暗 65%（超过 50%），不计入摄影级画面覆盖');
  });

  it('重做后的分镜里有压到 65% 的底图：按重做后的分镜写', async () => {
    const { complete } = sink();
    const bad: FilmReport = { ...ok, ok: false, metrics: [{ id: 'blank', label: '上半屏空白率', value: 0.9, limit: 0.8, ok: false, detail: '最高 90%', shots: [0] }] };
    let n = 0;
    const deep = sb([split(0, 4, photo('broll/b.jpg', 0.65)), full(4, 8)]);
    const res = await runQaFilm({ ...ctx, measure: async () => (n++ === 0 ? bad : ok) }, { video: 'out.mp4', storyboard: sb([{ start: 0, end: 4, layout: 'split', card: title('标题') }, full(4, 8)]) }, [],
      async () => ({ video: 'out.mp4', storyboard: deep }), complete);
    expect(res.film?.unfixed).toContain('第 1 镜底图压暗 65%（超过 50%），不计入摄影级画面覆盖');
  });
});
