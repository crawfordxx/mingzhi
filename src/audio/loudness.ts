import { rename, copyFile } from 'node:fs/promises';
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';

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

const BASE_FILTER = `loudnorm=I=${TARGET.I}:TP=${TARGET.TP}:LRA=${TARGET.LRA}`;

/** 只解码音轨跑一遍 loudnorm 并读出测量值 */
async function measure(input: string, filter: string, cfg: AppConfig): Promise<LoudnormMeasure> {
  const { stderr } = await run(cfg.ffmpeg, ['-hide_banner', '-nostats', '-i', input, '-vn', '-af', filter, '-f', 'null', '-']);
  return parseLoudnormJson(stderr);
}

/**
 * 两遍 loudnorm 把音轨统一到 -14 LUFS：视频流直接拷贝，音频重编码为 AAC 192k/48kHz。
 * 返回 normalize 前后的积分响度（LUFS），after 由对成片的第三次测量得到。
 * 静音音轨无法归一：原样拷贝到 output，before 与 after 均为 -Infinity。
 */
export async function normalizeLoudness(input: string, output: string, cfg: AppConfig): Promise<{ before: number; after: number }> {
  const first = await measure(input, `${BASE_FILTER}:print_format=json`, cfg);
  if (!Number.isFinite(first.input_i)) {
    await copyFile(input, output);
    return { before: first.input_i, after: first.input_i };
  }
  const second =
    `${BASE_FILTER}:measured_I=${first.input_i}:measured_TP=${first.input_tp}:measured_LRA=${first.input_lra}` +
    `:measured_thresh=${first.input_thresh}:offset=${first.target_offset}:linear=true:print_format=json`;
  const tmp = `${output}.tmp.mp4`;
  await run(cfg.ffmpeg, [
    '-y', '-hide_banner', '-nostats', '-i', input, '-map', '0:v', '-map', '0:a:0',
    '-c:v', 'copy', '-af', second, '-c:a', 'aac', '-b:a', '192k', '-ar', '48000', tmp,
  ]);
  await rename(tmp, output);
  const verify = await measure(output, `${BASE_FILTER}:print_format=json`, cfg);
  return { before: first.input_i, after: verify.input_i };
}
