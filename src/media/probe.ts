import type { AppConfig } from '../config.js';
import { run } from './exec.js';

export interface MediaInfo {
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  hasAudio: boolean;
}

interface ProbeStream { codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }
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

export function parseProbe(json: unknown): MediaInfo {
  const data = json as ProbeJson;
  const streams = data.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  if (!video || !video.width || !video.height) throw new Error('输入文件没有视频流');
  return {
    durationSec: parseDuration(data.format?.duration, video.duration),
    width: video.width,
    height: video.height,
    fps: parseRate(video.r_frame_rate),
    hasAudio: streams.some((s) => s.codec_type === 'audio'),
  };
}

export async function probe(path: string, cfg: AppConfig): Promise<MediaInfo> {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', path]);
  return parseProbe(JSON.parse(stdout));
}
