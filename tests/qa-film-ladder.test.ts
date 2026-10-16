// 整片自检不撤付费底图：对比度不够时按 铺图变体 → 压暗加深 → 换文字位置 → 最后才撤图 的顺序处理；撤图后复检覆盖率并如实写进 film.unfixed
import { describe, expect, it } from 'vitest';
import { boostMotion, planRedo } from '../src/qa/film-redo.js';
import { kenBurnsRects } from '../src/compose/layout.js';
import { LEGIBLE_LADDER, ladderSteps } from '../src/qa/readability.js';
import { runQaFilm } from '../src/pipeline/qa-step.js';
import type { FilmMetric, FilmReport } from '../src/qa/film.js';
import type { Broll, CardSpec, Shot, Storyboard } from '../src/storyboard/schema.js';
import { BrollSchema } from '../src/storyboard/schema.js';

const photo = (file: string, extra: Partial<Broll> = {}): Broll => ({ file, kind: 'photo', focal: { x: 0.5, y: 0.5 }, ...extra });
const hook: CardSpec = { template: 'hook', props: { index: 1, total: 1, headline: '三个提高效率的小习惯', highlight: [] } };
const title: CardSpec = { template: 'title', props: { title: '习惯一' } };
const sb = (shots: Shot[]): Storyboard => ({ shots, bgm: 'chill' });
const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
const metric = (id: FilmMetric['id'], ok: boolean, shots: number[] = [], detail = ''): FilmMetric => ({ id, label: id === 'coverage' ? '摄影级画面覆盖' : '铺图卡片可读性', value: 0, limit: 0, ok, detail, shots });
const report = (metrics: FilmMetric[], extra: Partial<FilmReport> = {}): FilmReport => ({ ok: metrics.every((m) => m.ok), durationSec: 12, metrics, templates: [], skipped: [], ...extra });

describe('可读性台阶', () => {
  it('台阶顺序：铺图变体 → 压暗加深（由浅到深）→ 换文字位置，且逐级只加不减', () => {
    expect(LEGIBLE_LADDER[0]).toEqual({ legible: true });
    const shades = LEGIBLE_LADDER.map((t) => t.shade ?? 0);
    expect(shades).toEqual([...shades].sort((a, b) => a - b));
    const firstTop = LEGIBLE_LADDER.findIndex((t) => t.textTop);
    expect(firstTop).toBeGreaterThan(1);
    expect(LEGIBLE_LADDER.slice(0, firstTop).every((t) => (t.shade ?? 0) > 0 || t.legible)).toBe(true);
    expect(LEGIBLE_LADDER.slice(firstTop).every((t) => t.textTop)).toBe(true);
  });

  it('已经是铺图变体、已压暗的镜头不重复试已有台阶', () => {
    const steps = ladderSteps(photo('a.jpg', { legible: true, shade: 0.3 }));
    expect(steps.every((t) => (t.shade ?? 0) > 0.3 || t.textTop)).toBe(true);
    expect(steps.length).toBeGreaterThan(0);
  });

  it('素材 schema 保留 shade 与 textTop，并限制范围', () => {
    expect(BrollSchema.parse(photo('a.jpg', { shade: 0.4, textTop: true }))).toMatchObject({ shade: 0.4, textTop: true });
    expect(BrollSchema.safeParse(photo('a.jpg', { shade: 0.95 })).success).toBe(false);
  });
});

describe('局部重做：对比度不够时撤图是最后一步', () => {
  const shots: Shot[] = [{ start: 0, end: 4, layout: 'split', card: hook, broll: photo('broll/h.jpg') }, full(4, 8), { start: 8, end: 12, layout: 'split', card: title, broll: photo('broll/t.jpg') }];
  const run = (contrasts: Record<string, unknown>[]) => planRedo(sb(shots), report([metric('readability', false, [0, 2])], { contrasts: contrasts as never }), [], 12);

  it('铺图变体不够、压暗加深够：保留底图，写上压暗量', () => {
    const plan = run([{ shotIndex: 0, contrast: 3.9, polarity: 'light', legible: 3.8, fix: { tweak: { legible: true, shade: 0.45 }, contrast: 5.2 } }]);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 0, kind: 'legible' })]);
    expect(plan.actions[0].detail).toMatch(/压暗/);
    expect(plan.storyboard.shots[0].broll).toEqual(boostMotion(photo('broll/h.jpg', { legible: true, shade: 0.45 })));
  });

  it('压暗也不够、换文字位置够：底图保留，文字挪到上方', () => {
    const plan = run([{ shotIndex: 0, contrast: 3.9, polarity: 'light', legible: 3.8, fix: { tweak: { legible: true, shade: 0.45, textTop: true }, contrast: 4.8 } }]);
    expect(plan.actions[0].detail).toMatch(/文字.*上方/);
    expect(plan.storyboard.shots[0].broll).toEqual(boostMotion(photo('broll/h.jpg', { legible: true, shade: 0.45, textTop: true })));
    expect(plan.storyboard.shots[0].card).toEqual(hook);
  });

  it('所有台阶都试过仍不达标才撤图，说明已经试过哪些办法', () => {
    const plan = run([{ shotIndex: 0, contrast: 3.9, polarity: 'light', legible: 3.8, ladderBest: 4.1 }]);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 0, kind: 'unbacked' })]);
    expect(plan.actions[0].detail).toMatch(/铺图变体.*压暗.*文字位置.*4\.1.*最后.*取消底图/);
    expect(plan.storyboard.shots[0].broll).toBeUndefined();
    expect(plan.storyboard.shots[2]).toEqual(shots[2]);
  });

  it('只有铺图变体的量值（旧数据）达标：仍切变体，不撤图', () => {
    const plan = run([{ shotIndex: 0, contrast: 3.2, polarity: 'light', legible: 6.1 }]);
    expect(plan.actions[0].kind).toBe('legible');
    expect(plan.storyboard.shots[0].broll).toEqual(boostMotion(photo('broll/h.jpg', { legible: true })));
  });
});

describe('压暗后底图推近加大，免得上半屏被判静止', () => {
  const zoomOf = (b: Broll): number => { const kb = b.kenBurns ?? kenBurnsRects(b.focal); return kb.from.w / kb.to.w - 1; };

  it('静图：压得越深推得越多，到上限为止；终点仍在画内、裁框仍是正方形', () => {
    const levels = [undefined, 0.25, 0.45, 0.65].map((shade) => boostMotion(photo('a.jpg', { legible: true, ...(shade ? { shade } : {}) })));
    const zooms = levels.map(zoomOf);
    expect(zooms).toEqual([...zooms].sort((a, b) => a - b));
    expect(zooms[0]).toBeGreaterThan(zoomOf(photo('a.jpg')));
    expect(zooms[3]).toBeLessThanOrEqual(0.5 + 1e-9);
    for (const b of levels) {
      const to = b.kenBurns?.to;
      expect(to && to.x >= 0 && to.y >= 0 && to.x + to.w <= 1 + 1e-9 && to.y + to.h <= 1 + 1e-9 && to.w === to.h).toBe(true);
    }
  });

  it('视频素材自己在动，不改；已经推得更猛的不削弱', () => {
    const video: Broll = { file: 'a.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 }, durationSec: 4 };
    expect(boostMotion(video)).toBe(video);
    const strong = photo('a.jpg', { legible: true, kenBurns: { from: { x: 0, y: 0, w: 0.9, h: 0.9 }, to: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } } });
    expect(boostMotion(strong)).toBe(strong);
  });

  it('局部重做换铺图变体时同步加大推近：钩子底图不再因为变体而静止', () => {
    const hookShot: Shot = { start: 0, end: 4, layout: 'split', card: hook, broll: photo('broll/h.jpg') };
    const plan = planRedo(sb([hookShot, full(4, 8)]), report([metric('readability', false, [0])], { contrasts: [{ shotIndex: 0, contrast: 3.9, polarity: 'light', legible: 5.1 }] as never }), [], 8);
    const out = plan.storyboard.shots[0].broll as Broll;
    expect(out.legible).toBe(true);
    expect(zoomOf(out)).toBeGreaterThan(zoomOf(photo('broll/h.jpg')));
  });
});

describe('撤图后复检覆盖率，写进 film.unfixed 与进度消息', () => {
  const shots: Shot[] = [{ start: 0, end: 4, layout: 'split', card: hook, broll: photo('broll/h.jpg') }, full(4, 12)];
  const bad = report([metric('readability', false, [0]), metric('coverage', true)], { contrasts: [{ shotIndex: 0, contrast: 3.9, polarity: 'light', legible: 3.8, ladderBest: 4.0 }] as never });
  const after = report([metric('readability', true), metric('coverage', false, [], '2.3 / 12.1 秒（19%，至少 25%）')]);

  const harness = (reports: FilmReport[]) => {
    const calls: { message: string; patch?: Record<string, unknown> }[] = [];
    const queue = [...reports];
    const ctx = { cfg: { ffmpeg: 'ffmpeg' } as never, workDir: '/tmp', redo: true, measure: async () => queue.shift() as FilmReport };
    const rerender = async (storyboard: Storyboard) => ({ video: 'out.mp4', storyboard });
    const complete = (_s: 'qa-film', message: string, patch?: Record<string, unknown>) => { calls.push({ message, patch }); return {} as never; };
    return { calls, run: () => runQaFilm(ctx, { video: 'out.mp4', storyboard: sb(shots) }, [], rerender, complete) };
  };

  it('撤图让覆盖率掉到线下：unfixed 如实写出覆盖率，进度消息也带上', async () => {
    const h = harness([bad, after]);
    const res = await h.run();
    expect(res.film?.actions).toEqual([expect.objectContaining({ kind: 'unbacked' })]);
    expect(res.film?.unfixed.join('\n')).toMatch(/撤图后.*摄影级画面覆盖.*19%/);
    const last = h.calls[h.calls.length - 1];
    expect(last.message).toMatch(/撤图后.*摄影级画面覆盖.*19%/);
    expect((last.patch?.film as { unfixed: string[] }).unfixed).toEqual(res.film?.unfixed);
  });

  it('重做后全部达标：unfixed 为空', async () => {
    const h = harness([bad, report([metric('readability', true), metric('coverage', true)])]);
    const res = await h.run();
    expect(res.film?.unfixed).toEqual([]);
  });

  it('只检查不重做（修改版本）：不达标的项也写进 unfixed，不留空', async () => {
    const calls: Record<string, unknown>[] = [];
    const ctx = { cfg: { ffmpeg: 'ffmpeg' } as never, workDir: '/tmp', redo: false, measure: async () => bad };
    const res = await runQaFilm(ctx, { video: 'out.mp4', storyboard: sb(shots) }, [], async () => { throw new Error('不应重渲'); }, (_s, _m, patch) => { calls.push(patch ?? {}); return {} as never; });
    expect(res.film?.actions).toEqual([]);
    expect(res.film?.unfixed.join('\n')).toMatch(/铺图卡片可读性/);
  });
});
