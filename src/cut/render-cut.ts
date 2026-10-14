import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';
import { FPS, type TimeRange } from './plan.js';

/** 保留 6 位小数：区间边界在 1/30 秒帧网格上，ffmpeg 按微秒换算后正好落在帧/采样上 */
const fmt = (n: number): string => String(Math.round(n * 1e6) / 1e6);

/** 视频先 fps=30 归一化（兼容可变帧率）再 trim；音频先 apad 补静音（音轨比画面短时也等长）再 atrim，并做极短淡入淡出（防止剪切点爆音）；最后按顺序 concat */
export function buildCutFilter(keep: TimeRange[], fadeSec = 0.02): string {
  if (keep.length === 0) throw new Error('没有可保留的片段，无法渲染');
  const parts = keep.map((r, i) => {
    const dur = r.end - r.start;
    const video = `[0:v]fps=${FPS},trim=start=${fmt(r.start)}:end=${fmt(r.end)},setpts=PTS-STARTPTS[v${i}]`;
    const audio = `[0:a]apad,atrim=start=${fmt(r.start)}:end=${fmt(r.end)},asetpts=PTS-STARTPTS,afade=t=in:st=0:d=${fadeSec},afade=t=out:st=${fmt(dur - fadeSec)}:d=${fadeSec}[a${i}]`;
    return `${video};${audio}`;
  });
  const inputs = keep.map((_, i) => `[v${i}][a${i}]`).join('');
  return `${parts.join(';')};${inputs}concat=n=${keep.length}:v=1:a=1[outv][outa]`;
}

export async function renderCut(input: string, keep: TimeRange[], output: string, cfg: AppConfig): Promise<void> {
  await run(cfg.ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-filter_complex', buildCutFilter(keep),
    '-map', '[outv]', '-map', '[outa]',
    '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', output,
  ]);
}
