import { run } from '../media/exec.js';
import type { Size } from './crop.js';

/** 时间线帧率 */
const OUT_FPS = 30;
/** 视频产物帧数至少达到期望的 90%，时长误差不超过 0.2 秒 */
const MIN_FRAME_RATIO = 0.9;
const MAX_DURATION_ERROR = 0.2;

interface ProbeOut { streams?: { codec_type?: string; width?: number; height?: number; nb_read_packets?: string }[]; format?: { duration?: string } }

/**
 * 编码后、改名前校验产物：ffmpeg 退出码为 0 也可能一帧没编出来（输入端跳转越过稀疏关键帧、尾部损坏等）。
 * 视频（传 outSec）：有视频流、帧数 ≥ 时长×30×0.9、时长误差 ≤ 0.2 秒；图片/视频（传 size）：尺寸一致。不合格抛错。
 */
export async function verifyOutput(ffprobe: string, file: string, expect: { outSec?: number; size?: Size }): Promise<void> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-count_packets', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const json = JSON.parse(stdout) as ProbeOut;
  const v = json.streams?.find((s) => s.codec_type === 'video');
  if (!v) throw new Error('输出为空：产物里没有视频流');
  if (expect.size && (v.width !== expect.size.width || v.height !== expect.size.height)) {
    throw new Error(`输出尺寸不符：期望 ${expect.size.width}×${expect.size.height}，实际 ${v.width}×${v.height}`);
  }
  if (expect.outSec === undefined) return;
  const frames = Number(v.nb_read_packets ?? 0);
  const need = Math.floor(expect.outSec * OUT_FPS * MIN_FRAME_RATIO);
  if (!(frames >= need)) throw new Error(`输出帧数不足：${frames} 帧，至少应有 ${need} 帧`);
  const duration = Number(json.format?.duration);
  if (!(Math.abs(duration - expect.outSec) <= MAX_DURATION_ERROR)) throw new Error(`输出时长不符：${duration} 秒，期望 ${expect.outSec} 秒`);
}
