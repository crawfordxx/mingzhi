import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Token, Transcript } from '../asr/types.js';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import type { AppConfig } from '../config.js';
import { canvasFor, layoutClips, type ClipLayout } from '../media/concat.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { mediaOf, type MediaDeps } from './media-deps.js';
import type { ProgressEvent } from './run.js';
import { fmtSec } from './stages.js';

/** 排序只要看几段文字、输出几个数字，用已有价格表里的快模型即可 */
export const ORDER_MODEL = 'google/gemini-3.5-flash';
/** 每段文字交给模型的字数上限：超过时保留开头和结尾（排序看的是开场与收尾） */
const MAX_CHARS = 600;
const HEAD_CHARS = 400;

const SYSTEM_PROMPT = `你是口播内容编排助手。用户一次上传了多段口播（编号从 0 开始），要拼成一条完整的短视频。请按语义决定最合适的播放顺序：开场与钩子在前，铺垫、论点、案例按逻辑递进，总结与行动号召在最后；有明显承接或“接上一段”“前面说过”之类线索时以它为准。没有明显先后时保持上传顺序。
只输出 JSON：{"order":[…]}。order 是 0 到 n-1 每个编号恰好出现一次的排列。`;

function clip(text: string): string {
  const chars = [...text];
  if (chars.length === 0) return '（没有识别出文字）';
  if (chars.length <= MAX_CHARS) return text;
  return `${chars.slice(0, HEAD_CHARS).join('')}……${chars.slice(-(MAX_CHARS - HEAD_CHARS)).join('')}`;
}

function isPermutation(value: unknown, n: number): value is number[] {
  return Array.isArray(value) && value.length === n && value.every((x) => Number.isInteger(x) && x >= 0 && x < n) && new Set(value).size === n;
}

export interface OrderDecision { order: number[]; /** 模型请求失败或输出不是合法排列，已按上传顺序 */ failed: boolean }

/**
 * 让模型按语义给多段口播排序；failed 表示降级为上传顺序（请求失败或输出不是合法排列），
 * 与「模型认为顺序不用动」区分开。单段不调模型。余额不足与取消照常外抛。
 */
export async function decideOrder(client: LlmClient, transcripts: string[]): Promise<OrderDecision> {
  const identity = transcripts.map((_, i) => i);
  if (transcripts.length < 2) return { order: identity, failed: false };
  const user = transcripts.map((t, i) => `【段${i}】\n${clip(t)}`).join('\n\n');
  try {
    const raw = await client.chatJson({ model: ORDER_MODEL, reasoningEffort: 'low', system: SYSTEM_PROMPT, user, label: '段落排序' });
    const order = typeof raw === 'object' && raw !== null ? (raw as { order?: unknown }).order : undefined;
    return isPermutation(order, transcripts.length) ? { order, failed: false } : { order: identity, failed: true };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { order: identity, failed: true };
  }
}

/** 返回 0..n-1 的排列；单段不调模型，模型输出不合法或请求失败时保持上传顺序 */
export async function orderSegments(client: LlmClient, transcripts: string[]): Promise<number[]> {
  return (await decideOrder(client, transcripts)).order;
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 各段识别结果（已按播放顺序）按合成原片里的起点平移后合成一份 */
export function mergeTranscripts(parts: Transcript[], layout: ClipLayout): Transcript {
  const shift = (i: number, t: number): number => round3(t + layout.offsets[i]);
  const tokens = parts.flatMap((p, i): Token[] => p.tokens.map((t) => ({ ...t, start: shift(i, t.start), end: shift(i, t.end) })));
  const segments = parts.flatMap((p, i) => p.segments.map((s) => ({ start: shift(i, s.start), end: shift(i, s.end) })));
  return { durationSec: layout.totalSec, segments, tokens };
}

/** 播放顺序的一句话说明，例如「第 2 段 → 第 1 段 → 第 3 段」 */
export const describeOrder = (order: number[]): string => order.map((i) => `第 ${i + 1} 段`).join(' → ');

/** 输入文件指纹：路径 + 大小 + 修改时间；任何一段换了，之前的排序和合成原片都不再适用 */
interface InputPrint { path: string; size: number; mtimeMs: number }
interface SavedOrder { inputs: InputPrint[]; order: number[] }

const printOf = (path: string): InputPrint => {
  const st = statSync(path);
  return { path, size: st.size, mtimeMs: st.mtimeMs };
};

/** 上次保存的排序；输入文件与上次完全一致、且是合法排列才返回 */
function readSavedOrder(file: string, inputs: string[]): number[] | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const saved = JSON.parse(readFileSync(file, 'utf8')) as SavedOrder;
    const same = Array.isArray(saved.inputs) && saved.inputs.length === inputs.length
      && saved.inputs.every((p, i) => JSON.stringify(p) === JSON.stringify(printOf(inputs[i])));
    return same && isPermutation(saved.order, inputs.length) ? saved.order : undefined;
  } catch {
    return undefined;
  }
}

function writeSavedOrder(file: string, inputs: string[], order: number[]): void {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify({ inputs: inputs.map(printOf), order } satisfies SavedOrder, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 进程被硬杀时 concatSources 留下的临时文件 */
function removeStaleConcatTemps(dir: string): void {
  for (const name of readdirSync(dir)) if (/^\.source\.[0-9a-f]+\.(mp4|filter\.txt)$/.test(name)) rmSync(join(dir, name), { force: true });
}

export interface MultiSourceOptions {
  inputs: string[];
  /** 合成原片输出路径；排序结果存在同目录的 order.json */
  output: string;
  /** 放每段临时 wav 的目录 */
  tmpDir: string;
  cfg: AppConfig;
  llm: LlmClient;
  media?: Partial<MediaDeps>;
  signal?: AbortSignal;
  emit: (e: ProgressEvent) => void;
  /** 合成原片要重拼（顺序或输入变了，或还没有）时、动手之前调用：依赖旧合成原片的产物（抠像图层、分析结果）在这里清掉 */
  beforeRebuild?: () => void;
}

export interface MultiSource { transcript: Transcript; order: number[] }

/**
 * 多段口播 → 一条合成原片：逐段识别 → 模型按语义排序 → 按顺序统一参数拼接（9:16 画布、居中裁切铺满、段间 0.3 秒静音）。
 * 排序结果连同输入文件指纹存 order.json：重试时输入没变就沿用它，不再调模型，合成原片也不重拼，已有的抠像图层仍然对得上。
 * 返回合成原片的识别结果（各段结果按偏移拼好，不对合成原片重新识别）；之后整个流程把合成原片当作单段原片。
 */
export async function prepareMultiSource(o: MultiSourceOptions): Promise<MultiSource> {
  const m = mediaOf(o.media);
  const n = o.inputs.length;
  const orderFile = join(dirname(o.output), 'order.json');
  const clips: { path: string; durationSec: number; width: number; height: number; transcript: Transcript }[] = [];
  for (const [i, path] of o.inputs.entries()) {
    throwIfCancelled(o.signal);
    const info = await m.probe(path, o.cfg);
    if (!info.hasAudio) throw new Error(`第 ${i + 1} 段没有音轨，无法识别口播`);
    const wav = join(o.tmpDir, `segment-${i}.wav`);
    try {
      await m.extractWav(path, wav, o.cfg);
      clips.push({ path, durationSec: info.durationSec, width: info.width, height: info.height, transcript: m.transcribe(wav, o.cfg.modelsDir) });
    } finally {
      rmSync(wav, { force: true });
    }
    o.emit({ step: 'asr', message: `识别第 ${i + 1}/${n} 段：${clips[i].transcript.tokens.length} 字 · ${fmtSec(info.durationSec)}` });
  }

  throwIfCancelled(o.signal);
  const saved = readSavedOrder(orderFile, o.inputs);
  const reuse = saved !== undefined && existsSync(o.output);
  let order: number[];
  if (saved) {
    order = saved;
    o.emit({ step: 'asr', message: `沿用上次的段落顺序：${describeOrder(order)}` });
  } else {
    const decision = await decideOrder(o.llm, clips.map((c) => c.transcript.tokens.map((t) => t.text).join('')));
    order = decision.order;
    const note = decision.failed ? '排序失败，按上传顺序拼接：' : '按语义重排：';
    o.emit({ step: 'asr', message: `${note}${describeOrder(order)}${!decision.failed && order.every((v, i) => v === i) ? '（与上传顺序一致）' : ''}` });
  }

  const ordered = order.map((i) => clips[i]);
  const layout = layoutClips(ordered.map((c) => c.durationSec));
  if (!reuse) {
    rmSync(orderFile, { force: true });
    o.beforeRebuild?.();
    removeStaleConcatTemps(dirname(o.output));
    await m.concat({
      clips: ordered, ...canvasFor(ordered), output: o.output, cfg: o.cfg, signal: o.signal,
      onSegment: (index, total) => o.emit({ step: 'probe', message: `拼接第 ${index + 1}/${total} 段` }),
    });
    writeSavedOrder(orderFile, o.inputs, order);
  }
  o.emit({ step: 'probe', message: `已拼成一条合成原片（共 ${fmtSec(layout.totalSec)}，段间留 0.3 秒静音）` });
  return { transcript: mergeTranscripts(ordered.map((c) => c.transcript), layout), order };
}
