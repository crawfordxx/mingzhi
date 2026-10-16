import { basename, dirname, resolve } from 'node:path';
import { PROJECT_LUT } from '../broll/process.js';
import { runBuffer } from '../media/exec.js';
import type { Rgb } from './color.js';
import { paletteFor, type Palette } from './palette.js';

/** 取样小图尺寸：32×18 足够看出主色与点缀色，ffmpeg 按面积平均缩小 */
const GRID = { w: 32, h: 18 } as const;

/**
 * 人物背景（背景图，或没换背景时的人像视频）第一帧套项目 LUT（与 B-roll 同一影调）后缩成 32×18 的像素（0–1）。
 * ffmpeg 以 LUT 所在目录为工作目录、滤镜里只写文件名（与素材加工一致，避开 Windows 盘符转义）
 */
export async function backdropPixels(ffmpeg: string, file: string, lut: string = PROJECT_LUT): Promise<Rgb[]> {
  const vf = `lut3d=file=${basename(lut)}:interp=tetrahedral,scale=${GRID.w}:${GRID.h}:flags=area`;
  const buf = await runBuffer(ffmpeg, ['-v', 'error', '-i', resolve(file), '-vf', vf, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { cwd: dirname(resolve(lut)) });
  if (buf.length < 3) throw new Error('取背景颜色时没读到画面');
  return Array.from({ length: Math.floor(buf.length / 3) }, (_, i) => ({ r: buf[i * 3] / 255, g: buf[i * 3 + 1] / 255, b: buf[i * 3 + 2] / 255 }));
}

/** 背景 → 片色 */
export async function samplePalette(ffmpeg: string, file: string): Promise<Palette> {
  return paletteFor(await backdropPixels(ffmpeg, file));
}
