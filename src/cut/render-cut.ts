import { writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';
import { FPS, type TimeRange } from './plan.js';

/** 保留 6 位小数：区间边界在 1/30 秒帧网格上，ffmpeg 按微秒换算后正好落在帧/采样上 */
const fmt = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/**
 * 单段视频取帧串：fps=30 归一化（兼容可变帧率；start_time=0 让帧网格从文件起点 0 秒开始，视频流晚于音轨开始时开头补首帧，
 * 与命令行解码输出的恒定帧率序列一致，音画也对齐）→ 宽高取偶（yuv420p 要求偶数）→ trim → 重置时间戳。
 * 剪切与工作台从整条抠像图层取帧都用它，保证两边选中的是同一批帧。
 */
export function videoSegment(input: string, r: TimeRange, label: string): string {
  return `[${input}]fps=${FPS}:start_time=0,scale=trunc(iw/2)*2:trunc(ih/2)*2,trim=start=${fmt(r.start)}:end=${fmt(r.end)},setpts=PTS-STARTPTS[${label}]`;
}

/** 视频按 videoSegment 取帧；音频先 apad 补静音（音轨比画面短时也等长）再 atrim，并做极短淡入淡出（防止剪切点爆音）；最后按顺序 concat */
export function buildCutFilter(keep: TimeRange[], fadeSec = 0.02): string {
  if (keep.length === 0) throw new Error('没有可保留的片段，无法渲染');
  const parts = keep.map((r, i) => {
    const dur = r.end - r.start;
    const video = videoSegment('0:v', r, `v${i}`);
    const audio = `[0:a]apad,atrim=start=${fmt(r.start)}:end=${fmt(r.end)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fmt(dur - fadeSec)}:d=${fadeSec}[a${i}]`;
    return `${video};${audio}`;
  });
  const inputs = keep.map((_, i) => `[v${i}][a${i}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${keep.length}:v=1:a=1[outv][outa]`;
}

/** 滤镜串写到输出同目录的 <输出名>.filter.txt，用 -/filter_complex 从文件读取：几十段剪切的滤镜串会超过 Windows 命令行长度上限 */
export async function renderCut(input: string, keep: TimeRange[], output: string, cfg: AppConfig): Promise<void> {
  const filterPath = join(dirname(output), `${basename(output, extname(output))}.filter.txt`);
  writeFileSync(filterPath, buildCutFilter(keep));
  await run(cfg.ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-/filter_complex', filterPath,
    '-map', '[outv]', '-map', '[outa]',
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', output,
  ]);
}
