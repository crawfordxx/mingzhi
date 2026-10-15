import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { toAss } from '../captions/ass.js';
import type { TimedCaption } from '../captions/lines.js';
import { buildEditPlan, cutsToRanges, type EditPlan as CutPlan } from '../cut/plan.js';
import { captionsForRestored, droppedCardNotes, remapStoryboard, retimeCaptions, type VersionState } from '../edit/apply.js';
import { subtractRange } from '../edit/spans.js';
import type { PipelineArgs } from '../pipeline/run.js';
import { cutStage, planMessage } from '../pipeline/stages.js';
import type { Storyboard } from '../storyboard/schema.js';
import type { VersionEnv } from './runner.js';
import type { BaseAnalysis } from './runner-files.js';

/**
 * 按 cutOptions、extraCuts、restored 重建剪辑方案：
 * 剪掉的区间 = (模型标出的口误 − 用户找回的) ∪ 用户额外删掉的；找回的片段同时作为语音段补回（否则只是气口被丢的片段找不回来）。
 */
export function rebuildPlan(a: BaseAnalysis, s: VersionState): CutPlan {
  const llmCuts = s.restored.reduce(subtractRange, cutsToRanges(a.cuts, a.transcript.tokens));
  const plan = buildEditPlan([...a.transcript.segments, ...s.restored], [...llmCuts, ...s.extraCuts], a.media.durationSec, s.cutOptions);
  if (plan.keep.length === 0) throw new Error('修改后成片没有可保留的内容');
  return plan;
}

/** 重建剪辑方案并重新剪切到版本目录的 cut.mp4 */
export async function recut(env: VersionEnv, args: PipelineArgs, a: BaseAnalysis, next: VersionState): Promise<CutPlan> {
  const plan = rebuildPlan(a, next);
  env.complete('plan', `${planMessage(a.media.durationSec, plan.outputDurationSec)}（按修改重新剪辑）`, { plan });
  await cutStage(args, plan.keep, join(env.dir, 'cut.mp4'), env.complete);
  return plan;
}

/** 写出版本目录的 ASS 字幕（供外部使用；成片字幕由 Remotion 绘制） */
export function writeAss(env: VersionEnv, a: BaseAnalysis, captions: TimedCaption[]): string {
  const ass = join(env.dir, 'captions.ass');
  writeFileSync(ass, toAss(captions, a.media));
  return ass;
}

/** 剪辑类修改：字幕重新对时、找回的片段补字幕、分镜平移（都不调模型），并说明被删掉的卡片 */
export function retime(
  env: VersionEnv, a: BaseAnalysis, parent: VersionState, next: VersionState, plan: CutPlan,
): { captions: TimedCaption[]; storyboard: Storyboard } {
  const captions = captionsForRestored(a.transcript.tokens, next.restored, plan, retimeCaptions(next.captions, parent.plan, plan));
  env.complete('captions', `${captions.length} 行字幕 · 按新剪辑重新对时（未调用模型）`, { captions, artifacts: { ass: writeAss(env, a, captions) } });
  const storyboard = remapStoryboard(parent.plan, plan, next.storyboard);
  const notes = droppedCardNotes(next.storyboard, storyboard).map((n) => ` · ${n}`).join('');
  env.complete('storyboard', `${storyboard.shots.length} 个镜头 · 按新剪辑平移（未调用模型）${notes}`, { storyboard });
  return { captions, storyboard };
}
