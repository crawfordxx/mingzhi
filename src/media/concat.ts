import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { CancelledError } from '../cancel.js';
import type { AppConfig } from '../config.js';
import { FPS } from '../cut/plan.js';

/** 段与段之间的静音缓冲（帧数）：0.3 秒，避免剪口误时把两段说话连成一口气 */
export const GAP_FRAMES = Math.round(0.3 * FPS);
/** 合成原片统一的音频采样率与每帧采样数（48000 / 30，整数，所以按帧裁剪音频不会有余数） */
const AUDIO_RATE = 48000;
const SAMPLES_PER_FRAME = AUDIO_RATE / FPS;
/** 全是横屏时的默认画布 */
const DEFAULT_CANVAS = { width: 1080, height: 1920 };

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

const even = (v: number): number => Math.max(2, Math.floor(v / 2) * 2);

/**
 * 合成原片的画布：固定 9:16 竖屏。宽取各竖屏段显示宽度的最大值（偶数），高按 16/9 推出；一段竖屏都没有时用 1080×1920。
 * sizes 是各段的显示宽高（已处理旋转标记）。
 */
export function canvasFor(sizes: { width: number; height: number }[]): { width: number; height: number } {
  const portrait = sizes.filter((s) => s.height > s.width);
  if (portrait.length === 0) return DEFAULT_CANVAS;
  const width = even(Math.max(...portrait.map((s) => s.width)));
  return { width, height: even(Math.round((width * 16) / 9)) };
}

/**
 * 滤镜：每段视频归一为 30fps（兼容可变帧率）、等比放大到刚好盖满画布再居中裁切（不补黑边），末帧定格补足缓冲，再按帧数裁齐；
 * 音频统一 48k 立体声，后面补静音再按采样数裁齐。每段音视频等长，concat 之后不会漂移。
 */
export function buildConcatFilter(frames: number[], size: { width: number; height: number }): string {
  const { width: w, height: h } = size;
  const parts = frames.map((n, i) => {
    const video = `[${i}:v]fps=${FPS}:start_time=0,scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1,tpad=stop_mode=clone:stop_duration=${GAP_FRAMES / FPS + 1},trim=end_frame=${n},setpts=PTS-STARTPTS[v${i}]`;
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
  /** 编码进度：正在拼第 index 段（从 0 起），换段时回调一次 */
  onSegment?: (index: number, total: number) => void;
}

/** ffmpeg 报错里最后几行才是真正原因 */
const failureReason = (stderr: string): string => stderr.trim().split('\n').filter(Boolean).slice(-3).join(' | ').slice(-400);

/** 运行 ffmpeg 并从 -progress 输出读已编码到的时间；取消时结束子进程并抛 CancelledError，失败抛中文错误并附关键原因 */
function runEncode(ffmpeg: string, args: string[], signal: AbortSignal | undefined, onTime: (sec: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], signal });
    let stderr = '';
    let buffered = '';
    child.stdout.on('data', (chunk: Buffer) => {
      buffered += chunk.toString();
      const lines = buffered.split('\n');
      buffered = lines.pop() ?? '';
      for (const line of lines) {
        const m = /^out_time_us=(\d+)/.exec(line);
        if (m) onTime(Number(m[1]) / 1e6);
      }
    });
    child.stderr.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-4000); });
    child.on('error', (err) => {
      if (signal?.aborted) reject(new CancelledError());
      else reject(new Error(`拼接多段口播失败：无法运行 ffmpeg（${err.message}）`));
    });
    child.on('close', (code) => {
      if (signal?.aborted) reject(new CancelledError());
      else if (code === 0) resolve();
      else reject(new Error(`拼接多段口播失败（ffmpeg 退出码 ${code}）：${failureReason(stderr) || '没有错误输出'}`));
    });
  });
}

/** 把多段口播按顺序拼成一条统一参数的合成原片（先写临时文件再改名，失败或取消不留半成品） */
export async function concatSources(o: ConcatOptions): Promise<void> {
  if (o.clips.length === 0) throw new Error('没有可拼接的口播');
  const tmp = join(dirname(o.output), `.${basename(o.output, extname(o.output))}.${randomUUID().slice(0, 8)}.mp4`);
  const filterPath = `${tmp.slice(0, -extname(tmp).length)}.filter.txt`;
  const layout = layoutClips(o.clips.map((c) => c.durationSec));
  let current = -1;
  const report = (sec: number): void => {
    const index = layout.offsets.reduce((found, off, i) => (off <= sec + 1e-6 ? i : found), 0);
    if (index === current) return;
    current = index;
    o.onSegment?.(index, o.clips.length);
  };
  try {
    // 滤镜串写到文件：段数多时会超过 Windows 命令行长度上限
    writeFileSync(filterPath, buildConcatFilter(layout.frames, { width: o.width, height: o.height }));
    report(0);
    await runEncode(o.cfg.ffmpeg, [
      '-v', 'error', '-y', '-nostats', '-progress', 'pipe:1', ...o.clips.flatMap((c) => ['-i', c.path]),
      '-/filter_complex', filterPath, '-map', '[outv]', '-map', '[outa]',
      '-r', String(FPS), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '16', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', '192k', tmp,
    ], o.signal, report);
    renameSync(tmp, o.output);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(filterPath, { force: true });
  }
}
