import { rename, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import { finalVideoArgs } from '../media/encode.js';
import { run } from '../media/exec.js';
import { probe } from '../media/probe.js';
import { TAIL_MAX_LUFS, measureTailLufs, tailFrom } from '../qa/hard.js';

/** 成片响度目标：-14 LUFS 积分响度，真峰值 ≤ -1.5 dBTP，响度范围 11 LU */
export const TARGET = { I: -14, TP: -1.5, LRA: 11 } as const;

export interface LoudnormMeasure {
  input_i: number;
  input_tp: number;
  input_lra: number;
  input_thresh: number;
  target_offset: number;
}

const KEYS = ['input_i', 'input_tp', 'input_lra', 'input_thresh', 'target_offset'] as const;

/** ffmpeg JSON 里数值是字符串，静音时为 "-inf" / "inf" */
function toNumber(raw: unknown): number {
  const text = String(raw).trim().toLowerCase();
  if (text === '-inf') return -Infinity;
  if (text === 'inf') return Infinity;
  return Number(text);
}

/** 解析 loudnorm 在 stderr 打印的 JSON（取最后一个 {…} 块，ffmpeg 其他日志可能也含花括号） */
export function parseLoudnormJson(stderr: string): LoudnormMeasure {
  const blocks = stderr.match(/\{[^{}]*\}/g);
  const last = blocks?.[blocks.length - 1];
  if (!last) throw new Error('响度测量失败：ffmpeg 输出中没有 loudnorm 的 JSON 结果');
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(last) as Record<string, unknown>;
  } catch {
    throw new Error('响度测量失败：loudnorm 的 JSON 结果无法解析');
  }
  const pick = (key: (typeof KEYS)[number]): number => {
    const value = toNumber(parsed[key]);
    if (Number.isNaN(value)) throw new Error(`响度测量失败：loudnorm 结果缺少字段 ${key}`);
    return value;
  };
  return {
    input_i: pick('input_i'),
    input_tp: pick('input_tp'),
    input_lra: pick('input_lra'),
    input_thresh: pick('input_thresh'),
    target_offset: pick('target_offset'),
  };
}

/** 滤镜里的真峰值上限：比 TARGET.TP 低 0.3 dB，给 AAC 重编码的过冲留余量 */
const FILTER_TP = -1.8;
/** 验收：积分响度偏差超过 1 LU 或真峰值高于 -1.0 dBTP 就改用动态模式重做 */
const MAX_LUFS_DEVIATION = 1;
const MAX_TRUE_PEAK = -1.0;

/** 动态模式在尖峰+低底噪的信号上会让真峰值超标（实测可到 0 dBTP），后面再接限幅器兜底（-2 dBFS） */
const DYNAMIC_LIMITER = 'alimiter=limit=0.794:level=false';

const BASE_FILTER = `loudnorm=I=${TARGET.I}:TP=${FILTER_TP}:LRA=${TARGET.LRA}`;
const FASTSTART = ['-movflags', '+faststart'];

export interface LoudnessResult {
  before: number;
  after: number;
  /** 成片的真峰值（dBTP） */
  truePeak: number;
  mode: 'linear' | 'dynamic';
}

/** 只解码音轨跑一遍 loudnorm 并读出测量值 */
async function measure(input: string, filter: string, cfg: AppConfig): Promise<LoudnormMeasure> {
  const { stderr } = await run(cfg.ffmpeg, ['-hide_banner', '-nostats', '-i', input, '-vn', '-af', filter, '-f', 'null', '-']);
  return parseLoudnormJson(stderr);
}

/** 第二遍：视频按成片最终编码参数重编码（限制码率），音频按第一遍的测量值归一，写到 dest（调用方传临时文件） */
async function applyPass(input: string, dest: string, first: LoudnormMeasure, linear: boolean, cfg: AppConfig): Promise<void> {
  const filter =
    `${BASE_FILTER}:measured_I=${first.input_i}:measured_TP=${first.input_tp}:measured_LRA=${first.input_lra}` +
    `:measured_thresh=${first.input_thresh}:offset=${first.target_offset}:linear=${linear}:print_format=json${linear ? '' : `,${DYNAMIC_LIMITER}`}`;
  // 只映射第一路视频：流水线成片必有视频；纯音频输入不在支持范围
  await run(cfg.ffmpeg, [
    '-y', '-hide_banner', '-nostats', '-i', input, '-map', '0:v', '-map', '0:a:0',
    ...finalVideoArgs(), '-af', filter, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', ...FASTSTART, dest,
  ]);
}

function meetsTarget(m: LoudnormMeasure): boolean {
  return Math.abs(m.input_i - TARGET.I) <= MAX_LUFS_DEVIATION && m.input_tp <= MAX_TRUE_PEAK;
}

/** 全部通过且复测完成后才把临时文件改名为最终文件：任何一步失败都不会留下半成品 output */
async function normalizeInto(input: string, tmp: string, cfg: AppConfig): Promise<LoudnessResult> {
  const first = await measure(input, `${BASE_FILTER}:print_format=json`, cfg);
  if (!Number.isFinite(first.input_i)) {
    await run(cfg.ffmpeg, ['-y', '-hide_banner', '-i', input, ...finalVideoArgs(), '-c:a', 'copy', ...FASTSTART, '-f', 'mp4', tmp]);
    return { before: first.input_i, after: first.input_i, truePeak: first.input_tp, mode: 'linear' };
  }
  const verifyFilter = `${BASE_FILTER}:print_format=json`;
  await applyPass(input, tmp, first, true, cfg);
  let verify = await measure(tmp, verifyFilter, cfg);
  let mode: LoudnessResult['mode'] = 'linear';
  if (!meetsTarget(verify)) {
    await applyPass(input, tmp, first, false, cfg);
    verify = await measure(tmp, verifyFilter, cfg);
    mode = 'dynamic';
  }
  return { before: first.input_i, after: verify.input_i, truePeak: verify.input_tp, mode };
}

/**
 * 两遍 loudnorm 把音轨统一到 -14 LUFS：视频按 FINAL_ENCODE 重编码（crf + maxrate，成片体积在这里定下来），音频重编码为 AAC 192k/48kHz，输出带 faststart。
 * 先走 linear 模式；成片复测达不到目标（响度偏差 > 1 LU 或真峰值 > -1.0 dBTP）时，
 * 从原始输入改用动态模式（linear=false，并接限幅器）重做并再次复测，mode 报告最终采用的模式。
 * 静音音轨无法归一：音轨原样拷贝（视频同样重编码、faststart），before 与 after 均为 -Infinity。
 * 所有遍次与复测都写 `<output>.tmp.mp4`，最后才改名为 output；失败时 output 不会出现，临时文件被清掉。
 */
export async function normalizeLoudness(input: string, output: string, cfg: AppConfig): Promise<LoudnessResult> {
  if (resolve(input) === resolve(output)) throw new Error('输入与输出路径不能相同');
  if (!(await probe(input, cfg)).hasAudio) throw new Error('成片没有音轨，无法统一响度');
  const tmp = `${output}.tmp.mp4`;
  await rm(tmp, { force: true });
  try {
    const result = await normalizeInto(input, tmp, cfg);
    await rename(tmp, output);
    return result;
  } finally {
    await rm(tmp, { force: true });
  }
}

/** 衰减时多压的余量与片尾衰减的渐入时长（避免卡在 -18 边缘、避免衰减起点爆音） */
const TAIL_MARGIN_DB = 1;
const TAIL_RAMP_SEC = 0.4;
const TAIL_MAX_TRIES = 3;

export interface TailResult {
  /** 衰减前、后的片尾响度 */
  before: number;
  after: number;
  /** 片尾衰减的分贝数（0 表示没动） */
  attenuatedDb: number;
}

/**
 * 响度统一之后测成片最后 TAIL_SEC 秒（片尾更短时只测片尾，见 tailFrom），高于 TAIL_MAX_LUFS 就只对片尾（outroStartSec 起）做渐入式衰减，直到达标：
 * 口播不动；每次从衰减前的成片重新编码，最多 TAIL_MAX_TRIES 次，仍不达标则保留最后一次（after 如实返回）。
 * 成片没有音轨、或片尾没有声音（-70）时原样返回。durationSec 是成片时长
 */
export async function limitTailLoudness(video: string, durationSec: number, outroStartSec: number, cfg: AppConfig): Promise<TailResult> {
  const from = tailFrom(durationSec, outroStartSec);
  const before = await measureTailLufs(video, from, cfg);
  if (!(before > TAIL_MAX_LUFS)) return { before, after: before, attenuatedDb: 0 };
  const src = `${video}.pre-tail.mp4`;
  const tmp = `${video}.tail.mp4`;
  await rename(video, src);
  try {
    let db = before - TAIL_MAX_LUFS + TAIL_MARGIN_DB;
    let after = before;
    for (let i = 0; i < TAIL_MAX_TRIES; i += 1) {
      const gain = `if(lt(t,${outroStartSec}),1,pow(10,-${db.toFixed(2)}*min(1,(t-${outroStartSec})/${TAIL_RAMP_SEC})/20))`;
      await run(cfg.ffmpeg, ['-y', '-hide_banner', '-nostats', '-i', src, '-map', '0:v', '-map', '0:a:0', '-c:v', 'copy',
        '-af', `volume=eval=frame:volume='${gain}'`, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', '-movflags', '+faststart', tmp]);
      after = await measureTailLufs(tmp, from, cfg);
      if (after <= TAIL_MAX_LUFS) break;
      db += after - TAIL_MAX_LUFS + TAIL_MARGIN_DB;
    }
    await rename(tmp, video);
    return { before, after, attenuatedDb: db };
  } catch (err) {
    await rename(src, video).catch(() => undefined);
    throw err;
  } finally {
    await rm(src, { force: true });
    await rm(tmp, { force: true });
  }
}
