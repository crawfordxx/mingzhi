import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import { CostMeter } from '../cost/meter.js';
import type { TimedCaption } from '../captions/lines.js';
import { validateBackground, type BackgroundSpec } from '../background/resolve.js';
import type { Cut } from '../cut/llm-cuts.js';
import type { EditPlan } from '../cut/plan.js';
import { CancelledError, throwIfCancelled } from '../cancel.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { validateBroll, type BrollOptions } from './broll-step.js';
import { writeStoryboardCredits } from '../broll/credit-store.js';
import type { SubjectBox } from '../matting/composite.js';
import type { BrollDeps } from '../broll/fulfill.js';
import type { Storyboard } from '../storyboard/schema.js';
import { validateAudio, type AudioOptions } from './audio-step.js';
import { validateStyles, type CoverDeps, type CoverOptions } from './finish-step.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { OutroOptions } from '../compose/ending.js';
import { projectRecorder, type ProjectFile, type ProjectPatch } from './project.js';
import { costDetail, detailOfStep, type ProgressDetail } from './detail.js';
import type { PipelineQa, QaDeps } from './qa-step.js';
import type { MediaDeps } from './media-deps.js';
import {
  analyzeStage, backgroundStage, captionsStage, composeStage, coverStage, cutStage, finalQaStage, matteStage, qaCardsStage, storyboardStage,
  type Analysis, type Complete,
} from './stages.js';

export { throttledMatteProgress, throttledRenderProgress } from './stages.js';

/** edit：工作台修改版本的说明（应用了哪些修改、复用了什么）；runPipeline 不发 */
export type PipelineStep =
  | 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'background' | 'matte' | 'captions' | 'storyboard' | 'broll'
  | 'qa-cards' | 'compose' | 'loudness' | 'qa-final' | 'cover' | 'edit' | 'done';
/** detail 是给工作台「剪辑直播」用的结构化数据（可选，旧调用方可以忽略；message 文本不变） */
export interface ProgressEvent { step: PipelineStep; message: string; detail?: ProgressDetail }
export interface PipelineArgs {
  input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; background?: BackgroundSpec; task?: TaskClient; broll?: BrollOptions; brollDeps?: BrollDeps;
  /** 配乐选择；缺省 { bgm: 'auto' } */
  audio?: AudioOptions;
  /** 字幕样式；缺省 blade */
  captionStyle?: CaptionStyleId;
  /** 品牌片尾；缺省开启，默认 logo + 「用明知AI剪辑制作」 */
  outro?: Partial<OutroOptions>;
  /** 颗粒质感层开关；缺省时按分镜是否用到 B-roll 决定（旧项目不变） */
  grain?: boolean;
  /** 封面；缺省按默认风格生成，false 关闭 */
  cover?: CoverOptions;
  /** 仅供测试注入的封面实现 */
  coverDeps?: CoverDeps;
  /** 统一记账（预算以它为准）；缺省时不限预算，B-roll 仍按 broll.budgetYuan 在本步内检查 */
  meter?: CostMeter;
  /** 卡片视觉自检与成片硬检查；缺省 true，false 跳过两个自检步骤 */
  qa?: boolean;
  /** 仅供测试注入的自检实现 */
  qaDeps?: QaDeps;
  /** 仅供测试注入的本地媒体处理实现（识别、剪切、抠像、渲染等） */
  media?: Partial<MediaDeps>;
  /** 分段渲染缓存目录；缺省 workDir/segments */
  cacheDir?: string;
  /** 取消信号：每一步完成后检查，抠像与成片渲染在步骤内部也响应；已取消则抛 CancelledError（消息「已取消」） */
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
}
export interface PipelineResult { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[]; storyboard: Storyboard; qa: PipelineQa }

/** 上限说明：给了项目上限（工作台）时写项目上限与剩余额度，否则计费器上限就是上限（CLI） */
function limitText(meter: CostMeter, budget: number | null, capYuan?: number): string {
  if (budget === null) return '';
  if (capYuan === undefined) return `（上限 ¥${budget.toFixed(2)}）`;
  return `（项目上限 ¥${capYuan.toFixed(2)} · 剩余 ¥${Math.max(0, budget - meter.total).toFixed(2)}）`;
}

/** 花费变化事件：只带 cost 明细（CLI 不打印它，工作台用它刷新「已花 / 上限」） */
function costEvent(step: PipelineStep, meter: CostMeter, capYuan?: number): ProgressEvent {
  const budget = Number.isFinite(meter.budget) ? meter.budget : null;
  return { step, message: `已花费 ¥${meter.total.toFixed(2)}${limitText(meter, budget, capYuan)}`, detail: costDetail(meter.total, budget, capYuan) };
}

/** 当前账目快照写进 project.json；预算不限时 budget 为 null（JSON 里没有 Infinity） */
export const costsOf = (meter: CostMeter): NonNullable<ProjectFile['costs']> => ({
  total: meter.total, budget: Number.isFinite(meter.budget) ? meter.budget : null, entries: [...meter.entries],
});

/**
 * 每步完成的统一处理：补上当前账目落盘 → 带明细回调进度 → 花费变化时再发一条 cost 事件 → 检查取消。
 * 工作台的版本运行器也用它（record 指向版本目录的 project.json）。
 */
export function makeComplete(o: {
  record: (patch: ProjectPatch) => ProjectFile; meter: CostMeter; onProgress?: (e: ProgressEvent) => void; signal?: AbortSignal;
  /** 工作台的项目上限（元）：计费器上限是项目剩余额度，提示里分开写项目上限与剩余 */
  capYuan?: number;
}): Complete {
  let lastCost: number | null = null;
  return (step, message, patch = {}) => {
    const project = o.record({ ...patch, costs: costsOf(o.meter) });
    const detail = detailOfStep(step, patch, project);
    o.onProgress?.({ step, message, ...(detail ? { detail } : {}) });
    if (o.meter.total !== lastCost) { lastCost = o.meter.total; o.onProgress?.(costEvent(step, o.meter, o.capYuan)); }
    throwIfCancelled(o.signal); // 步骤之间检查；这一步的结果已经落盘，取消不丢数据
    return project;
  };
}

/** 流程开始前的快速校验：背景、素材、配乐、样式参数不对立即报错 */
export function validateArgs(args: PipelineArgs): void {
  if (args.background) validateBackground(args.background, args.cfg, args.task);
  validateBroll(args.broll, args.brollDeps, args.task);
  validateAudio(args.audio);
  validateStyles(args.captionStyle, args.cover);
}

/**
 * 全流程；每步完成后增量写 project.json 并回调一次，供 P5 剪辑直播使用。
 * 注意：剪口误、字幕校对、分镜这三步有意不查预算（没有它们出不了片，且花费很小），预估里会单独提示它们是否已超上限。
 * 重跑同一工作目录会重新付费：只有 B-roll 素材与封面底图有磁盘缓存，其余 AI 步骤每次都重新调用。
 */
export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
  throwIfCancelled(args.signal);
  validateArgs(args);
  mkdirSync(args.workDir, { recursive: true });
  mkdirSync(dirname(args.output), { recursive: true });
  const projectPath = join(args.workDir, 'project.json');
  const record = projectRecorder(projectPath, args.input);
  const meter = args.meter ?? new CostMeter({}, Number.POSITIVE_INFINITY);
  const complete = makeComplete({ record, meter, onProgress: args.onProgress, signal: args.signal });
  try {
    return await runSteps(args, projectPath, complete, meter);
  } catch (err) {
    // 已取消时以取消为准：取消后在途的付费调用才报出的余额不足等错误不再外抛，调用方只会看到「已取消」
    if (args.signal?.aborted && !(err instanceof CancelledError)) throw new CancelledError();
    throw err;
  } finally {
    // 无论成败都把最新账目落盘：失败时钱已经花了；写盘失败不能盖掉原错误
    try { record({ costs: costsOf(meter) }); } catch { /* 忽略：保留 try 块里的原始错误 */ }
  }
}

interface Produced { captions: TimedCaption[]; storyboard: Storyboard; base: string; subject: SubjectBox | null }

/** 剪切 → 换背景 → 字幕 → 分镜 → 素材 */
async function produce(args: PipelineArgs, a: Analysis, complete: Complete): Promise<Produced> {
  const cut = join(args.workDir, 'cut.mp4');
  await cutStage(args, a.plan.keep, cut, complete);
  let base = cut;
  let subject: SubjectBox | null = null;
  if (args.background) {
    const bg = await backgroundStage(args, args.background, complete);
    base = join(args.workDir, 'person.mp4');
    subject = (await matteStage(args, cut, bg.path, { person: base }, complete)).subject;
  }
  const captions = await captionsStage(args, a, join(args.workDir, 'captions.ass'), complete);
  const storyboard = await storyboardStage(args, captions, a.plan.outputDurationSec, args.workDir, complete);
  return { captions, storyboard, base, subject };
}

/** 分析 → 制作 → 卡片自检 → 成片 → 成片检查 → 封面 */
async function runSteps(args: PipelineArgs, projectPath: string, complete: Complete, meter: CostMeter): Promise<PipelineResult> {
  const analysis = await analyzeStage(args, join(args.workDir, 'audio16k.wav'), complete);
  const p = await produce(args, analysis, complete);
  const { storyboard, cards } = await qaCardsStage(args, meter, p.storyboard, p.captions, complete);
  // 授权记录按卡片自检之后的最终分镜重写（自检可能改掉带图的卡）
  if (args.broll?.enabled) writeStoryboardCredits(storyboard, args.workDir, args.workDir);
  const raw = join(args.workDir, 'final.raw.mp4');
  const cacheDir = args.cacheDir ?? join(args.workDir, 'segments');
  const outputDurationSec = analysis.plan.outputDurationSec;
  const input = { person: p.base, subject: p.subject, captions: p.captions, storyboard, outputDurationSec, raw, output: args.output, cacheDir };
  const composed = await composeStage(args, input, complete);
  const hard = await finalQaStage(args, args.output, storyboard, cards, complete, composed.outroStartSec);
  await coverStage(args, meter, storyboard, p.captions, p.base, complete);
  complete('done', args.output);
  return { output: args.output, projectPath, cuts: analysis.cuts, plan: analysis.plan, captions: p.captions, storyboard, qa: { cards, hard } };
}
