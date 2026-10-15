import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AppConfig } from '../config.js';
import { COVER_YUAN } from '../cost/estimate.js';
import { CostMeter } from '../cost/meter.js';
import type { Transcript } from '../asr/types.js';
import { transcribeWav } from '../asr/local-asr.js';
import { toAss } from '../captions/ass.js';
import { keptIndices, timeCaptions, type TimedCaption } from '../captions/lines.js';
import { polishCaptions, type PolishResult } from '../captions/polish.js';
import { PRESETS } from '../background/presets.js';
import { resolveBackground, validateBackground, type BackgroundSpec } from '../background/resolve.js';
import { detectCuts, type Cut } from '../cut/llm-cuts.js';
import { buildEditPlan, cutsToRanges, type EditPlan } from '../cut/plan.js';
import { renderCut } from '../cut/render-cut.js';
import { CancelledError, rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { renderTalk } from '../compose/render.js';
import type { SubjectBox } from '../matting/composite.js';
import { matteVideo } from '../matting/rvm.js';
import { extractWav16k } from '../media/extract-audio.js';
import { probe, type MediaInfo } from '../media/probe.js';
import { runBroll, validateBroll, type BrollOptions } from './broll-step.js';
import type { BrollDeps } from '../broll/fulfill.js';
import { generateStoryboard } from '../storyboard/generate.js';
import { DEFAULT_MOOD, type Storyboard } from '../storyboard/schema.js';
import { prepareAudio, validateAudio, type AudioOptions } from './audio-step.js';
import { runCover, runLoudness, validateStyles, type CoverDeps, type CoverOptions } from './finish-step.js';
import type { CaptionStyleId } from '../captions/styles.js';
import { projectRecorder, type ProjectFile, type ProjectPatch } from './project.js';
import type { CardQaEntry, CardScore } from '../qa/visual.js';
import { cardScoreDetail, costDetail, detailOfStep, progressDetail, type ProgressDetail } from './detail.js';
import { runQaCards, runQaFinal, type PipelineQa, type QaDeps } from './qa-step.js';

export type PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'background' | 'matte' | 'captions' | 'storyboard' | 'broll' | 'qa-cards' | 'compose' | 'loudness' | 'qa-final' | 'cover' | 'done';
/** detail 是给工作台「剪辑直播」用的结构化数据（可选，旧调用方可以忽略；message 文本不变） */
export interface ProgressEvent { step: PipelineStep; message: string; detail?: ProgressDetail }
export interface PipelineArgs {
  input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; background?: BackgroundSpec; task?: TaskClient; broll?: BrollOptions; brollDeps?: BrollDeps;
  /** 配乐选择；缺省 { bgm: 'auto' } */
  audio?: AudioOptions;
  /** 字幕样式；缺省 blade */
  captionStyle?: CaptionStyleId;
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
  /** 取消信号：每一步完成后检查，抠像与成片渲染在步骤内部也响应；已取消则抛 CancelledError（消息「已取消」） */
  signal?: AbortSignal;
  onProgress?: (e: ProgressEvent) => void;
}
export interface PipelineResult { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[]; storyboard: Storyboard; qa: PipelineQa }

/** 每步完成：先把这一步的结果落盘到 project.json，再回调进度 */
type Complete = (step: PipelineStep, message: string, patch?: ProjectPatch) => ProjectFile;
interface Analysis { media: MediaInfo; transcript: Transcript; cuts: Cut[]; plan: EditPlan }

/** 字幕校对结果的一句话说明，例如「字幕校对：48/52 行采用模型结果…」 */
const polishSummary = (p: PolishResult): string => p.warning ?? `字幕校对：${p.lines.length}/${p.lines.length} 行采用模型结果`;

const fmtSec = (s: number): string => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** 花费变化事件：只带 cost 明细（CLI 不打印它，工作台用它刷新「已花 / 上限」） */
function costEvent(step: PipelineStep, meter: CostMeter): ProgressEvent {
  const budget = Number.isFinite(meter.budget) ? meter.budget : null;
  return { step, message: `已花费 ¥${meter.total.toFixed(2)}${budget === null ? '' : `（上限 ¥${budget.toFixed(2)}）`}`, detail: costDetail(meter.total, budget) };
}

/** 给封面预留的花费：封面开启才预留，B-roll 与卡片自检的预算检查都要扣掉它 */
const coverReserve = (args: PipelineArgs): number => (args.cover === false ? 0 : COVER_YUAN);

/** 当前账目快照写进 project.json；预算不限时 budget 为 null（JSON 里没有 Infinity） */
const costsOf = (meter: CostMeter): NonNullable<ProjectFile['costs']> => ({ total: meter.total, budget: Number.isFinite(meter.budget) ? meter.budget : null, entries: [...meter.entries] });

/** 探测 → 抽音频 → 识别 → 剪口误 → 剪辑方案 */
async function analyze(args: PipelineArgs, complete: Complete): Promise<Analysis> {
  const { input, workDir, cfg, llm } = args;
  const media = await probe(input, cfg);
  if (!media.hasAudio) throw new Error('输入视频没有音轨，无法识别口播');
  complete('probe', `${media.width}×${media.height} · ${fmtSec(media.durationSec)}`, { media });

  const wav = join(workDir, 'audio16k.wav');
  await extractWav16k(input, wav, cfg);
  complete('audio', '已抽取 16kHz 音频', { artifacts: { wav } });

  const transcript = transcribeWav(wav, cfg.modelsDir);
  complete('asr', `识别 ${transcript.tokens.length} 字 · ${transcript.segments.length} 个语音段`, { transcript });

  const { cuts, dropped } = await detectCuts(llm, transcript.tokens);
  complete('cuts', `标记 ${cuts.length} 处气口/重复/口误${dropped > 0 ? `（丢弃 ${dropped} 条无效结果）` : ''}`, { cuts });

  const plan = buildEditPlan(transcript.segments, cutsToRanges(cuts, transcript.tokens), media.durationSec);
  complete('plan', `原片 ${fmtSec(media.durationSec)} → 成片 ${fmtSec(plan.outputDurationSec)}`, { plan });
  return { media, transcript, cuts, plan };
}

/** 背景来源的一句话说明 */
const describeBackground = (spec: BackgroundSpec): string =>
  spec.kind === 'preset' ? (PRESETS.find((p) => p.id === spec.id)?.name ?? spec.id) : spec.kind === 'file' ? spec.path : `生成「${spec.prompt}」`;

/** 抠像进度节流：至少前进 5% 才转发一次（首次与收尾必发）；只回调、不写 project.json */
export function throttledMatteProgress(emit: (e: ProgressEvent) => void): (done: number, total: number) => void {
  const STEP = 0.05;
  let last = -1;
  return (done, total) => {
    const ratio = total > 0 ? done / total : 1;
    if (ratio - last < STEP && done < total) return;
    last = ratio;
    emit({ step: 'matte', message: `抠像 ${done}/${total} 帧`, detail: progressDetail('matte', Math.floor(ratio * 100), { done, total }) });
  };
}

/** 换背景：落地背景图 → 抠像合成到 person.mp4；返回之后要烧字幕的视频 */
async function replaceBackground(args: PipelineArgs, cut: string, complete: Complete): Promise<string> {
  if (!args.background) return cut;
  const bg = await resolveBackground(args.background, args.workDir, args.task, undefined, args.meter);
  complete('background', `背景：${describeBackground(bg.spec)}`, { background: { spec: bg.spec, path: bg.path } });
  const person = join(args.workDir, 'person.mp4');
  const started = Date.now();
  const res = await matteVideo({
    input: cut, output: person, backgroundPath: bg.path, cfg: args.cfg, signal: args.signal,
    onProgress: throttledMatteProgress((e) => args.onProgress?.(e)),
  });
  const secs = Math.max((Date.now() - started) / 1000, 0.001);
  complete('matte', `抠像换背景完成 · ${res.frames} 帧 · ${(res.frames / secs).toFixed(1)} 帧/秒`, { subject: res.subject, artifacts: { person } });
  return person;
}

/** 成片渲染进度节流：至少前进 5% 才转发一次（收尾必发且只发一次）；只回调、不写 project.json */
export function throttledRenderProgress(emit: (e: ProgressEvent) => void): (ratio: number) => void {
  const STEP = 5;
  let last = -STEP;
  return (ratio) => {
    const pct = Math.floor(ratio * 100);
    if (pct - last < STEP && pct < 100) return;
    if (pct === last) return;
    last = pct;
    emit({ step: 'compose', message: `渲染 ${pct}%`, detail: progressDetail('compose', pct) });
  };
}

/** 生成分镜；请求失败不中断，降级为整片人像全屏一个镜头，并在进度消息里写明原因 */
async function planStoryboard(llm: LlmClient, captions: TimedCaption[], durationSec: number, complete: Complete): Promise<Storyboard> {
  let res: Awaited<ReturnType<typeof generateStoryboard>>;
  try {
    res = await generateStoryboard(llm, captions, durationSec, []);
  } catch (err) {
    rethrowIfBalance(err); // 余额不足降级也没用：后面的付费步骤同样会失败
    rethrowIfCancelled(err);
    const storyboard: Storyboard = { shots: [{ start: 0, end: durationSec, layout: 'full' }], bgm: DEFAULT_MOOD };
    complete('storyboard', `分镜生成失败，改为全程人像：${err instanceof Error ? err.message : String(err)}`, { storyboard });
    return storyboard;
  }
  const cards = res.storyboard.shots.filter((s) => s.card).length;
  const dropped = res.dropped > 0 ? ` · 丢弃 ${res.dropped} 个不合格镜头` : '';
  const retry = res.retryError ? ` · 重试失败（已用首次结果）：${res.retryError}` : '';
  complete('storyboard', `${res.storyboard.shots.length} 个镜头 · ${cards} 张卡片${dropped}${retry}`, { storyboard: res.storyboard, storyboardDropped: res.dropped, storyboardDemoted: res.demoted, storyboardCapped: res.capped });
  return res.storyboard;
}

interface Produced { captions: TimedCaption[]; storyboard: Storyboard; base: string; subject: SubjectBox | null }

/** 剪切 → 换背景 → 字幕 → 分镜 → 素材 */
async function produce(args: PipelineArgs, a: Analysis, complete: Complete): Promise<Produced> {
  const { input, workDir, cfg, llm } = args;
  const cut = join(workDir, 'cut.mp4');
  await renderCut(input, a.plan.keep, cut, cfg);
  complete('render', '剪切完成', { artifacts: { cut } });
  const base = await replaceBackground(args, cut, complete);

  const polished = await polishCaptions(llm, a.transcript.tokens, keptIndices(a.transcript.tokens.length, a.cuts));
  const captions = timeCaptions(polished.lines, a.transcript.tokens, a.plan.keep);
  // ASS 仍写出供外部使用，成片里的字幕由 Remotion 绘制，不再烧录
  const ass = join(workDir, 'captions.ass');
  writeFileSync(ass, toAss(captions, a.media));
  const project = complete('captions', `${captions.length} 行字幕 · ${polishSummary(polished)}`,
    { captionLines: polished.lines, captionsSource: polished.source, captions, artifacts: { ass } });

  if (relative(workDir, base).startsWith('..')) throw new Error(`人像视频必须在工作目录内：${base}`);
  const planned = await planStoryboard(llm, captions, a.plan.outputDurationSec, complete);
  const storyboard = await runBroll({ ...args, reserveYuan: coverReserve(args) }, planned, a.plan.outputDurationSec, complete);
  return { captions, storyboard, base, subject: project.subject ?? null };
}

/** 配乐音效与字幕样式落盘 → Remotion 渲染到 final.raw.mp4 → 响度统一得到最终成片（成功后才写 output） */
async function compose(args: PipelineArgs, a: Analysis, p: Produced, complete: Complete): Promise<void> {
  const { workDir, cfg } = args;
  const baseInfo = await probe(p.base, cfg);
  // 成片时长不超过人像视频的实际时长（剪切编码后可能比方案略短），避免末尾取不到帧
  const durationSec = Math.min(a.plan.outputDurationSec, baseInfo.durationSec);
  const audio = await prepareAudio({ workDir, cfg, input: args.input, audio: args.audio, captionStyle: args.captionStyle }, p.storyboard, p.captions, durationSec);
  audio.notes.forEach((note) => complete('compose', note));
  complete('compose', audio.summary, { audio: audio.info, captionStyle: audio.props.captionStyle });
  const raw = join(workDir, 'final.raw.mp4');
  await renderTalk({
    workDir, output: raw, signal: args.signal, onProgress: throttledRenderProgress((e) => args.onProgress?.(e)),
    props: { person: relative(workDir, p.base), personWidth: baseInfo.width, personHeight: baseInfo.height, subject: p.subject, captions: p.captions, shots: p.storyboard.shots, durationSec, ...audio.props },
  }).catch((err: unknown) => {
    rethrowIfCancelled(err);
    throw new Error(`成片渲染失败：${err instanceof Error ? err.message : String(err)}`);
  });
  complete('compose', '成片渲染完成');
  await runLoudness(cfg, raw, args.output, complete);
}

/**
 * 全流程；每步完成后增量写 project.json 并回调一次，供 P5 剪辑直播使用。
 * 注意：剪口误、字幕校对、分镜这三步有意不查预算（没有它们出不了片，且花费很小），预估里会单独提示它们是否已超上限。
 * 重跑同一工作目录会重新付费：只有 B-roll 素材与封面底图有磁盘缓存，其余 AI 步骤每次都重新调用。
 */
export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
  throwIfCancelled(args.signal);
  if (args.background) validateBackground(args.background, args.cfg, args.task);
  validateBroll(args.broll, args.brollDeps, args.task);
  validateAudio(args.audio);
  validateStyles(args.captionStyle, args.cover);
  mkdirSync(args.workDir, { recursive: true });
  mkdirSync(dirname(args.output), { recursive: true });
  const projectPath = join(args.workDir, 'project.json');
  const record = projectRecorder(projectPath, args.input);
  const meter = args.meter ?? new CostMeter({}, Number.POSITIVE_INFINITY);
  let lastCost: number | null = null;
  const complete: Complete = (step, message, patch = {}) => {
    const project = record({ ...patch, costs: costsOf(meter) });
    const detail = detailOfStep(step, patch, project);
    args.onProgress?.({ step, message, ...(detail ? { detail } : {}) });
    if (meter.total !== lastCost) { lastCost = meter.total; args.onProgress?.(costEvent(step, meter)); }
    throwIfCancelled(args.signal); // 步骤之间检查；这一步的结果已经落盘，取消不丢数据
    return project;
  };
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

/** 卡片自检（可跳过）：返回改写后的制作结果与报告 */
async function qaCardsStep(args: PipelineArgs, meter: CostMeter, p: Produced, complete: Complete): Promise<{ produced: Produced; cards: CardQaEntry[] }> {
  if (args.qa === false) return { produced: p, cards: [] };
  const ctx = { llm: args.llm, workDir: args.workDir, meter, ffmpeg: args.cfg.ffmpeg, reserveYuan: coverReserve(args), signal: args.signal, qaCards: args.qaDeps?.qaCards, onProgress: (message: string, info?: { shotIndex: number; attempt: number; score: CardScore; passed: boolean }) => args.onProgress?.({ step: 'qa-cards', message, ...(info ? { detail: cardScoreDetail(info.shotIndex, info.score, info.passed, info.attempt) } : {}) }) };
  const res = await runQaCards(ctx, p.storyboard, p.captions, complete);
  return { produced: { ...p, storyboard: res.storyboard }, cards: res.report };
}

/** 分析 → 制作 → 卡片自检 → 成片 → 成片检查 → 封面 */
async function runSteps(args: PipelineArgs, projectPath: string, complete: Complete, meter: CostMeter): Promise<PipelineResult> {
  const analysis = await analyze(args, complete);
  const { produced, cards } = await qaCardsStep(args, meter, await produce(args, analysis, complete), complete);
  await compose(args, analysis, produced, complete);
  const hard = args.qa === false ? [] : await runQaFinal({ cfg: args.cfg, hardChecks: args.qaDeps?.hardChecks }, args.output, produced.storyboard, cards, complete);
  await runCover({ workDir: args.workDir, output: args.output, cfg: args.cfg, llm: args.llm, task: args.task, coverDeps: args.coverDeps, meter }, args.cover, produced.storyboard, produced.captions, produced.base, complete);
  complete('done', args.output);
  return { output: args.output, projectPath, cuts: analysis.cuts, plan: analysis.plan, captions: produced.captions, storyboard: produced.storyboard, qa: { cards, hard } };
}
