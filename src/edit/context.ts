import { loadTracks, type Track } from '../assets/catalog.js';
import { PRESETS } from '../background/presets.js';
import { CAPTION_STYLES } from '../captions/styles.js';
import { COVER_STYLES } from '../cover/styles.js';
import type { TimeRange } from '../cut/plan.js';
import type { CardSpec } from '../storyboard/schema.js';
import type { VersionState } from './apply.js';
import { parseTimeRefs, shotForTime, type TimeRef } from './refs.js';

export interface ShotSummary { index: number; start: number; end: number; layout: 'split' | 'full'; template?: string; title?: string }
export interface CaptionSummary { index: number; start: number; end: number; text: string }
/** 超出成片时长的引用：不解析到镜头（shotIndex 为 -1），上下文里标注后忽略 */
export interface ResolvedRef { sec: number; label?: string; shotIndex: number; captionIndex?: number; outOfRange?: boolean }
interface Named { id: string; name: string }

/** 传给修改模型的当前版本上下文 */
export interface EditContext {
  shots: ShotSummary[];
  captions: CaptionSummary[];
  settings: { background: string; captionStyle: string; coverStyle: string; bgm: string };
  refs: ResolvedRef[];
  presets: Named[];
  captionStyles: Named[];
  coverStyles: Named[];
  tracks: { id: string; title: string; mood: string }[];
  outputDurationSec: number;
  sourceDurationSec: number;
  /** 原片里被剪掉的片段（restoreSpan 用原片时间） */
  cutGaps: TimeRange[];
}

const MIN_GAP_SEC = 0.3;
const MAX_GAPS = 30;
const round = (n: number): number => Math.round(n * 100) / 100;

/** 卡片里最能代表它的一句文字，给模型认卡用 */
function cardTitle(card: CardSpec | undefined): string | undefined {
  if (!card) return undefined;
  const p = card.props as Record<string, unknown>;
  const pick = [p.headline, p.title, p.label, p.url, p.value].find((v) => typeof v === 'string');
  return typeof pick === 'string' ? pick : undefined;
}

/** keep 之外的空隙（原片时间），只取够长的 */
function gapsOf(keep: TimeRange[], sourceDurationSec: number): TimeRange[] {
  const edges = [{ start: 0, end: 0 }, ...keep, { start: sourceDurationSec, end: sourceDurationSec }];
  return edges.slice(1).map((r, i) => ({ start: edges[i].end, end: r.start }))
    .filter((g) => g.end - g.start >= MIN_GAP_SEC)
    .slice(0, MAX_GAPS)
    .map((g) => ({ start: round(g.start), end: round(g.end) }));
}

function resolveRef(r: TimeRef, state: VersionState): ResolvedRef {
  if (r.sec >= state.plan.outputDurationSec) return { ...r, shotIndex: -1, outOfRange: true };
  const captionIndex = state.captions.findIndex((c) => r.sec >= c.start && r.sec < c.end);
  return { ...r, shotIndex: shotForTime(state.storyboard.shots, r.sec), ...(captionIndex >= 0 ? { captionIndex } : {}) };
}

const describeBackground = (bg: VersionState['settings']['background']): string => {
  if (!bg) return '默认';
  return bg.kind === 'preset' ? `预设 ${bg.id}` : bg.kind === 'prompt' ? `一句话「${bg.prompt}」` : '自带图片';
};

/** 由版本状态和用户消息组装上下文；tracks 默认读内置曲库清单 */
export function buildEditContext(state: VersionState, message: string, tracks: Track[] = loadTracks()): EditContext {
  const { shots } = state.storyboard;
  return {
    shots: shots.map((s, index) => ({ index, start: round(s.start), end: round(s.end), layout: s.layout, template: s.card?.template, title: cardTitle(s.card) })),
    captions: state.captions.map((c, index) => ({ index, start: round(c.start), end: round(c.end), text: c.text })),
    settings: { background: describeBackground(state.settings.background), captionStyle: state.settings.captionStyle, coverStyle: state.coverStyle, bgm: state.bgm.bgm },
    refs: parseTimeRefs(message).map((r) => resolveRef(r, state)),
    presets: PRESETS.map((p) => ({ id: p.id, name: p.name })),
    captionStyles: Object.entries(CAPTION_STYLES).map(([id, s]) => ({ id, name: s.name })),
    coverStyles: Object.entries(COVER_STYLES).map(([id, s]) => ({ id, name: s.name })),
    tracks: tracks.map((t) => ({ id: t.id, title: t.title, mood: t.mood })),
    outputDurationSec: state.plan.outputDurationSec,
    sourceDurationSec: state.plan.sourceDurationSec,
    cutGaps: gapsOf(state.plan.keep, state.plan.sourceDurationSec),
  };
}

const list = (items: Named[]): string => items.map((i) => `${i.id}（${i.name}）`).join('、');

function describeRef(r: ResolvedRef): string {
  const head = `@${r.sec} 秒${r.label ? `（${r.label}）` : ''}`;
  if (r.outOfRange) return `${head} 超出成片时长，已忽略`;
  return `${head} → 镜头 #${r.shotIndex}${r.captionIndex === undefined ? '' : `，字幕 #${r.captionIndex}`}`;
}

/** 上下文转成给模型看的文本 */
export function formatContext(ctx: EditContext): string {
  const shots = ctx.shots.map((s) => `#${s.index} [${s.start}-${s.end}] ${s.layout} ${s.template ?? '无卡片'}${s.title ? `「${s.title}」` : ''}`).join('\n');
  const captions = ctx.captions.map((c) => `#${c.index} [${c.start}-${c.end}] ${c.text}`).join('\n');
  const refs = ctx.refs.length === 0 ? '无' : ctx.refs.map(describeRef).join('；');
  const gaps = ctx.cutGaps.length === 0 ? '无' : ctx.cutGaps.map((g) => `${g.start}-${g.end}`).join('、');
  const s = ctx.settings;
  return [
    `成片时长 ${ctx.outputDurationSec} 秒，原片时长 ${ctx.sourceDurationSec} 秒`,
    `当前设置：背景 ${s.background}；字幕样式 ${s.captionStyle}；封面风格 ${s.coverStyle}；配乐 ${s.bgm}`,
    `分镜（序号 [起止秒] 版式 模板「标题」）：\n${shots}`,
    `字幕（序号 [起止秒] 文字）：\n${captions}`,
    `引用解析：${refs}`,
    `已剪掉的片段（原片秒）：${gaps}`,
    `可用背景预设：${list(ctx.presets)}`,
    `可用字幕样式：${list(ctx.captionStyles)}`,
    `可用封面风格：${list(ctx.coverStyles)}`,
    `可用配乐：${ctx.tracks.map((t) => `${t.id}（${t.title}，${t.mood}）`).join('、') || '无'}`,
  ].join('\n');
}
