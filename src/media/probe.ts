import type { AppConfig } from '../config.js';
import { run } from './exec.js';

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

interface ProbeStream {
  codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string;
  tags?: { rotate?: string };
  side_data_list?: { rotation?: number }[];
}
interface ProbeJson { format?: { duration?: string }; streams?: ProbeStream[] }

function parseRate(rate: string | undefined): number {
  const [num, den] = (rate ?? '30/1').split('/').map(Number);
  const fps = den ? num / den : num;
  return Math.round(fps * 100) / 100;
}

/** 优先用 format.duration；为 N/A 或缺失时回退视频流时长；都无效则报错 */
function parseDuration(format: string | undefined, stream: string | undefined): number {
  const sec = [format, stream].map(Number).find((n) => Number.isFinite(n) && n > 0);
  if (sec === undefined) throw new Error('无法读取视频时长');
  return sec;
}

/** 手机竖拍的视频常是横向编码 + 旋转标记；旋转 ±90/±270 时显示宽高与编码宽高互换 */
function isQuarterTurn(video: ProbeStream): boolean {
  const raw = video.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? Number(video.tags?.rotate ?? 0);
  const degrees = Number.isFinite(raw) ? Math.abs(Math.round(raw)) % 180 : 0;
  return degrees === 90;
}

export function parseProbe(json: unknown): MediaInfo {
  const data = json as ProbeJson;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) throw new Error('输入文件没有视频流');
  const swap = isQuarterTurn(video);
  return {
    durationSec: parseDuration(data.format?.duration, video.duration),
    width: swap ? video.height : video.width,
    height: swap ? video.width : video.height,
    fps: parseRate(video.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export async function probe(path: string, cfg: AppConfig): Promise<MediaInfo> {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path]);
  return parseProbe(JSON.parse(stdout));
}
