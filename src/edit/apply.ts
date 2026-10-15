import type { Mood } from '../assets/catalog.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { TimedCaption } from '../captions/lines.js';
import type { CoverStyleId } from '../cover/styles.js';
import type { EditPlan as CutPlan, PlanOptions, TimeRange } from '../cut/plan.js';
import type { AudioOptions } from '../pipeline/audio-step.js';
import { CardSpecSchema, MOODS, type CardSpec, type Shot, type Storyboard, type Visual } from '../storyboard/schema.js';
import type { SpaceSettings } from '../workspace/store.js';
import { VISUAL_SOURCES, type EditOp } from './plan.js';
import { addRange, outputToSource, subtractRange } from './spans.js';

/**
 * 一个版本的全部可修改状态。plan（剪辑方案）由 Task 5 用 buildEditPlan 按 cutOptions、extraCuts、restored 重建，
 * applyOps 只改这些参数，不重算 plan、captions 之外的派生数据。
 */
export interface VersionState {
  settings: SpaceSettings;
  /** 当前剪辑方案（buildEditPlan 的产物）；类型名与模型输出的 EditPlan 冲突，这里用别名 CutPlan */
  plan: CutPlan;
  captions: TimedCaption[];
  storyboard: Storyboard;
  coverStyle: CoverStyleId;
  bgm: AudioOptions;
  /** 剪辑参数：pace 调它 */
  cutOptions: PlanOptions;
  /** 用户额外删掉的片段（原片时间），重建剪辑方案时并入 cutRanges */
  extraCuts: TimeRange[];
  /** 用户要求找回的片段（原片时间），重建时从 cutRanges 里扣掉，并作为语音段补回 */
  restored: TimeRange[];
}

export type Stage = 'cut' | 'matte' | 'captions' | 'storyboard' | 'broll' | 'compose';
const ALL_STAGES: Stage[] = ['cut', 'matte', 'captions', 'storyboard', 'broll', 'compose'];

/** 卡片里含尚未取到素材的 visual（没有现成的 image/video）时，需要重跑 broll */
function needsBroll(card: CardSpec): boolean {
  const p = card.props as { visual?: unknown; image?: string; video?: string };
  return p.visual !== undefined && !p.image && !p.video;
}

function stagesOf(op: EditOp): Stage[] {
  switch (op.type) {
    case 'setBackground': return ['matte', 'compose'];
    case 'setCoverStyle': return [];
    case 'regenerateVisual': return ['broll', 'compose'];
    case 'replaceCard': return needsBroll(op.card) ? ['broll', 'compose'] : ['compose'];
    case 'pace':
    case 'removeSpan':
    case 'restoreSpan': return ALL_STAGES;
    default: return ['compose'];
  }
}

/** 这批操作需要重跑的阶段；setCoverStyle 只重做封面，不属于任何阶段 */
export function stagesFor(ops: EditOp[]): Set<Stage> {
  return new Set(ops.flatMap(stagesOf));
}

/** pace 每次的调整量与上下限 */
const PACE_STEP = { pad: 0.04, mergeGap: 0.1 };
const PACE_RANGE = { pad: [0.04, 0.3], mergeGap: [0.1, 0.8] } as const;
const round = (n: number): number => Math.round(n * 1000) / 1000;
const clamp = (v: number, [lo, hi]: readonly [number, number]): number => Math.min(hi, Math.max(lo, v));

function pace(opts: PlanOptions, direction: 'tighter' | 'looser'): PlanOptions {
  const sign = direction === 'tighter' ? -1 : 1;
  return {
    ...opts,
    pad: round(clamp(opts.pad + sign * PACE_STEP.pad, PACE_RANGE.pad)),
    mergeGap: round(clamp(opts.mergeGap + sign * PACE_STEP.mergeGap, PACE_RANGE.mergeGap)),
  };
}

function shotAt(state: VersionState, i: number): Shot {
  const shot = state.storyboard.shots[i];
  if (!shot) throw new Error(`没有第 ${i} 个镜头（共 ${state.storyboard.shots.length} 个）`);
  return shot;
}

function withShot(state: VersionState, i: number, next: Shot): VersionState {
  return { ...state, storyboard: { ...state.storyboard, shots: state.storyboard.shots.map((s, j) => (j === i ? next : s)) } };
}

function replaceCard(state: VersionState, i: number, card: CardSpec): VersionState {
  const parsed = CardSpecSchema.safeParse(card);
  if (!parsed.success) throw new Error(`新卡片不符合模板要求：${parsed.error.issues[0].path.join('.') || card.template}`);
  const shot = shotAt(state, i);
  // 带卡片的镜头必须是分屏（cta 例外，固定全屏）
  const layout = parsed.data.template === 'cta' ? 'full' : 'split';
  return withShot(state, i, { ...shot, card: parsed.data, layout });
}

function setLayout(state: VersionState, i: number, layout: 'split' | 'full'): VersionState {
  const shot = shotAt(state, i);
  if (layout === 'split') {
    if (!shot.card) throw new Error(`第 ${i} 个镜头没有卡片，不能改成分屏`);
    return withShot(state, i, { ...shot, layout });
  }
  // 全屏镜头只有 cta 能显示卡片，其余卡片一并去掉
  const { card, ...rest } = shot;
  return withShot(state, i, card?.template === 'cta' ? { ...shot, layout } : { ...rest, layout });
}

function regenerateVisual(state: VersionState, i: number, visual: Visual): VersionState {
  const card = shotAt(state, i).card;
  if (!card) throw new Error(`第 ${i} 个镜头没有卡片，无法换素材`);
  if (!VISUAL_SOURCES[card.template]?.includes(visual.source)) throw new Error(`「${card.template}」卡片不支持这种素材（${visual.source}）`);
  const props = Object.fromEntries(Object.entries(card.props).filter(([k]) => k !== 'image' && k !== 'video'));
  return replaceCard(state, i, { template: card.template, props: { ...props, visual } } as CardSpec);
}

function editCaption(state: VersionState, index: number, text: string): VersionState {
  if (index >= state.captions.length) throw new Error(`没有第 ${index} 句字幕（共 ${state.captions.length} 句）`);
  return { ...state, captions: state.captions.map((c, j) => (j === index ? { ...c, text } : c)) };
}

function setBgm(state: VersionState, bgm: string): VersionState {
  // 情绪不是曲目：改分镜里的 bgm 情绪，选曲回到自动
  if ((MOODS as readonly string[]).includes(bgm)) return { ...state, bgm: { bgm: 'auto' }, storyboard: { ...state.storyboard, bgm: bgm as Mood } };
  return { ...state, bgm: { bgm } };
}

function removeSpan(state: VersionState, from: number, to: number): VersionState {
  if (!(to > from) || from >= state.plan.outputDurationSec) throw new Error(`删除的时间范围不在成片内（成片 ${state.plan.outputDurationSec} 秒）`);
  const pieces = outputToSource(state.plan.keep, from, to);
  return {
    ...state,
    extraCuts: pieces.reduce(addRange, state.extraCuts),
    restored: pieces.reduce(subtractRange, state.restored),
  };
}

function restoreSpan(state: VersionState, from: number, to: number): VersionState {
  if (!(to > from) || from >= state.plan.sourceDurationSec) throw new Error(`找回的时间范围不在原片内（原片 ${state.plan.sourceDurationSec} 秒）`);
  const span = { start: from, end: Math.min(to, state.plan.sourceDurationSec) };
  return { ...state, extraCuts: subtractRange(state.extraCuts, span), restored: addRange(state.restored, span) };
}

function applyOne(state: VersionState, op: EditOp): VersionState {
  switch (op.type) {
    case 'setBackground': return { ...state, settings: { ...state.settings, background: op.spec } };
    case 'setCaptionStyle': return { ...state, settings: { ...state.settings, captionStyle: op.id as CaptionStyleId } };
    case 'setCoverStyle': return { ...state, coverStyle: op.id as CoverStyleId };
    case 'setBgm': return setBgm(state, op.bgm);
    case 'replaceCard': return replaceCard(state, op.shotIndex, op.card);
    case 'setLayout': return setLayout(state, op.shotIndex, op.layout);
    case 'regenerateVisual': return regenerateVisual(state, op.shotIndex, op.visual);
    case 'editCaption': return editCaption(state, op.index, op.text);
    case 'pace': return { ...state, cutOptions: pace(state.cutOptions, op.direction) };
    case 'removeSpan': return removeSpan(state, op.fromSec, op.toSec);
    case 'restoreSpan': return restoreSpan(state, op.fromSec, op.toSec);
  }
}

/**
 * 把操作依次应用到版本状态，返回新状态（纯函数，不改入参）。
 * removeSpan 的时间始终按应用前的 state.plan 换算，同一批里多个 removeSpan 互不影响；操作与状态对不上时抛中文错误。
 */
export function applyOps(state: VersionState, ops: EditOp[]): VersionState {
  return ops.reduce(applyOne, state);
}
