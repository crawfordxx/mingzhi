import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { AppConfig } from '../config.js';
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
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { renderTalk } from '../compose/render.js';
import { matteVideo } from '../matting/rvm.js';
import { extractWav16k } from '../media/extract-audio.js';
import { probe, type MediaInfo } from '../media/probe.js';
import { generateStoryboard } from '../storyboard/generate.js';
import type { Storyboard } from '../storyboard/schema.js';
import { projectRecorder, type ProjectFile, type ProjectPatch } from './project.js';

export type PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'background' | 'matte' | 'captions' | 'storyboard' | 'compose' | 'done';
export interface ProgressEvent { step: PipelineStep; message: string }
export interface PipelineArgs { input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; background?: BackgroundSpec; task?: TaskClient; onProgress?: (e: ProgressEvent) => void }
export interface PipelineResult { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[]; storyboard: Storyboard }

/** 每步完成：先把这一步的结果落盘到 project.json，再回调进度 */
type Complete = (step: PipelineStep, message: string, patch?: ProjectPatch) => ProjectFile;
interface Analysis { media: MediaInfo; transcript: Transcript; cuts: Cut[]; plan: EditPlan }

/** 字幕校对结果的一句话说明，例如「字幕校对：48/52 行采用模型结果…」 */
const polishSummary = (p: PolishResult): string => p.warning ?? `字幕校对：${p.lines.length}/${p.lines.length} 行采用模型结果`;

const fmtSec = (s: number): string => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

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
    emit({ step: 'matte', message: `抠像 ${done}/${total} 帧` });
  };
}

/** 换背景：落地背景图 → 抠像合成到 person.mp4；返回之后要烧字幕的视频 */
async function replaceBackground(args: PipelineArgs, cut: string, complete: Complete): Promise<string> {
  if (!args.background) return cut;
  const bg = await resolveBackground(args.background, args.workDir, args.task);
  complete('background', `背景：${describeBackground(bg.spec)}`, { background: { spec: bg.spec, path: bg.path } });
  const person = join(args.workDir, 'person.mp4');
  const started = Date.now();
  const res = await matteVideo({
    input: cut, output: person, backgroundPath: bg.path, cfg: args.cfg,
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
    emit({ step: 'compose', message: `渲染 ${pct}%` });
  };
}

/** 生成分镜；请求失败不中断，降级为整片人像全屏一个镜头，并在进度消息里写明原因 */
async function planStoryboard(llm: LlmClient, captions: TimedCaption[], durationSec: number, complete: Complete): Promise<Storyboard> {
  let res: Awaited<ReturnType<typeof generateStoryboard>>;
  try {
    res = await generateStoryboard(llm, captions, durationSec, []);
  } catch (err) {
    const storyboard: Storyboard = { shots: [{ start: 0, end: durationSec, layout: 'full' }] };
    complete('storyboard', `分镜生成失败，改为全程人像：${err instanceof Error ? err.message : String(err)}`, { storyboard });
    return storyboard;
  }
  const cards = res.storyboard.shots.filter((s) => s.card).length;
  const dropped = res.dropped > 0 ? ` · 丢弃 ${res.dropped} 个不合格镜头` : '';
  const retry = res.retryError ? ` · 重试失败（已用首次结果）：${res.retryError}` : '';
  complete('storyboard', `${res.storyboard.shots.length} 个镜头 · ${cards} 张卡片${dropped}${retry}`, { storyboard: res.storyboard, storyboardDropped: res.dropped });
  return res.storyboard;
}

/** 剪切 → 换背景 → 字幕 → 分镜 → Remotion 成片 */
async function produce(args: PipelineArgs, a: Analysis, complete: Complete): Promise<{ captions: TimedCaption[]; storyboard: Storyboard }> {
  const { input, workDir, output, cfg, llm } = args;
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

  const person = relative(workDir, base);
  if (person.startsWith('..')) throw new Error(`人像视频必须在工作目录内：${base}`);
  const storyboard = await planStoryboard(llm, captions, a.plan.outputDurationSec, complete);
  const { width, height } = await probe(base, cfg);
  await renderTalk({
    workDir, output, onProgress: throttledRenderProgress((e) => args.onProgress?.(e)),
    props: { person, personWidth: width, personHeight: height, subject: project.subject ?? null, captions, shots: storyboard.shots, durationSec: a.plan.outputDurationSec },
  }).catch((err: unknown) => {
    throw new Error(`成片渲染失败：${err instanceof Error ? err.message : String(err)}`);
  });
  complete('compose', '成片渲染完成', { artifacts: { output, final: output } });
  return { captions, storyboard };
}

/** 全流程；每步完成后增量写 project.json 并回调一次，供 P5 剪辑直播使用 */
export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
  if (args.background) validateBackground(args.background, args.cfg, args.task);
  mkdirSync(args.workDir, { recursive: true });
  mkdirSync(dirname(args.output), { recursive: true });
  const projectPath = join(args.workDir, 'project.json');
  const record = projectRecorder(projectPath, args.input);
  const complete: Complete = (step, message, patch = {}) => {
    const project = record(patch);
    args.onProgress?.({ step, message });
    return project;
  };
  const analysis = await analyze(args, complete);
  const { captions, storyboard } = await produce(args, analysis, complete);
  complete('done', args.output);
  return { output: args.output, projectPath, cuts: analysis.cuts, plan: analysis.plan, captions, storyboard };
}
