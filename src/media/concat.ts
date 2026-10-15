import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import { FPS } from '../cut/plan.js';
import { run } from './exec.js';

/** 段与段之间的静音缓冲（帧数）：0.3 秒，避免剪口误时把两段说话连成一口气 */
export const GAP_FRAMES = Math.round(0.3 * FPS);
/** 合成原片统一的音频采样率与每帧采样数（48000 / 30，整数，所以按帧裁剪音频不会有余数） */
const AUDIO_RATE = 48000;
const SAMPLES_PER_FRAME = AUDIO_RATE / FPS;

export interface SourceClip { path: string; durationSec: number }
export interface ClipLayout {
  /** 每段在合成原片里占的帧数：自身帧数 + 缓冲（最后一段没有缓冲） */
  frames: number[];
  /** 每段在合成原片里的起点（秒，落在 1/30 秒帧网格上） */
  offsets: number[];
  totalSec: number;
}

/** 各段时长 → 合成原片里的帧数、起点与总时长；识别结果的时间偏移用同一份布局，保证与画面逐帧对齐 */
export function layoutClips(durations: number[]): ClipLayout {
  const frames = durations.map((d, i) => Math.max(1, Math.round(d * FPS)) + (i < durations.length - 1 ? GAP_FRAMES : 0));
  const offsets = frames.map((_, i) => frames.slice(0, i).reduce((s, f) => s + f, 0) / FPS);
  return { frames, offsets, totalSec: frames.reduce((s, f) => s + f, 0) / FPS };
}

/**
 * 滤镜：每段视频归一为 30fps（兼容可变帧率）、等比缩放并居中补黑边到统一画幅，末帧定格补足缓冲，再按帧数裁齐；
 * 音频统一 48k 立体声，后面补静音再按采样数裁齐。每段音视频等长，concat 之后不会漂移。
 */
export function buildConcatFilter(frames: number[], size: { width: number; height: number }): string {
  const { width: w, height: h } = size;
  const parts = frames.map((n, i) => {
    const video = `[${i}:v]fps=${FPS}:start_time=0,scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,setsar=1,tpad=stop_mode=clone:stop_duration=${GAP_FRAMES / FPS + 1},trim=end_frame=${n},setpts=PTS-STARTPTS[v${i}]`;
    const audio = `[${i}:a]aresample=${AUDIO_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad,atrim=end_sample=${n * SAMPLES_PER_FRAME},asetpts=PTS-STARTPTS[a${i}]`;
    return `${video};${audio}`;
  });
  const inputs = frames.map((_, i) => `[v${i}][a${i}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${frames.length}:v=1:a=1[outv][outa]`;
}

export interface ConcatOptions {
  clips: SourceClip[];
  width: number;
  height: number;
  output: string;
  cfg: AppConfig;
  signal?: AbortSignal;
}

/** 把多段口播按顺序拼成一条统一参数的合成原片（先写临时文件再改名，失败或取消不留半成品） */
export async function concatSources(o: ConcatOptions): Promise<void> {
  if (o.clips.length === 0) throw new Error('没有可拼接的口播');
  const tmp = join(dirname(o.output), `.${basename(o.output, extname(o.output))}.${randomUUID().slice(0, 8)}.mp4`);
  const filterPath = `${tmp.slice(0, -extname(tmp).length)}.filter.txt`;
  const { frames } = layoutClips(o.clips.map((c) => c.durationSec));
  // 滤镜串写到文件：段数多时会超过 Windows 命令行长度上限
  writeFileSync(filterPath, buildConcatFilter(frames, { width: o.width, height: o.height }));
  try {
    await run(o.cfg.ffmpeg, [
      '-v', 'error', '-y', ...o.clips.flatMap((c) => ['-i', c.path]),
      '-/filter_complex', filterPath, '-map', '[outv]', '-map', '[outa]',
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', tmp,
    ], { signal: o.signal });
    renameSync(tmp, o.output);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(filterPath, { force: true });
  }
}
