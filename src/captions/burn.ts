import { basename, dirname, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';

export async function burnSubtitles(input: string, assPath: string, output: string, cfg: AppConfig): Promise<void> {
  // 在 ASS 所在目录里运行并只传文件名，避免把用户路径写进滤镜串（其中 ' , ; [ ] = : \ 都会解析出错）
  await run(cfg.ffmpeg, [
    '-v', 'error', '-y', '-i', resolve(input),
    '-vf', `ass=${basename(assPath)}`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', resolve(output),
  ], { cwd: dirname(resolve(assPath)) });
}
