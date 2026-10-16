// 整片自检：抽帧度量（静止段、平坦块空白率、首帧）、分镜度量（模板多样性、摄影级画面覆盖、素材复用、音效重复、铺图卡可读性）与局部重做
import { describe, expect, it } from 'vitest';
import { analyzeGray, blankSpans, GRID, staticSpans, type FrameSeries } from '../src/qa/film-frames.js';
import {
  blankMetric, coverageMetric, diversityMetric, filmReport, firstFrameMetric, LIMITS, photoSeconds, readabilityMetric, reuseMetric, sfxMetric, staticLimit, staticMetric, templateSeconds,
  type FilmMetric, type FilmReport,
} from '../src/qa/film.js';
import { planRedo, syncBeats } from '../src/qa/film-redo.js';
import { measureFilm } from '../src/qa/film-measure.js';
import { FLOAT_MIN_PX, FLOAT_SCALE } from '../render/templates/parts.js';
import { chipLabelPx, chipPillPx, chipsZoom } from '../render/templates/Chips.js';
import { cellCols, cellPx, cellWidth, headerSide } from '../render/templates/BigNumber.js';
import { subtitlePx } from '../render/templates/Title.js';
import { writeAssetMeta } from '../src/broll/credit-store.js';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { textContrast } from '../src/qa/readability.js';
import { runQaFilm } from '../src/pipeline/qa-step.js';
import { cardLead } from '../src/compose/card-carry.js';
import { sfxCues } from '../src/audio/sfx-plan.js';
import type { Broll, CardSpec, Shot, Storyboard } from '../src/storyboard/schema.js';
import type { SfxCue } from '../src/audio/sfx-map.js';

const PX = GRID.width * GRID.height;
/** 纯色帧（平坦、空白率 100%） */
const flat = (v = 200): Uint8Array => new Uint8Array(PX).fill(v);
/** 纹理帧：每个 6×6 块里都有起伏；k 不同则整帧错位（相邻帧差很大） */
const textured = (k = 0): Uint8Array => Uint8Array.from({ length: PX }, (_, i) => ((i % GRID.width) * 37 + Math.floor(i / GRID.width) * 91 + k * 53) % 256);
/** 上半屏平坦、下半屏纹理：上半屏空白率 100% */
const topFlat = (k = 0): Uint8Array => {
  const t = textured(k);
  return Uint8Array.from(t, (v, i) => (Math.floor(i / GRID.width) < GRID.topRows ? 180 : v));
};
/** 上半屏前 n 个块行（每行 6 像素）平坦、其余纹理 */
const topFlatRows = (n: number): Uint8Array => {
  const t = textured(3);
  return Uint8Array.from(t, (v, i) => (Math.floor(i / GRID.width) < n * GRID.block ? 120 : v));
};
const join = (frames: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(frames.length * PX);
  frames.forEach((f, i) => out.set(f, i * PX));
  return out;
};
const times = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

const title = (t: string): CardSpec => ({ template: 'title', props: { title: t } });
const split = (start: number, end: number, card: CardSpec, broll?: Broll): Shot => ({ start, end, layout: 'split', card, ...(broll ? { broll } : {}) });
const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
const photo = (file: string): Broll => ({ file, kind: 'photo', focal: { x: 0.5, y: 0.5 } });
const hook = (extra: Record<string, unknown> = {}): CardSpec => ({ template: 'hook', props: { index: 1, total: 1, headline: '开场钩子', highlight: [], ...extra } }) as CardSpec;
const ev = (rows: number, reveal?: number[]): CardSpec => ({ template: 'evidenceList', props: { title: '清单', rows: times(rows, (i) => ({ badge: '要点', text: `第 ${i + 1} 条` })), ...(reveal ? { reveal } : {}) } }) as CardSpec;
const sb = (shots: Shot[]): Storyboard => ({ shots, bgm: 'chill' });

describe('抽帧度量（审片报告 1.1 节口径：108×192 灰度、每秒 5 帧、上半屏 y<84）', () => {
  it('相邻帧差、6×6 平坦块空白率与第 0 帧', () => {
    const s = analyzeGray(join([flat(), flat(), textured(0), textured(1)]));
    expect(s.count).toBe(4);
    expect(s.diffs).toHaveLength(3);
    expect(s.diffs[0]).toBe(0);
    expect(s.diffs[2]).toBeGreaterThan(25);
    expect(s.blank[0]).toBe(1);
    expect(s.blank[2]).toBe(0);
    expect(s.first).toEqual({ blank: 1, std: 0 });
  });

  it('静止段：相邻帧差 < 0.8 连续超过 3 秒；3 秒以内不算', () => {
    const frames = [...times(20, () => flat()), ...times(10, (k) => textured(k)), ...times(15, () => textured(99)), textured(5)];
    const spans = staticSpans(analyzeGray(join(frames)));
    // 20 帧相同 → 19 个差为 0 → 3.8 秒；15 帧相同 → 2.8 秒（不算）
    expect(spans).toEqual([{ start: 0, end: 3.8 }]);
  });

  it('空白率两种判定并存：1 秒滑动平均（持续空白）与逐帧闪白（连续 ≥ 3 帧 ≥ 90%，前后都不空白）；1–2 帧不算闪白', () => {
    const blip = analyzeGray(join([...times(10, (k) => textured(k)), topFlat(), topFlat(1), ...times(10, (k) => textured(k + 20))]));
    expect(blankSpans(blip, 0.8).spans).toEqual([]);
    expect(blankSpans(blip, 0.8).flashes).toEqual([]);
    const flash = analyzeGray(join([...times(10, (k) => textured(k)), ...times(3, (k) => topFlat(k)), ...times(10, (k) => textured(k + 20))]));
    const f = blankSpans(flash, 0.8);
    expect(f.spans).toEqual([]); // 3 帧在 1 秒窗口里平均只有 60%
    expect(f.flashes).toEqual([{ start: 2, end: 2.6 }]);
    // 开头就空白（前面没有镜头）不算闪白，由首帧指标管
    expect(blankSpans(analyzeGray(join([...times(3, (k) => topFlat(k)), ...times(10, (k) => textured(k))])), 0.8).flashes).toEqual([]);
    const long = analyzeGray(join([...times(10, (k) => textured(k)), ...times(8, (k) => topFlat(k)), ...times(10, (k) => textured(k + 20))]));
    const r = blankSpans(long, 0.8);
    expect(r.peak).toBeCloseTo(1, 5);
    expect(r.spans).toHaveLength(1);
    expect(r.spans[0].start).toBeGreaterThanOrEqual(1.8);
    expect(r.spans[0].end).toBeLessThanOrEqual(3.8);
  });
});

/** 构造帧序列：给出每秒的帧类型，生成每秒 5 帧 */
function series(kinds: ('static' | 'moving' | 'blank')[]): FrameSeries {
  const frames = kinds.flatMap((kind, sec) => times(GRID.fps, (j) => (kind === 'static' ? textured(7) : kind === 'blank' ? topFlat(sec * 5 + j) : textured(sec * 5 + j))));
  return analyzeGray(join(frames));
}

describe('整片指标', () => {
  it('静止合计超过上限判不合格，并定位到占比最大的镜头；上限按片长折算（2 分钟 25 秒，最少 2 秒）', () => {
    // 0–6 秒运动；6–12 秒静止（标题卡）；12–20 运动
    const s = series([...times(6, () => 'moving' as const), ...times(6, () => 'static' as const), ...times(8, () => 'moving' as const)]);
    const shots = [full(0, 6), split(6, 12, title('静止的标题')), full(12, 20)];
    const m = staticMetric(shots, s, 20);
    expect(m.ok).toBe(false);
    expect(m.limit).toBeCloseTo(20 * 25 / 120, 5);
    expect(m.value).toBeGreaterThan(5);
    expect(m.shots).toEqual([1]);
    expect(staticMetric(shots, s, 20, 6).ok).toBe(true);
    expect(staticLimit(120)).toBe(25);
    expect(staticLimit(240)).toBe(50);
    expect(staticLimit(12)).toBeCloseTo(2.5, 5);
    expect(staticLimit(5)).toBe(2);
  });

  it('闪白也判空白率不合格，detail 写出时刻并定位镜头', () => {
    const frames = analyzeGray(join([...times(10, (k) => textured(k)), ...times(3, (k) => topFlat(k)), ...times(10, (k) => textured(k + 20))]));
    const m = blankMetric([full(0, 2.2), split(2.2, 4.6, title('闪'))], frames);
    expect(m.ok).toBe(false);
    expect(m.detail).toMatch(/闪白 2\.0–2\.6 秒/);
    expect(m.shots).toEqual([0, 1]);
  });

  it('空白率任何时刻 ≤ 80%：超标定位到镜头', () => {
    const s = series([...times(4, () => 'moving' as const), ...times(3, () => 'blank' as const), ...times(3, () => 'moving' as const)]);
    const shots = [full(0, 4), split(4, 7, title('空')), full(7, 10)];
    const m = blankMetric(shots, s);
    expect(m.ok).toBe(false);
    expect(m.value).toBeGreaterThan(0.8);
    expect(m.shots).toEqual([1]);
    expect(blankMetric(shots, series(times(10, () => 'moving' as const))).ok).toBe(true);
  });

  it('首帧非空：卡片版式上半屏平坦块 ≤ 80%；人物全屏与素材全屏只排除纯色帧', () => {
    const card = [split(0, 3, title('标题'))];
    const person = [full(0, 3)];
    expect(firstFrameMetric(analyzeGray(join([flat(0), textured(1)])), card).ok).toBe(false);
    expect(firstFrameMetric(analyzeGray(join([topFlatRows(12), textured(1)])), card).ok).toBe(false); // 12/14 ≈ 86%
    expect(firstFrameMetric(analyzeGray(join([topFlatRows(10), textured(1)])), card).ok).toBe(true); // 10/14 ≈ 71%
    expect(firstFrameMetric(analyzeGray(join([textured(0), textured(1)])), card).ok).toBe(true);
    // 上半屏是素净的墙、人在下半屏：人物全屏不算空；纯黑帧仍算空
    expect(firstFrameMetric(analyzeGray(join([topFlat(0), textured(1)])), person).ok).toBe(true);
    expect(firstFrameMetric(analyzeGray(join([flat(0), textured(1)])), person).ok).toBe(false);
    expect(LIMITS.firstFrameMaxBlank).toBe(0.8);
  });

  it('模板多样性：同模板连用 > 2、evidenceList > 20%、2 分钟内呈现模式 < 4 都算问题，并给出模板时长分布', () => {
    const shots = [split(0, 10, ev(2)), split(10, 20, ev(2)), split(20, 30, ev(2)), ...times(9, (i) => full(30 + i * 10, 40 + i * 10))];
    const m = diversityMetric(shots, 120);
    expect(m.ok).toBe(false);
    expect(m.value).toBeGreaterThanOrEqual(2);
    expect(m.detail).toMatch(/连续 3 个镜头/);
    expect(m.detail).toMatch(/evidenceList 占 25%/);
    expect(templateSeconds(shots)).toEqual([{ template: 'evidenceList', seconds: 30 }]);
  });

  it('摄影级画面覆盖：素材铺满、分屏铺图、带图的钩子与图片卡计入；截图卡与人物不算', () => {
    const shots: Shot[] = [
      split(0, 3, hook({ image: 'broll/h.jpg' })),
      { start: 3, end: 5, layout: 'broll', broll: photo('broll/a.jpg') },
      split(5, 8, title('标题'), photo('broll/b.jpg')),
      split(8, 10, { template: 'browser', props: { url: 'example.com', image: 'broll/s.png' } }),
      full(10, 20),
    ];
    expect(photoSeconds(shots)).toBe(8);
    const m = coverageMetric(shots, 20);
    expect(m.value).toBeCloseTo(0.4, 5);
    expect(m.ok).toBe(true);
    expect(coverageMetric([full(0, 20), { start: 20, end: 22, layout: 'broll', broll: photo('broll/a.jpg') }], 22).ok).toBe(false);
  });

  it('素材复用：同一文件或同一候选 id 用在多个镜头判不合格，指向后出现的镜头', () => {
    const shots: Shot[] = [
      split(0, 3, hook({ image: 'broll/h.jpg' })),
      { start: 3, end: 5, layout: 'broll', broll: photo('broll/a.jpg') },
      split(5, 8, title('标题'), photo('broll/a.jpg')),
      { start: 8, end: 10, layout: 'broll', broll: photo('broll/a-pip.jpg') },
    ];
    const ids: Record<string, string> = { 'broll/a.jpg': 'wikimedia:1', 'broll/a-pip.jpg': 'wikimedia:1', 'broll/h.jpg': 'card:x' };
    const m = reuseMetric(shots, (f) => ids[f]);
    expect(m.ok).toBe(false);
    expect(m.value).toBe(2);
    expect(m.shots).toEqual([2, 3]);
    expect(reuseMetric(shots.slice(0, 2), (f) => ids[f]).ok).toBe(true);
  });

  it('同一音效 ≤ 6 次', () => {
    const cue = (sec: number, sfx: SfxCue['sfx']): SfxCue => ({ sec, sfx, volume: 0.2 });
    expect(sfxMetric(times(6, (i) => cue(i, 'pop'))).ok).toBe(true);
    const bad = sfxMetric([...times(7, (i) => cue(i, 'pop')), cue(9, 'whoosh')]);
    expect(bad.ok).toBe(false);
    expect(bad.value).toBe(7);
    expect(bad.detail).toMatch(/pop/);
  });

  it('铺图卡片可读性：文字对比度 < 4.5 的镜头判不合格', () => {
    const m = readabilityMetric([{ shotIndex: 2, contrast: 3.1, polarity: 'light' }, { shotIndex: 5, contrast: 9, polarity: 'dark' }]);
    expect(m.ok).toBe(false);
    expect(m.value).toBeCloseTo(3.1);
    expect(m.shots).toEqual([2]);
    expect(readabilityMetric([]).ok).toBe(true);
  });

  it('filmReport 汇总：抽帧失败时帧类指标记为跳过、其余照常', () => {
    const shots = [split(0, 3, hook()), full(3, 10)];
    const r = filmReport({ storyboard: sb(shots), durationSec: 10, sfx: [], frameError: 'ffmpeg 失败' });
    expect(r.metrics.map((m) => m.id)).toEqual(['diversity', 'coverage', 'reuse', 'sfx', 'readability']);
    expect(r.skipped[0]).toMatch(/抽帧失败.*ffmpeg 失败/);
    expect(r.ok).toBe(false); // 覆盖率 0 不达标
  });
});

describe('铺图卡片文字对比度（同一帧显示文字与隐去文字两次渲染相减）', () => {
  /** w×h 的 RGB 图：底色 bg，左上 12×12 的方块（模拟一个字）为 fg */
  const img = (w: number, h: number, bg: number[], fg?: number[]): Uint8Array => Uint8Array.from({ length: w * h * 3 }, (_, i) => {
    const p = Math.floor(i / 3);
    const inText = fg && p % w < 12 && Math.floor(p / w) < 12;
    return (inText ? fg : bg)[i % 3];
  });
  it('深字压浅底对比度高、灰字压灰底对比度低；分出深浅极性', () => {
    const hi = textContrast(img(48, 48, [230, 230, 230], [28, 27, 25]), img(48, 48, [230, 230, 230]), 48, 48);
    expect(hi?.contrast).toBeGreaterThan(10);
    expect(hi?.polarity).toBe('dark');
    const lo = textContrast(img(48, 48, [150, 150, 150], [235, 235, 235]), img(48, 48, [150, 150, 150]), 48, 48);
    expect(lo?.contrast).toBeLessThan(4.5);
    expect(lo?.polarity).toBe('light');
  });
  it('两张图一样（没有文字）返回 null', () => {
    expect(textContrast(img(48, 48, [90, 90, 90]), img(48, 48, [90, 90, 90]), 48, 48)).toBeNull();
  });
});

describe('局部重做：按指标定位镜头，只改目标镜头', () => {
  const caps = [
    { start: 0, end: 2.5, text: '今天聊聊怎么剪口播' },
    { start: 2.5, end: 6, text: '第一步把原片丢进去' },
    { start: 6, end: 9.5, text: '第二步检查分镜' },
    { start: 9.5, end: 13, text: '第三步导出成片' },
    { start: 13, end: 20, text: '最后发布' },
  ];
  const base = (): Shot[] => [
    split(0, 3, hook()),
    full(3, 6),
    split(6, 13, title('一张静止很久的标题卡')),
    split(13, 20, ev(3)),
  ];
  const report = (metrics: FilmMetric[], extra: Partial<FilmReport> = {}): FilmReport => ({ ok: false, durationSec: 20, metrics, templates: [], skipped: [], ...extra });
  const metric = (id: FilmMetric['id'], shots: number[], spans?: { start: number; end: number }[]): FilmMetric =>
    ({ id, label: id, value: 1, limit: 0, ok: false, detail: '', shots, ...(spans ? { spans } : {}) });

  it('静止：演进卡没有 reveal 时按字幕铺开逐条出现；其余镜头原样', () => {
    const shots = base();
    const plan = planRedo(sb(shots), report([metric('static', [3], [{ start: 13.5, end: 19.5 }])]), caps, 20);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 3, kind: 'reveal' })]);
    const card = plan.storyboard.shots[3].card as Extract<CardSpec, { template: 'evidenceList' }>;
    expect(card.props.reveal?.length).toBe(3);
    expect(card.props.reveal?.[0]).toBe(0);
    expect(plan.storyboard.shots.slice(0, 3)).toEqual(shots.slice(0, 3));
  });

  it('静止：普通卡片在静止段里按字幕边界拆成两段，后一段紧凑卡改浮层（版式变化，卡片内部动画接着前段、不重放）；其余镜头原样', () => {
    const shots = base();
    const plan = planRedo(sb(shots), report([metric('static', [2], [{ start: 6.5, end: 12.8 }])]), caps, 20);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 2, kind: 'split' })]);
    const out = plan.storyboard.shots;
    expect(out).toHaveLength(5);
    expect(out[2]).toEqual({ ...shots[2], end: 9.5 });
    // 后段延续前段的卡片：内部时钟接着走（前段 3.5 秒 + 前段从人物全屏切进分屏的提前量 0.4 秒），不重放计数、弹入，只做一次浮层入场
    expect(out[3]).toEqual({ ...shots[2], start: 9.5, layout: 'overlay', lead: 3.9 });
    expect(out.slice(0, 2)).toEqual(shots.slice(0, 2));
    expect(out[4]).toEqual(shots[3]);
  });

  it('空白过多：紧凑卡改浮层（人物全屏 + 浮卡）；信息密的卡没有可铺的图时只报告', () => {
    const shots = base();
    const plan = planRedo(sb(shots), report([metric('blank', [2, 3])]), caps, 20);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 2, kind: 'overlay' })]);
    expect(plan.storyboard.shots[2]).toEqual({ ...shots[2], layout: 'overlay' });
    expect(plan.storyboard.shots[3]).toEqual(shots[3]);
    expect(plan.unfixed.join('')).toMatch(/第 4 镜/);
  });

  it('首帧空：第一个镜头不是钩子时改成钩子（没有卡片用第一句字幕，有卡片用卡片标题；本地图形兜底）', () => {
    const titled = planRedo(sb([split(0, 3, title('原来的标题')), ...base().slice(1)]), report([metric('firstFrame', [0])]), caps, 20);
    expect(titled.storyboard.shots[0].card).toMatchObject({ template: 'hook', props: { headline: '原来的标题' } });
    const shots = [full(0, 3), ...base().slice(1)];
    const plan = planRedo(sb(shots), report([metric('firstFrame', [0])]), caps, 20);
    expect(plan.actions[0]).toMatchObject({ shotIndex: 0, kind: 'hook' });
    expect(plan.storyboard.shots[0]).toMatchObject({ start: 0, end: 3, layout: 'split', card: { template: 'hook', props: { headline: '今天聊聊怎么剪口播', index: 1, total: 1 } } });
    expect(plan.storyboard.shots.slice(1)).toEqual(shots.slice(1));
  });

  it('素材复用：后出现的镜头去掉重复素材（全屏插入改回人物全屏、钩子退回本地图形）', () => {
    const shots: Shot[] = [
      split(0, 3, hook({ image: 'broll/h.jpg', mediaLabel: { kind: 'ai', text: 'AI 生成' } })),
      { start: 3, end: 6, layout: 'broll', broll: photo('broll/a.jpg') },
      split(6, 13, hook({ image: 'broll/h.jpg' })),
      { start: 13, end: 20, layout: 'broll', broll: photo('broll/a.jpg') },
    ];
    const plan = planRedo(sb(shots), report([metric('reuse', [2, 3])]), caps, 20);
    expect(plan.actions.map((a) => [a.shotIndex, a.kind])).toEqual([[2, 'dedupe'], [3, 'dedupe']]);
    expect(plan.storyboard.shots[2].card).toEqual(hook());
    expect(plan.storyboard.shots[3]).toEqual(full(13, 20));
    expect(plan.storyboard.shots.slice(0, 2)).toEqual(shots.slice(0, 2));
  });

  it('可读性：先切到铺图变体（预先量过变体的对比度达标），变体仍不达标才取消底图', () => {
    const shots: Shot[] = [split(0, 3, hook(), photo('broll/h.jpg')), full(3, 6), split(6, 13, ev(2), photo('broll/b.jpg')), full(13, 20)];
    const contrasts = [{ shotIndex: 0, contrast: 3.2, polarity: 'light' as const, legible: 6.1 }, { shotIndex: 2, contrast: 3.8, polarity: 'dark' as const, legible: 4.1 }];
    const plan = planRedo(sb(shots), report([metric('readability', [0, 2])], { contrasts }), caps, 20);
    expect(plan.actions.map((a) => [a.shotIndex, a.kind])).toEqual([[0, 'legible'], [2, 'unbacked']]);
    expect(plan.storyboard.shots[0]).toEqual({ ...shots[0], broll: { ...photo('broll/h.jpg'), legible: true } });
    expect(plan.storyboard.shots[2]).toEqual(split(6, 13, ev(2)));
    expect(plan.storyboard.shots[1]).toEqual(shots[1]);
  });

  it('首帧空且第 1 镜超过 4 秒：在字幕边界切开，前段改钩子、后段原样；已有钩子顺延编号', () => {
    const shots = [full(0, 7), split(7, 10, hook()), full(10, 20)];
    const capsLong = [{ start: 0, end: 3, text: '先说结论' }, { start: 3, end: 7, text: '再看原因' }, { start: 7, end: 20, text: '后面' }];
    const plan = planRedo(sb(shots), report([metric('firstFrame', [0])]), capsLong, 20);
    expect(plan.actions[0]).toMatchObject({ shotIndex: 0, kind: 'split' });
    const out = plan.storyboard.shots;
    expect(out).toHaveLength(4);
    expect(out[0]).toMatchObject({ start: 0, end: 3, layout: 'split', card: { template: 'hook', props: { headline: '先说结论', index: 1, total: 2 } } });
    expect(out[1]).toEqual(full(3, 7));
    expect(out[2].card).toMatchObject({ template: 'hook', props: { index: 2, total: 2 } });
    expect(out[3]).toEqual(shots[2]);
  });

  it('同一候选（文件不同）复用：去掉后出现镜头的 B-roll', () => {
    const shots: Shot[] = [{ start: 0, end: 3, layout: 'broll', broll: photo('broll/a.jpg') }, full(3, 6), split(6, 13, title('标题'), photo('broll/a-split.jpg')), full(13, 20)];
    const plan = planRedo(sb(shots), report([metric('reuse', [2])]), caps, 20);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 2, kind: 'dedupe' })]);
    expect(plan.storyboard.shots[2]).toEqual(split(6, 13, title('标题')));
  });

  it('模板单调：套分镜规则修正（连用第 3 张转掉），只动被改的镜头', () => {
    const ev2 = (): CardSpec => ev(2);
    const shots = [split(0, 10, ev2()), split(10, 20, ev2()), split(20, 30, ev2()), ...times(9, (i) => full(30 + i * 10, 40 + i * 10))];
    const plan = planRedo(sb(shots), { ...report([metric('diversity', [])]), durationSec: 120 }, caps, 120);
    expect(plan.actions.length).toBeGreaterThan(0);
    expect(plan.actions.every((a) => a.kind === 'rules')).toBe(true);
    expect(plan.storyboard.shots.length).toBe(shots.length);
    expect(plan.storyboard.shots.slice(3)).toEqual(shots.slice(3));
  });

  it('全部达标时不做任何修改', () => {
    const shots = base();
    const plan = planRedo(sb(shots), report([], { ok: true }), caps, 20);
    expect(plan.actions).toEqual([]);
    expect(plan.storyboard.shots).toEqual(shots);
  });
});

describe('整片自检步骤：度量 → 最多 1 轮局部重做 → 复测，结果写 project.json 与进度事件', () => {
  const caps = [{ start: 0, end: 4, text: '开场' }, { start: 4, end: 10, text: '正文' }];
  const shots = [split(0, 4, hook()), split(4, 10, title('空空的标题'))];
  const bad: FilmReport = { ok: false, durationSec: 10, metrics: [{ id: 'blank', label: '上半屏空白率', value: 0.9, limit: 0.8, ok: false, detail: '最高 90%', shots: [1] }], templates: [], skipped: [] };
  const good: FilmReport = { ...bad, ok: true, metrics: [{ ...bad.metrics[0], ok: true, value: 0.5, shots: [] }] };
  const harness = (reports: FilmReport[], redo = true) => {
    const patches: { step: string; message: string; patch?: Record<string, unknown> }[] = [];
    const rerendered: Storyboard[] = [];
    const queue = [...reports];
    const ctx = { cfg: { ffmpeg: 'ffmpeg' } as never, workDir: '/tmp', redo, measure: async () => queue.shift() as FilmReport };
    const complete = (step: 'qa-film', message: string, patch?: Record<string, unknown>) => { patches.push({ step, message, patch }); return {} as never; };
    const rerender = async (storyboard: Storyboard) => { rerendered.push(storyboard); return { video: 'out.mp4', storyboard }; };
    return { patches, rerendered, run: () => runQaFilm(ctx, { video: 'out.mp4', storyboard: sb(shots) }, caps, rerender, complete) };
  };

  it('不达标 → 只改目标镜头并重渲一次 → 复测；before / actions / after 都落盘', async () => {
    const h = harness([bad, good]);
    const res = await h.run();
    expect(h.rerendered).toHaveLength(1);
    expect(h.rerendered[0].shots[0]).toEqual(shots[0]);
    expect(h.rerendered[0].shots[1].layout).toBe('overlay');
    expect(res.cut.storyboard.shots[1].layout).toBe('overlay');
    const last = h.patches[h.patches.length - 1];
    expect(last.message).toMatch(/局部重做后.*整片自检 1\/1 达标/);
    expect(last.patch?.film).toMatchObject({ before: { ok: false }, actions: [{ shotIndex: 1, kind: 'overlay' }], after: { ok: true } });
    // 重做后的分镜先单独落盘一次（工作台直播据此刷新镜头列表）
    const shotsEvent = h.patches.find((p) => p.patch?.storyboard && !p.patch.film);
    expect(shotsEvent?.message).toMatch(/局部重做后的分镜：2 个镜头/);
  });

  it('重渲失败：撤回重做动作（actions 置空并说明），沿用原成片与原分镜', async () => {
    const patches: { message: string; patch?: Record<string, unknown> }[] = [];
    const ctx = { cfg: { ffmpeg: 'ffmpeg' } as never, workDir: '/tmp', redo: true, measure: async () => bad };
    const res = await runQaFilm(ctx, { video: 'out.mp4', storyboard: sb(shots) }, caps, async () => { throw new Error('渲染炸了'); }, (_s, message, patch) => { patches.push({ message, patch }); return {} as never; });
    expect(res.cut.storyboard.shots).toEqual(shots);
    const last = patches[patches.length - 1];
    expect(last.message).toMatch(/局部重做渲染失败，已撤回.*渲染炸了/);
    expect(last.patch?.film).toMatchObject({ actions: [], before: { ok: false } });
    expect(last.patch?.storyboard).toBeUndefined();
  });

  it('工作台修改版本只检查不重做；全部达标也不重渲', async () => {
    const h = harness([bad], false);
    await h.run();
    expect(h.rerendered).toHaveLength(0);
    expect(h.patches[0].patch?.film).toMatchObject({ before: { ok: false }, actions: [] });
    const g = harness([good]);
    await g.run();
    expect(g.rerendered).toHaveLength(0);
    expect(g.patches[0].message).toMatch(/整片自检 1\/1 达标/);
  });

  it('度量出错不让成片失败，只记一条进度', async () => {
    const patches: string[] = [];
    const ctx = { cfg: { ffmpeg: 'ffmpeg' } as never, workDir: '/tmp', redo: true, measure: async (): Promise<FilmReport> => { throw new Error('抽帧炸了'); } };
    const res = await runQaFilm(ctx, { video: 'out.mp4', storyboard: sb(shots) }, caps, async () => { throw new Error('不应重渲'); }, (_s, m) => { patches.push(m); return {} as never; });
    expect(res.cut.storyboard.shots).toEqual(shots);
    expect(patches[0]).toMatch(/整片自检失败，已跳过.*抽帧炸了/);
  });
});

describe('拆开的静止镜头后段延续卡片（lead）', () => {
  const chips: CardSpec = { template: 'chips', props: { groups: [{ label: '标签', items: [{ text: '一', mark: 'yes' }, { text: '二', mark: 'yes' }, { text: '三', mark: 'no' }] }] } };
  it('cardLead 取镜头给定的 lead；音效只在浮层入场响一次，标签弹入不再重放', () => {
    const head: Shot = { start: 0, end: 4, layout: 'split', card: chips };
    const tail: Shot = { start: 4, end: 8, layout: 'overlay', card: chips, lead: 4 };
    expect(cardLead([head, tail], 1)).toBe(4);
    const cues = sfxCues([head, tail]);
    const inTail = cues.filter((c) => c.sec >= 4 - 0.05);
    const replayed = sfxCues([head, { ...tail, lead: undefined }]).filter((c) => c.sec >= 4 - 0.05);
    expect(inTail.length).toBe(1);
    expect(replayed.length).toBeGreaterThan(1);
  });
});

describe('重做后同步 B-roll 节拍记录', () => {
  it('素材被重做去掉的节拍改为跳过（不再指向分镜里没有的文件），其余原样', () => {
    const beat = { start: 3, end: 6, kind: 'photo', present: 'split', query: [], queryZh: [], mustShow: '', avoid: [], shotSize: 'medium' } as never;
    const records = [
      { ...(beat as object), candidates: 3, status: 'placed', file: 'broll/a.jpg', layout: 'split' },
      { ...(beat as object), candidates: 3, status: 'placed', file: 'broll/b.jpg', layout: 'broll' },
      { ...(beat as object), candidates: 0, status: 'skipped', reason: '没有候选' },
    ] as never[];
    const out = syncBeats(records, sb([{ start: 0, end: 3, layout: 'broll', broll: photo('broll/b.jpg') }, full(3, 10)]));
    expect(out[0]).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/整片自检/) });
    expect(out[0]).not.toHaveProperty('file');
    expect(out[1]).toBe(records[1]);
    expect(out[2]).toBe(records[2]);
  });
});

describe('整片度量读素材记录的目录（工作台：素材在版本目录，记录在 base/broll）', () => {
  it('metaDir 指向记录目录时，同一候选的两个文件判复用；只看版本目录时退化成按文件判断', async () => {
    const base = mkdtempSync(pathJoin(tmpdir(), 'mz-meta-'));
    const version = mkdtempSync(pathJoin(tmpdir(), 'mz-ver-'));
    const meta = (file: string) => writeAssetMeta(base, file, { credit: { file, source: 'wikimedia', page: 'p', license: 'CC0', attributionRequired: false, aiGenerated: false, modified: [], query: '', fetchedAt: '' }, candidateId: 'wikimedia:42', kind: 'photo', focal: { x: 0.5, y: 0.5 } });
    meta('broll/a.jpg');
    meta('broll/a-split.jpg');
    const storyboard = sb([{ start: 0, end: 3, layout: 'broll', broll: photo('broll/a.jpg') }, full(3, 6), split(6, 9, title('标题'), photo('broll/a-split.jpg'))]);
    const opts = { ffmpeg: 'ffmpeg', workDir: version, video: pathJoin(version, 'missing.mp4'), storyboard };
    const withMeta = await measureFilm({ ...opts, metaDir: base });
    expect(withMeta.metrics.find((m) => m.id === 'reuse')).toMatchObject({ ok: false, shots: [2] });
    expect(withMeta.skipped[0]).toMatch(/抽帧失败/);
    const blind = await measureFilm(opts);
    expect(blind.metrics.find((m) => m.id === 'reuse')?.ok).toBe(true);
  }, 60_000);
});

describe('拆出的浮层卡字号下限（浮层整块缩到 0.64，缩放后 ≥ 28px）', () => {
  it('标签卡、数字卡、标题卡在浮层里的每种字号 × 缩放 ≥ 28；纸面上不受影响', () => {
    const groups = [{ label: '交付流程很长的组名', items: [{ text: '需求方案', mark: 'yes' as const }, { text: '开发部署上线验收', mark: 'yes' as const }] }];
    const k = chipsZoom(groups);
    const sizes = [
      chipPillPx('开发部署上线验收', k, FLOAT_MIN_PX), chipLabelPx('交付流程很长的组名', k, FLOAT_MIN_PX),
      headerSide('5', '次以内', '传统驻场允许的修改次数极其有限', FLOAT_MIN_PX).px,
      ...['个位数修改', '严格限制', '线性流程'].map((t) => cellPx(t, cellWidth(cellCols(3, FLOAT_MIN_PX)), FLOAT_MIN_PX)),
      subtitlePx('按需求交付 vs 定义问题、验证结果', FLOAT_MIN_PX),
    ];
    for (const px of sizes) expect(px * FLOAT_SCALE).toBeGreaterThanOrEqual(28);
    expect(headerSide('5', '次以内', '传统驻场允许的修改次数极其有限', FLOAT_MIN_PX).stacked).toBe(true);
    expect(cellCols(12, FLOAT_MIN_PX)).toBe(3);
    // 纸面（下限 0）维持原排法
    expect(cellCols(12, 0)).toBe(6);
    expect(cellPx('个位数修改', cellWidth(4), 0)).toBeLessThan(FLOAT_MIN_PX);
  });
});
