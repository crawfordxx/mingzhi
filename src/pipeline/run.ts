import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { Transcript } from '../asr/types.js';
import { transcribeWav } from '../asr/local-asr.js';
import { burnSubtitles } from '../captions/burn.js';
import { toAss } from '../captions/ass.js';
import { keptIndices, timeCaptions, type TimedCaption } from '../captions/lines.js';
import { polishCaptions, type PolishResult } from '../captions/polish.js';
import { PRESETS } from '../background/presets.js';
import { resolveBackground, type BackgroundSpec } from '../background/resolve.js';
import { detectCuts, type Cut } from '../cut/llm-cuts.js';
import { buildEditPlan, cutsToRanges, type EditPlan } from '../cut/plan.js';
import { renderCut } from '../cut/render-cut.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { matteVideo } from '../matting/rvm.js';
import { extractWav16k } from '../media/extract-audio.js';
import { probe, type MediaInfo } from '../media/probe.js';
import { projectRecorder, type ProjectFile, type ProjectPatch } from './project.js';

export type PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'background' | 'matte' | 'captions' | 'burn' | 'done';
export interface ProgressEvent { step: PipelineStep; message: string }
export interface PipelineArgs { input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; background?: BackgroundSpec; task?: TaskClient; onProgress?: (e: ProgressEvent) => void }
export interface PipelineResult { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[] }

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

/** 换背景：落地背景图 → 抠像合成到 person.mp4；返回之后要烧字幕的视频 */
async function replaceBackground(args: PipelineArgs, cut: string, complete: Complete): Promise<string> {
  if (!args.background) return cut;
  const bg = await resolveBackground(args.background, args.workDir, args.task);
  complete('background', `背景：${describeBackground(bg.spec)}`, { background: { spec: bg.spec, path: bg.path } });
  const person = join(args.workDir, 'person.mp4');
  const started = Date.now();
  const res = await matteVideo({ input: cut, output: person, backgroundPath: bg.path, cfg: args.cfg });
  const secs = Math.max((Date.now() - started) / 1000, 0.001);
  complete('matte', `抠像换背景完成 · ${res.frames} 帧 · ${(res.frames / secs).toFixed(1)} 帧/秒`, { subject: res.subject, artifacts: { person } });
  return person;
}

/** 剪切 → 换背景 → 字幕 → 烧录 */
async function produce(args: PipelineArgs, a: Analysis, complete: Complete): Promise<TimedCaption[]> {
  const { input, workDir, output, cfg, llm } = args;
  const cut = join(workDir, 'cut.mp4');
  await renderCut(input, a.plan.keep, cut, cfg);
  complete('render', '剪切完成', { artifacts: { cut } });
  const base = await replaceBackground(args, cut, complete);

  const polished = await polishCaptions(llm, a.transcript.tokens, keptIndices(a.transcript.tokens.length, a.cuts));
  const captions = timeCaptions(polished.lines, a.transcript.tokens, a.plan.keep);
  const ass = join(workDir, 'captions.ass');
  writeFileSync(ass, toAss(captions, a.media));
  complete('captions', `${captions.length} 行字幕 · ${polishSummary(polished)}`,
    { captionLines: polished.lines, captionsSource: polished.source, captions, artifacts: { ass } });

  await burnSubtitles(base, ass, output, cfg);
  complete('burn', '字幕已烧录', { artifacts: { output } });
  return captions;
}

/** 全流程；每步完成后增量写 project.json 并回调一次，供 P5 剪辑直播使用 */
export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
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
  const captions = await produce(args, analysis, complete);
  complete('done', args.output);
  return { output: args.output, projectPath, cuts: analysis.cuts, plan: analysis.plan, captions };
}
