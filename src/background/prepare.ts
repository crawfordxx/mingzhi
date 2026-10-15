import type { AppConfig } from '../config.js';
import { runBuffer } from '../media/exec.js';

/** 背景图缩放铺满（保持比例、居中裁切）到视频尺寸，blurSigma>0 时做高斯虚化；返回 rgb24 原始像素 */
export async function loadBackgroundRgb(path: string, width: number, height: number, blurSigma: number, cfg: AppConfig): Promise<Buffer> {
  const filters = [`scale=${width}:${height}:force_original_aspect_ratio=increase`, `crop=${width}:${height}`, ...(blurSigma > 0 ? [`gblur=sigma=${blurSigma}`] : [])];
  const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', path, '-vf', filters.join(','), '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (buf.length !== width * height * 3) throw new Error(`背景图处理结果尺寸不对：${buf.length} 字节`);
  return buf;
}
