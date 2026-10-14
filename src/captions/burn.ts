import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';

/** ffmpeg 滤镜参数里 \ : ' 都有特殊含义，需要转义 */
export function escapeFilterPath(p: string): string {
  return p.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

export async function burnSubtitles(input: string, assPath: string, output: string, cfg: AppConfig): Promise<void> {
  await run(cfg.ffmpeg, [
    '-v', 'error', '-y', '-i', input,
    '-vf', `ass=${escapeFilterPath(assPath)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', output,
  ]);
}
