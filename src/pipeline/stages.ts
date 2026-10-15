import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join, relative } from 'node:path';
import type { Transcript } from '../asr/types.js';
import { toAss } from '../captions/ass.js';
import { keptIndices, timeCaptions, type TimedCaption } from '../captions/lines.js';
import { polishCaptions, type PolishResult } from '../captions/polish.js';
import { PRESETS } from '../background/presets.js';
import { resolveBackground, type BackgroundSpec, type ResolvedBackground } from '../background/resolve.js';
import { rethrowIfCancelled } from '../cancel.js';
import { renderSegmented, type SegmentedResult } from '../compose/segments.js';
import { COVER_YUAN } from '../cost/estimate.js';
import type { CostMeter } from '../cost/meter.js';
import { detectCuts, type Cut } from '../cut/llm-cuts.js';
import { buildEditPlan, cutsToRanges, type EditPlan, type TimeRange } from '../cut/plan.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { SubjectBox } from '../matting/composite.js';
import type { MatteResult } from '../matting/rvm.js';
import type { MediaInfo } from '../media/probe.js';
import { generateStoryboard } from '../storyboard/generate.js';
import { DEFAULT_MOOD, type Storyboard } from '../storyboard/schema.js';
import type { CardQaEntry, CardScore } from '../qa/visual.js';
import type { HardCheck } from '../qa/hard.js';
import { prepareAudio } from './audio-step.js';
import { runBroll } from './broll-step.js';
import { cardScoreDetail, progressDetail } from './detail.js';
import { runCover, runLoudness } from './finish-step.js';
import { mediaOf } from './media-deps.js';
import type { ProjectFile, ProjectPatch } from './project.js';
import { runQaCards, runQaFinal } from './qa-step.js';
import type { PipelineArgs, PipelineStep, ProgressEvent } from './run.js';

/** 每步完成：先把这一步的结果落盘到 project.json，再回调进度 */
export type Complete = (step: PipelineStep, message: string, patch?: ProjectPatch) => ProjectFile;
export interface Analysis { media: MediaInfo; transcript: Transcript; cuts: Cut[]; plan: EditPlan }

/** 字幕校对结果的一句话说明，例如「字幕校对：48/52 行采用模型结果…」 */
const polishSummary = (p: PolishResult): string => p.warning ?? `字幕校对：${p.lines.length}/${p.lines.length} 行采用模型结果`;

export const fmtSec = (s: number): string => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** 给封面预留的花费：封面开启才预留，B-roll 与卡片自检的预算检查都要扣掉它 */
export const coverReserve = (args: Pick<PipelineArgs, 'cover'>): number => (args.cover === false ? 0 : COVER_YUAN);

/** 探测 → 抽音频（写到 wav）→ 识别 → 剪口误 → 剪辑方案 */
export async function analyzeStage(args: PipelineArgs, wav: string, complete: Complete): Promise<Analysis> {
  const { input, cfg, llm } = args;
  const m = mediaOf(args.media);
  const media = await m.probe(input, cfg);
  if (!media.hasAudio) throw new Error('输入视频没有音轨，无法识别口播');
  complete('probe', `${media.width}×${media.height} · ${fmtSec(media.durationSec)}`, { media });

  await m.extractWav(input, wav, cfg);
  complete('audio', '已抽取 16kHz 音频', { artifacts: { wav } });

  const transcript = m.transcribe(wav, cfg.modelsDir);
  complete('asr', `识别 ${transcript.tokens.length} 字 · ${transcript.segments.length} 个语音段`, { transcript });

  const { cuts, dropped } = await detectCuts(llm, transcript.tokens);
  complete('cuts', `标记 ${cuts.length} 处气口/重复/口误${dropped > 0 ? `（丢弃 ${dropped} 条无效结果）` : ''}`, { cuts });

  const plan = buildEditPlan(transcript.segments, cutsToRanges(cuts, transcript.tokens), media.durationSec);
  complete('plan', planMessage(media.durationSec, plan.outputDurationSec), { plan });
  return { media, transcript, cuts, plan };
}

export const planMessage = (sourceSec: number, outputSec: number): string => `原片 ${fmtSec(sourceSec)} → 成片 ${fmtSec(outputSec)}`;

/** 剪切：按保留区间剪原片到 output；先写临时文件再改名，失败或取消时不破坏已有文件（也不改动指向它的硬链接） */
export async function cutStage(args: PipelineArgs, keep: TimeRange[], output: string, complete: Complete): Promise<void> {
  const tmp = join(dirname(output), `.${basename(output, extname(output))}.${randomUUID().slice(0, 8)}.mp4`);
  try {
    await mediaOf(args.media).renderCut(args.input, keep, tmp, args.cfg);
    renameSync(tmp, output);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(`${tmp.slice(0, -extname(tmp).length)}.filter.txt`, { force: true });
  }
  complete('render', '剪切完成', { artifacts: { cut: output } });
}

/** 背景来源的一句话说明 */
const describeBackground = (spec: BackgroundSpec): string =>
  spec.kind === 'preset' ? (PRESETS.find((p) => p.id === spec.id)?.name ?? spec.id) : spec.kind === 'file' ? spec.path : `生成「${spec.prompt}」`;

/** 落地背景图（一句话生成的图下载到 args.workDir/background.jpg） */
export async function backgroundStage(args: PipelineArgs, spec: BackgroundSpec, complete: Complete): Promise<ResolvedBackground> {
  const bg = await resolveBackground(spec, args.workDir, args.task, undefined, args.meter);
  complete('background', `背景：${describeBackground(bg.spec)}`, { background: { spec: bg.spec, path: bg.path } });
  return bg;
}

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

/** 抠像换背景：cut → person（matte 给出时同时输出灰度遮罩，供以后只合成换背景） */
export async function matteStage(args: PipelineArgs, cut: string, bgPath: string, out: { person: string; matte?: string }, complete: Complete): Promise<MatteResult> {
  const started = Date.now();
  const res = await mediaOf(args.media).matte({
    input: cut, output: out.person, backgroundPath: bgPath, cfg: args.cfg, signal: args.signal, ...(out.matte ? { matteOutput: out.matte } : {}),
    onProgress: throttledMatteProgress((e) => args.onProgress?.(e)),
  });
  const secs = Math.max((Date.now() - started) / 1000, 0.001);
  complete('matte', `抠像换背景完成 · ${res.frames} 帧 · ${(res.frames / secs).toFixed(1)} 帧/秒`, { subject: res.subject, artifacts: { person: out.person } });
  return res;
}

/** 字幕：模型校对断句 → 对到成片时间轴 → 另写一份 ASS 供外部使用（成片字幕由 Remotion 绘制） */
export async function captionsStage(args: PipelineArgs, a: Analysis, ass: string, complete: Complete): Promise<TimedCaption[]> {
  const polished = await polishCaptions(args.llm, a.transcript.tokens, keptIndices(a.transcript.tokens.length, a.cuts));
  const captions = timeCaptions(polished.lines, a.transcript.tokens, a.plan.keep);
  writeFileSync(ass, toAss(captions, a.media));
  complete('captions', `${captions.length} 行字幕 · ${polishSummary(polished)}`, { captionLines: polished.lines, captionsSource: polished.source, captions, artifacts: { ass } });
  return captions;
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

/** 分镜 → 素材（素材文件写到 brollDir/broll，缓存按需求内容命中） */
export async function storyboardStage(args: PipelineArgs, captions: TimedCaption[], durationSec: number, brollDir: string, complete: Complete): Promise<Storyboard> {
  const planned = await planStoryboard(args.llm, captions, durationSec, complete);
  return brollStage(args, planned, durationSec, brollDir, complete);
}

/** 只跑素材步骤（修改版本的 regenerateVisual 等也走这里，预算与 maxVideos 由 args.broll / args.meter 约束；deferShots 的需求排到最后） */
export function brollStage(args: PipelineArgs, storyboard: Storyboard, durationSec: number, brollDir: string, complete: Complete, deferShots?: number[]): Promise<Storyboard> {
  return runBroll({ ...args, workDir: brollDir, reserveYuan: coverReserve(args), ...(deferShots ? { deferShots } : {}) }, storyboard, durationSec, complete);
}

/** 卡片自检（args.qa 为 false 时跳过）；only 给出时只检查这些镜头 */
export async function qaCardsStage(args: PipelineArgs, meter: CostMeter, storyboard: Storyboard, captions: TimedCaption[], complete: Complete, only?: number[]): Promise<{ storyboard: Storyboard; cards: CardQaEntry[] }> {
  if (args.qa === false) return { storyboard, cards: [] };
  const onProgress = (message: string, info?: { shotIndex: number; attempt: number; score: CardScore; passed: boolean }): void =>
    args.onProgress?.({ step: 'qa-cards', message, ...(info ? { detail: cardScoreDetail(info.shotIndex, info.score, info.passed, info.attempt) } : {}) });
  const ctx = { llm: args.llm, workDir: args.workDir, meter, ffmpeg: args.cfg.ffmpeg, reserveYuan: coverReserve(args), signal: args.signal, qaCards: args.qaDeps?.qaCards, onProgress, ...(only ? { only } : {}) };
  const res = await runQaCards(ctx, storyboard, captions, complete);
  return { storyboard: res.storyboard, cards: res.report };
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

/** person：人像视频（必须在 args.workDir 内）；raw：渲染结果；output：响度统一后的成片；cacheDir：分段缓存 */
export interface ComposeInput { person: string; subject: SubjectBox | null; captions: TimedCaption[]; storyboard: Storyboard; outputDurationSec: number; raw: string; output: string; cacheDir: string }

/** 配乐音效与字幕样式落盘 → 分段渲染（命中缓存的镜头直接复用）到 raw → 响度统一得到成片；返回重渲与复用的镜头序号 */
export async function composeStage(args: PipelineArgs, c: ComposeInput, complete: Complete): Promise<SegmentedResult> {
  const { workDir, cfg } = args;
  const m = mediaOf(args.media);
  if (relative(workDir, c.person).startsWith('..')) throw new Error(`人像视频必须在工作目录内：${c.person}`);
  const baseInfo = await m.probe(c.person, cfg);
  // 成片时长不超过人像视频的实际时长（剪切编码后可能比方案略短），避免末尾取不到帧
  const durationSec = Math.min(c.outputDurationSec, baseInfo.durationSec);
  const audio = await prepareAudio({ workDir, cfg, input: args.input, audio: args.audio, captionStyle: args.captionStyle }, c.storyboard, c.captions, durationSec);
  audio.notes.forEach((note) => complete('compose', note));
  complete('compose', audio.summary, { audio: audio.info, captionStyle: audio.props.captionStyle });
  const progress = throttledRenderProgress((e) => args.onProgress?.(e));
  const res = await renderSegmented({
    workDir, cacheDir: c.cacheDir, output: c.raw, ffmpeg: cfg.ffmpeg, signal: args.signal, backend: m.segments, onProgress: (done, total) => progress(total > 0 ? done / total : 1),
    props: { person: relative(workDir, c.person), personWidth: baseInfo.width, personHeight: baseInfo.height, subject: c.subject, captions: c.captions, shots: c.storyboard.shots, durationSec, ...audio.props },
  }).catch((err: unknown) => {
    rethrowIfCancelled(err);
    throw new Error(`成片渲染失败：${err instanceof Error ? err.message : String(err)}`);
  });
  progress(1);
  complete('compose', '成片渲染完成');
  await runLoudness(cfg, c.raw, c.output, complete, m.loudness);
  return res;
}

/** 成片硬检查（args.qa 为 false 时跳过） */
export function finalQaStage(args: PipelineArgs, video: string, storyboard: Storyboard, cards: CardQaEntry[], complete: Complete): Promise<HardCheck[]> {
  if (args.qa === false) return Promise.resolve([]);
  return runQaFinal({ cfg: args.cfg, hardChecks: args.qaDeps?.hardChecks }, video, storyboard, cards, complete);
}

/** 封面（args.cover 为 false 时跳过；失败只降级为进度消息） */
export function coverStage(args: PipelineArgs, meter: CostMeter, storyboard: Storyboard, captions: TimedCaption[], personVideo: string, complete: Complete): Promise<void> {
  const ctx = { workDir: args.workDir, output: args.output, cfg: args.cfg, llm: args.llm, task: args.task, coverDeps: args.coverDeps, meter };
  return runCover(ctx, args.cover, storyboard, captions, personVideo, complete);
}
