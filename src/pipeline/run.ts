import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import { transcribeWav } from '../asr/local-asr.js';
import { burnSubtitles } from '../captions/burn.js';
import { toAss } from '../captions/ass.js';
import { keptIndices, polishCaptions, timeCaptions, type TimedCaption } from '../captions/lines.js';
import { detectCuts, type Cut } from '../cut/llm-cuts.js';
import { buildEditPlan, cutsToRanges, type EditPlan } from '../cut/plan.js';
import { renderCut } from '../cut/render-cut.js';
import type { LlmClient } from '../llm/kexiang.js';
import { extractWav16k } from '../media/extract-audio.js';
import { probe } from '../media/probe.js';

export type PipelineStep = 'probe' | 'audio' | 'asr' | 'cuts' | 'plan' | 'render' | 'captions' | 'burn' | 'done';
export interface ProgressEvent { step: PipelineStep; message: string }
export interface PipelineArgs { input: string; workDir: string; output: string; cfg: AppConfig; llm: LlmClient; onProgress?: (e: ProgressEvent) => void }
export interface PipelineResult { output: string; projectPath: string; cuts: Cut[]; plan: EditPlan; captions: TimedCaption[] }

const fmtSec = (s: number): string => {
  const total = Math.round(s);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
};

/** 全流程：探测 → 抽音频 → 识别 → 剪口误 → 剪辑方案 → 剪切 → 字幕 → 烧录；每步回调一次，供 P5 剪辑直播使用 */
export async function runPipeline(args: PipelineArgs): Promise<PipelineResult> {
  const { input, workDir, output, cfg, llm } = args;
  const report = (step: PipelineStep, message: string): void => args.onProgress?.({ step, message });
  mkdirSync(workDir, { recursive: true });
  mkdirSync(dirname(output), { recursive: true });

  const media = await probe(input, cfg);
  if (!media.hasAudio) throw new Error('输入视频没有音轨，无法识别口播');
  report('probe', `${media.width}×${media.height} · ${fmtSec(media.durationSec)}`);

  const wav = join(workDir, 'audio16k.wav');
  await extractWav16k(input, wav, cfg);
  report('audio', '已抽取 16kHz 音频');

  const transcript = transcribeWav(wav, cfg.modelsDir);
  report('asr', `识别 ${transcript.tokens.length} 字 · ${transcript.segments.length} 个语音段`);

  const cuts = await detectCuts(llm, transcript.tokens);
  report('cuts', `标记 ${cuts.length} 处气口/重复/口误`);

  const plan = buildEditPlan(transcript.segments, cutsToRanges(cuts, transcript.tokens), media.durationSec);
  report('plan', `原片 ${fmtSec(media.durationSec)} → 成片 ${fmtSec(plan.outputDurationSec)}`);

  const cutPath = join(workDir, 'cut.mp4');
  await renderCut(input, plan.keep, cutPath, cfg);
  report('render', '剪切完成');

  const lines = await polishCaptions(llm, transcript.tokens, keptIndices(transcript.tokens.length, cuts));
  const captions = timeCaptions(lines, transcript.tokens, plan.keep);
  const assPath = join(workDir, 'captions.ass');
  writeFileSync(assPath, toAss(captions, media));
  report('captions', `${captions.length} 行字幕`);

  await burnSubtitles(cutPath, assPath, output, cfg);
  report('burn', '字幕已烧录');

  const projectPath = join(workDir, 'project.json');
  writeFileSync(projectPath, JSON.stringify({ version: 1, input, media, transcript, cuts, plan, captions, createdAt: new Date().toISOString() }, null, 2));
  report('done', output);
  return { output, projectPath, cuts, plan, captions };
}
