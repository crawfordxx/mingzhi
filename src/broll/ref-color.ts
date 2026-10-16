import { meanRgb } from '../matting/composite.js';
import { runBuffer } from '../media/exec.js';

/** 白平衡参考色：人物背景（背景图，或没换背景时的人像视频第一帧）整张缩成 1 像素的平均色（0–1，编码域），B-roll 加工向它微调 */
export async function referenceColor(ffmpeg: string, file: string): Promise<{ r: number; g: number; b: number }> {
  const buf = await runBuffer(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'scale=1:1:flags=area', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (buf.length < 3) throw new Error('量背景平均色时没读到画面');
  const [r, g, b] = meanRgb(buf);
  return { r, g, b };
}
