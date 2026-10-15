import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';

export const THUMB_WIDTH = 320;

/** 用 ffmpeg 把大图缩到 320 宽；先写临时文件再改名，缓存里不会留半截图 */
export async function makeBackgroundThumb(cfg: AppConfig, src: string, dest: string): Promise<void> {
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp.jpg`;
  try {
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', src, '-vf', `scale=${THUMB_WIDTH}:-2`, '-frames:v', '1', '-q:v', '4', tmp]);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}
