/**
 * 整片自检（审片报告第 6 节第 11 项，指标即第 1.1 节的度量）：基于分镜数据与成片抽帧给出整片指标，不达标的指标定位到镜头，
 * 供局部重做（film-redo.ts）使用。本文件只做纯计算；抽帧、渲染静帧等 IO 在 film-measure.ts
 */
import { sfxStats, type SfxCue } from '../audio/sfx-map.js';
import { visualLayout } from '../compose/layout.js';
import { storyboardIssues } from '../storyboard/rules.js';
import type { Shot, Storyboard } from '../storyboard/schema.js';
import { blankSpans, staticSpans, type FrameSeries, type Span } from './film-frames.js';
import { MIN_CONTRAST, type ShotContrast } from './readability.js';

/**
 * 阈值：静止 > 3 秒合计按片长折算（每 2 分钟 25 秒，最少 2 秒）；任何时刻上半屏空白率 ≤ 80%（1 秒平均）且没有闪白；
 * 首帧：卡片版式上半屏平坦块 ≤ 80%，人物与素材全屏只排除纯色帧（整帧标准差 < 8）；摄影级画面 ≥ 25% 片长；同一音效 ≤ 6 次；铺图卡片文字对比度 ≥ 4.5
 */
export const LIMITS = { staticSec: 25, staticPerSec: 120, staticMinSec: 2, maxBlank: 0.8, firstFrameMaxBlank: 0.8, firstFrameMinStd: 8, minCoverage: 0.25, maxSfx: 6, minContrast: MIN_CONTRAST } as const;

/** 静止合计上限：按片长折算（2 分钟 25 秒），最少 2 秒 */
export const staticLimit = (durationSec: number): number => Math.max(LIMITS.staticMinSec, (LIMITS.staticSec * durationSec) / LIMITS.staticPerSec);

export type FilmMetricId = 'static' | 'blank' | 'firstFrame' | 'diversity' | 'coverage' | 'reuse' | 'sfx' | 'readability';
/** 一项整片指标：value 与 limit 同单位；shots 为不达标时定位到的镜头序号；spans 为对应的成片时间区间（抽帧类指标） */
export interface FilmMetric { id: FilmMetricId; label: string; value: number; limit: number; ok: boolean; detail: string; shots: number[]; spans?: Span[] }
/** templates：各模板合计时长（秒，从多到少）；contrasts：铺图卡片逐镜的文字对比度（局部重做按深浅极性选压暗或取消底图） */
export interface FilmReport { ok: boolean; durationSec: number; metrics: FilmMetric[]; templates: { template: string; seconds: number }[]; skipped: string[]; contrasts?: ShotContrast[] }

const fmt = (n: number): string => n.toFixed(1);
const pct = (n: number): string => `${Math.round(n * 100)}%`;
const overlap = (s: Shot, span: Span): number => Math.max(0, Math.min(s.end, span.end) - Math.max(s.start, span.start));
const uniq = (xs: number[]): number[] => [...new Set(xs)].sort((a, b) => a - b);

/** 区间里占时最长的镜头 */
export function dominantShot(shots: Shot[], span: Span): number {
  return shots.reduce((best, s, i) => (overlap(s, span) > overlap(shots[best], span) ? i : best), 0);
}

/** 静止 > 3 秒的段合计：上限按片长折算（见 staticLimit） */
export function staticMetric(shots: Shot[], frames: FrameSeries, durationSec: number, limit = staticLimit(durationSec)): FilmMetric {
  const spans = staticSpans(frames);
  const total = spans.reduce((n, s) => n + s.end - s.start, 0);
  const longest = Math.max(0, ...spans.map((s) => s.end - s.start));
  const ok = total <= limit + 1e-9;
  return {
    id: 'static', label: '上半屏静止', value: Math.round(total * 10) / 10, limit, ok, spans,
    detail: `静止 > 3 秒 ${spans.length} 段，合计 ${fmt(total)} 秒（上限 ${fmt(limit)} 秒），最长 ${fmt(longest)} 秒`,
    shots: ok ? [] : uniq(spans.map((s) => dominantShot(shots, s))),
  };
}

const spanText = (spans: Span[]): string => spans.map((s) => `${fmt(s.start)}–${fmt(s.end)} 秒`).join('、');
const shotsOver = (shots: Shot[], spans: Span[]): number[] => uniq(spans.flatMap((sp) => shots.flatMap((s, i) => (overlap(s, sp) > 0.2 - 1e-9 ? [i] : []))));

/** 任何时刻上半屏空白率（平坦块口径）：1 秒平均 ≤ 80%，且没有闪白（连续 ≥ 3 帧 ≥ 90%） */
export function blankMetric(shots: Shot[], frames: FrameSeries): FilmMetric {
  const r = blankSpans(frames, LIMITS.maxBlank);
  const ok = r.spans.length === 0 && r.flashes.length === 0;
  const where = [r.spans.length > 0 ? `；持续空白 ${spanText(r.spans)}` : '', r.flashes.length > 0 ? `；闪白 ${spanText(r.flashes)}` : ''].join('');
  return {
    id: 'blank', label: '上半屏空白率', value: r.peak, limit: LIMITS.maxBlank, ok, spans: [...r.spans, ...r.flashes],
    detail: `最高 ${pct(r.peak)}（1 秒平均，${fmt(r.peakAt)} 秒，上限 ${pct(LIMITS.maxBlank)}）${where}`,
    shots: ok ? [] : shotsOver(shots, [...r.spans, ...r.flashes]),
  };
}

/** 首帧非空：卡片版式（分屏、浮层）看上半屏是否几乎全平坦；人物全屏、素材全屏只排除纯色帧（上半屏是素净的墙不算空） */
export function firstFrameMetric(frames: FrameSeries, shots: Shot[]): FilmMetric {
  const { blank, std } = frames.first;
  const layout = shots[0] ? visualLayout(shots[0]) : 'split';
  const byTop = layout === 'split' || layout === 'overlay';
  const ok = (!byTop || blank <= LIMITS.firstFrameMaxBlank + 1e-9) && std >= LIMITS.firstFrameMinStd;
  return {
    id: 'firstFrame', label: '首帧非空', value: Math.round(blank * 1000) / 1000, limit: LIMITS.firstFrameMaxBlank, ok, shots: ok ? [] : [0],
    detail: `第 0 帧上半屏空白率 ${pct(blank)}${byTop ? '' : '（人物或素材全屏，只查纯色）'}，整帧标准差 ${fmt(std)}${std < LIMITS.firstFrameMinStd ? '（接近纯色）' : ''}`,
  };
}

/** 各模板合计时长（秒），从多到少 */
export function templateSeconds(shots: Shot[]): { template: string; seconds: number }[] {
  const sums = shots.reduce<Record<string, number>>((acc, s) => (s.card ? { ...acc, [s.card.template]: (acc[s.card.template] ?? 0) + s.end - s.start } : acc), {});
  return Object.entries(sums).map(([template, seconds]) => ({ template, seconds: Math.round(seconds * 10) / 10 })).sort((a, b) => b.seconds - a.seconds);
}

/** 模板分布与多样性（Task 6 的规则在编排后的分镜上复检）：问题条数为 0 才达标 */
export function diversityMetric(shots: Shot[], durationSec: number): FilmMetric {
  const issues = storyboardIssues(shots, durationSec);
  const dist = templateSeconds(shots).map((t) => `${t.template} ${pct(t.seconds / durationSec)}`).join('、');
  return {
    id: 'diversity', label: '模板多样性', value: issues.length, limit: 0, ok: issues.length === 0, shots: [],
    detail: `${issues.length === 0 ? '通过' : issues.join('；')}${dist ? `（模板时长：${dist}）` : ''}`,
  };
}

/** 一个镜头里摄影级画面（实拍、照片、生成图）占上半屏或全屏的秒数：素材铺满、画中画底、分屏铺图、浮层素材小窗、带图或视频的钩子与图片卡 */
function photoShot(s: Shot): boolean {
  const layout = visualLayout(s);
  if (s.broll && (layout === 'broll' || layout === 'pip' || layout === 'split' || (layout === 'overlay' && !s.card))) return true;
  const p = (s.card?.props ?? {}) as { image?: string; video?: string };
  return (s.card?.template === 'hook' || s.card?.template === 'photo') && layout !== 'full' && Boolean(p.image || p.video);
}

export const photoSeconds = (shots: Shot[]): number => shots.reduce((n, s) => n + (photoShot(s) ? s.end - s.start : 0), 0);

/** B-roll 覆盖率：摄影级画面占片长 ≥ 25% */
export function coverageMetric(shots: Shot[], durationSec: number): FilmMetric {
  const seconds = photoSeconds(shots);
  const ratio = durationSec > 0 ? seconds / durationSec : 0;
  const ok = ratio >= LIMITS.minCoverage - 1e-9;
  return { id: 'coverage', label: '摄影级画面覆盖', value: Math.round(ratio * 1000) / 1000, limit: LIMITS.minCoverage, ok, shots: [], detail: `${fmt(seconds)} / ${fmt(durationSec)} 秒（${pct(ratio)}，至少 ${pct(LIMITS.minCoverage)}）` };
}

/** 镜头里用到的素材文件：卡片的图或视频、镜头 B-roll */
export function shotFiles(s: Shot): string[] {
  const p = (s.card?.props ?? {}) as { image?: unknown; video?: unknown };
  return [p.image, p.video, s.broll?.file].filter((f): f is string => typeof f === 'string');
}

/** 同一素材复用 0 次：同一文件、或同一来源候选（candidateOf 给出候选 id）出现在第二个镜头起都算一次复用，定位到后出现的镜头 */
export function reuseMetric(shots: Shot[], candidateOf: (file: string) => string | undefined = () => undefined): FilmMetric {
  const keyOf = (f: string): string => candidateOf(f) ?? `file:${f}`;
  const seen = new Set<string>();
  const hits = shots.flatMap((s, i) => {
    const keys = [...new Set(shotFiles(s).map(keyOf))];
    const dup = keys.filter((k) => seen.has(k));
    keys.forEach((k) => seen.add(k));
    return dup.map((k) => ({ shot: i, key: k }));
  });
  return {
    id: 'reuse', label: '素材复用', value: hits.length, limit: 0, ok: hits.length === 0, shots: uniq(hits.map((h) => h.shot)),
    detail: hits.length === 0 ? '没有复用' : hits.map((h) => `第 ${h.shot + 1} 镜复用 ${h.key.replace(/^file:/, '')}`).join('；'),
  };
}

/** 同一音效（含变体，各算各的）全片 ≤ 6 次 */
export function sfxMetric(cues: SfxCue[]): FilmMetric {
  const stats = sfxStats(cues);
  const over = Object.entries(stats.perSfx).filter(([, n]) => n > LIMITS.maxSfx);
  return {
    id: 'sfx', label: '音效重复', value: stats.maxRepeat, limit: LIMITS.maxSfx, ok: over.length === 0, shots: [],
    detail: over.length === 0 ? `音效 ${cues.length} 个、${stats.kinds} 种，同一音效最多 ${stats.maxRepeat} 次` : `超过 ${LIMITS.maxSfx} 次：${over.map(([id, n]) => `${id} ${n} 次`).join('、')}`,
  };
}

/** 铺图卡片（分屏素材做底、卡片排在图上）的文字对比度 ≥ 4.5 */
export function readabilityMetric(contrasts: ShotContrast[]): FilmMetric {
  const worst = contrasts.reduce<ShotContrast | undefined>((a, c) => (!a || c.contrast < a.contrast ? c : a), undefined);
  const bad = contrasts.filter((c) => c.contrast < LIMITS.minContrast);
  return {
    id: 'readability', label: '铺图卡片可读性', value: worst ? Math.round(worst.contrast * 10) / 10 : 21, limit: LIMITS.minContrast, ok: bad.length === 0, shots: bad.map((c) => c.shotIndex),
    detail: worst ? `${contrasts.length} 张铺图卡片，最低对比度 ${worst.contrast.toFixed(1)}（第 ${worst.shotIndex + 1} 镜，至少 ${LIMITS.minContrast}）` : '没有铺图的卡片',
  };
}

export interface FilmInput {
  storyboard: Storyboard;
  /** 口播内容时长（不含最后一句后的留白与品牌片尾） */
  durationSec: number;
  frames?: FrameSeries;
  /** 抽帧失败的原因（帧类指标跳过） */
  frameError?: string;
  sfx: SfxCue[];
  candidateOf?: (file: string) => string | undefined;
  contrasts?: ShotContrast[];
  /** 可读性检查失败的原因 */
  contrastError?: string;
}

/** 汇总全部指标；某类度量失败时该类跳过并写进 skipped */
export function filmReport(i: FilmInput): FilmReport {
  const shots = i.storyboard.shots;
  const framed = i.frames ? [staticMetric(shots, i.frames, i.durationSec), blankMetric(shots, i.frames), firstFrameMetric(i.frames, shots)] : [];
  const metrics = [
    ...framed,
    diversityMetric(shots, i.durationSec),
    coverageMetric(shots, i.durationSec),
    reuseMetric(shots, i.candidateOf),
    sfxMetric(i.sfx),
    ...(i.contrastError ? [] : [readabilityMetric(i.contrasts ?? [])]),
  ];
  const skipped = [
    ...(i.frames ? [] : [`抽帧失败，静止、空白率、首帧未检查：${i.frameError ?? '未知原因'}`]),
    ...(i.contrastError ? [`铺图卡片可读性未检查：${i.contrastError}`] : []),
  ];
  return { ok: metrics.every((m) => m.ok), durationSec: i.durationSec, metrics, templates: templateSeconds(shots), skipped, ...(i.contrasts ? { contrasts: i.contrasts } : {}) };
}

/** 一句话摘要：通过的项数与不达标项 */
export function filmSummary(r: FilmReport): string {
  const bad = r.metrics.filter((m) => !m.ok);
  const head = `整片自检 ${r.metrics.length - bad.length}/${r.metrics.length} 达标`;
  return bad.length === 0 ? `${head}` : `${head}，不达标：${bad.map((m) => `${m.label}（${m.detail}）`).join('；')}`;
}
