import type { Mood } from '../assets/catalog.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { TimedCaption } from '../captions/lines.js';
import type { CoverStyleId } from '../cover/styles.js';
import type { EditPlan as CutPlan, PlanOptions, TimeRange } from '../cut/plan.js';
import type { AudioOptions } from '../pipeline/audio-step.js';
import { CardSpecSchema, MOODS, type CardSpec, type Layout, type Shot, type Storyboard, type Visual } from '../storyboard/schema.js';
import type { SpaceSettings } from '../workspace/store.js';
import type { BeatRecord } from '../pipeline/broll-beats.js';
import { captionTooLong, cardHiddenIn, checkCard, layoutBlocker } from './check.js';
import { canonicalize, layoutProblem } from './layout-rules.js';
import { revealToLocal } from '../storyboard/reveal.js';
import { VISUAL_SOURCES, type EditOp } from './ops.js';
import { addRange, outputToSource, subtractRange } from './spans.js';

export { captionsForRestored, droppedCardNotes, remapStoryboard, retimeCaptions } from './retime.js';

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
  /** B-roll 视觉节拍（完整字段与落点）：「换一张 B-roll」按原节拍重做；旧版本没有 */
  brollBeats?: BeatRecord[];
}

export type Stage = 'cut' | 'matte' | 'captions' | 'storyboard' | 'broll' | 'compose';
const RETIME_STAGES: Stage[] = ['cut', 'matte', 'captions', 'storyboard', 'compose'];

/** 卡片里含尚未取到素材的 visual（没有现成的 image/video）时，需要重跑 broll */
function needsBroll(card: CardSpec): boolean {
  const p = card.props as { visual?: unknown; image?: string; video?: string };
  return p.visual !== undefined && !p.image && !p.video;
}

function stagesOf(op: EditOp): Stage[] {
  switch (op.type) {
    case 'setBackground': return ['matte', 'compose'];
    case 'setCoverStyle': return [];
    case 'regenerateVisual':
    case 'replaceBroll': return ['broll', 'compose'];
    case 'replaceCard': return needsBroll(op.card) ? ['broll', 'compose'] : ['compose'];
    // 不重做字幕文字与分镜内容：字幕重新对时、分镜平移（retimeCaptions / remapStoryboard），卡片与 B-roll 保留
    case 'pace':
    case 'removeSpan':
    case 'restoreSpan': return RETIME_STAGES;
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
/** 删除后成片至少留这么长 */
const MIN_OUTPUT_SEC = 1;
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

/** 改完的分镜若比改前多触犯版式规则，整个操作作废 */
function guardLayout(before: VersionState, after: VersionState): VersionState {
  const problem = layoutProblem(before.storyboard, after.storyboard);
  if (problem) throw new Error(problem);
  return after;
}

/** 换卡后的版式：cta 固定全屏；分屏、浮层保持；全屏改分屏（全屏只显示 cta）；全屏插入与画中画里卡片看不见，拒绝并说明 */
function cardLayout(layout: Layout, template: CardSpec['template'], i: number): Layout {
  if (template === 'cta') return 'full';
  const hidden = cardHiddenIn(layout);
  if (hidden) throw new Error(`第 ${i} 个镜头：${hidden}`);
  return layout === 'full' ? 'split' : layout;
}

/** 换卡片；fromModel 时（对话里模型给的新卡）reveal 按目标镜头从成片秒数换算成镜头内秒数，沿用原卡片时不换算 */
function replaceCard(state: VersionState, i: number, card: CardSpec, fromModel = true): VersionState {
  const parsed = CardSpecSchema.safeParse(card);
  if (!parsed.success) throw new Error(`新卡片不符合模板要求：${parsed.error.issues[0].path.join('.') || card.template}`);
  const bad = checkCard(parsed.data);
  if (bad) throw new Error(bad);
  const shot = shotAt(state, i);
  const placed: Shot = { ...shot, card: parsed.data, layout: cardLayout(shot.layout, parsed.data.template, i) };
  return guardLayout(state, withShot(state, i, fromModel ? revealToLocal([placed])[0] : placed));
}

/** 改版式（约束见 layoutBlocker）：分屏、浮层保留卡片；全屏只保留 cta；全屏插入与画中画看不见卡片，一并去掉；素材字段始终保留 */
function setLayout(state: VersionState, i: number, layout: Layout): VersionState {
  const shot = shotAt(state, i);
  const blocked = layoutBlocker(layout, { template: shot.card?.template, broll: shot.broll !== undefined });
  if (blocked) throw new Error(`第 ${i} 个镜头：${blocked}`);
  const keepCard = layout === 'split' || layout === 'overlay' || (layout === 'full' && shot.card?.template === 'cta');
  const { card, ...rest } = shot;
  return guardLayout(state, withShot(state, i, keepCard && card ? { ...shot, layout } : { ...rest, layout }));
}

function regenerateVisual(state: VersionState, i: number, visual: Visual): VersionState {
  const card = shotAt(state, i).card;
  if (!card) throw new Error(`第 ${i} 个镜头没有卡片，无法换素材`);
  if (!VISUAL_SOURCES[card.template]?.includes(visual.source)) throw new Error(`「${card.template}」卡片不支持这种素材（${visual.source}）`);
  const props = Object.fromEntries(Object.entries(card.props).filter(([k]) => k !== 'image' && k !== 'video'));
  return replaceCard(state, i, { template: card.template, props: { ...props, visual } } as CardSpec, false);
}

function requireBroll(state: VersionState, i: number): VersionState {
  if (!shotAt(state, i).broll) throw new Error(`第 ${i} 个镜头没有 B-roll 素材，无法换一张`);
  return state;
}

function editCaption(state: VersionState, index: number, text: string): VersionState {
  if (index >= state.captions.length) throw new Error(`没有第 ${index} 句字幕（共 ${state.captions.length} 句）`);
  const tooLong = captionTooLong(text);
  if (tooLong) throw new Error(tooLong);
  return { ...state, captions: state.captions.map((c, j) => (j === index ? { ...c, text } : c)) };
}

function setBgm(state: VersionState, bgm: string): VersionState {
  // 情绪不是曲目：改分镜里的 bgm 情绪，选曲回到自动
  if ((MOODS as readonly string[]).includes(bgm)) return { ...state, bgm: { bgm: 'auto' }, storyboard: { ...state.storyboard, bgm: bgm as Mood } };
  return { ...state, bgm: { bgm } };
}

/** 当前剪辑方案再扣掉 extraCuts 之后剩下的成片秒数（此前版本的 extraCuts 已体现在 plan.keep 里，不会重复扣）；短于 minKeep 的碎片 buildEditPlan 会丢弃，这里同样不算 */
function remainingSec(state: VersionState): number {
  return currentKeep(state).filter((r) => r.end - r.start >= state.cutOptions.minKeep).reduce((sum, r) => sum + r.end - r.start, 0);
}

/** 现在会出现在成片里的原片区间：plan.keep 扣掉 extraCuts */
const currentKeep = (state: VersionState): TimeRange[] => state.plan.keep.flatMap((k) => state.extraCuts.reduce(subtractRange, [k]));

/** 找回的区间里不到这么长是新内容，就当作本来就在成片里 */
const MIN_NEW_SEC = 0.1;

function removeSpan(state: VersionState, from: number, to: number): VersionState {
  if (!(to > from) || from >= state.plan.outputDurationSec) throw new Error(`删除的时间范围不在成片内（成片 ${state.plan.outputDurationSec} 秒）`);
  const pieces = outputToSource(state.plan.keep, from, to);
  const next = { ...state, extraCuts: pieces.reduce(addRange, state.extraCuts), restored: pieces.reduce(subtractRange, state.restored) };
  if (remainingSec(next) < MIN_OUTPUT_SEC) throw new Error(`删除后成片不足 ${MIN_OUTPUT_SEC} 秒`);
  return next;
}

function restoreSpan(state: VersionState, from: number, to: number): VersionState {
  if (!(to > from) || from >= state.plan.sourceDurationSec) throw new Error(`找回的时间范围不在原片内（原片 ${state.plan.sourceDurationSec} 秒）`);
  const span = { start: from, end: Math.min(to, state.plan.sourceDurationSec) };
  const missing = currentKeep(state).reduce(subtractRange, [span]).reduce((sum, r) => sum + r.end - r.start, 0);
  if (missing < MIN_NEW_SEC) throw new Error('这一段本来就在成片里，不需要找回');
  return { ...state, extraCuts: subtractRange(state.extraCuts, span), restored: addRange(state.restored, span) };
}

/** 应用单个操作；操作与状态对不上或违反版式规则时抛中文错误 */
export function applyOp(state: VersionState, op: EditOp): VersionState {
  switch (op.type) {
    case 'setBackground': return { ...state, settings: { ...state.settings, background: op.spec } };
    case 'setCaptionStyle': return { ...state, settings: { ...state.settings, captionStyle: op.id as CaptionStyleId } };
    case 'setCoverStyle': return { ...state, coverStyle: op.id as CoverStyleId };
    case 'setBgm': return setBgm(state, op.bgm);
    case 'replaceCard': return replaceCard(state, op.shotIndex, op.card);
    case 'setLayout': return setLayout(state, op.shotIndex, op.layout);
    case 'regenerateVisual': return regenerateVisual(state, op.shotIndex, op.visual);
    // 素材在素材步骤里重做（运行器按镜头时间定位），状态里先不动；这里只校验镜头带素材
    case 'replaceBroll': return requireBroll(state, op.shotIndex);
    case 'editCaption': return editCaption(state, op.index, op.text);
    case 'pace': return { ...state, cutOptions: pace(state.cutOptions, op.direction) };
    case 'removeSpan': return removeSpan(state, op.fromSec, op.toSec);
    case 'restoreSpan': return restoreSpan(state, op.fromSec, op.toSec);
  }
}

/**
 * 把操作依次应用到版本状态，返回新状态（纯函数，不改入参）。
 * removeSpan 的时间始终按应用前的 state.plan 换算，同一批里多个 removeSpan 互不影响；操作与状态对不上时抛中文错误。
 * 来自模型或 HTTP 请求体的操作必须先过 validateOps（逐条丢弃非法的），再交给这里。
 * pace / removeSpan / restoreSpan 之后 plan、captions、storyboard 仍是旧时间轴，由运行器重建 plan 后用 retimeCaptions、remapStoryboard 平移。
 */
export function applyOps(state: VersionState, ops: EditOp[]): VersionState {
  const next = ops.reduce(applyOp, state);
  // 版式整理（合并相邻的空镜头、hook 重新编号、对齐帧）放在整批结束后，批内的镜头序号始终指向应用前的镜头
  return ops.some((o) => o.type === 'replaceCard' || o.type === 'setLayout') ? { ...next, storyboard: canonicalize(next.storyboard).storyboard } : next;
}
