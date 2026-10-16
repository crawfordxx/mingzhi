import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../media/exec.js';
import type { Candidate } from './sources/types.js';

export const SHEET_COLS = 3;
export const SHEET_MAX = 9;
/** 单格边长：3 列正好 1536 宽 */
export const CELL = 512;
const LETTERBOX = '0x808080';
const BLANK = '0x404040';
const BADGE = { x: CELL - 92, y: 8, w: 84, h: 116, bg: '0xFFD60A', fg: 'black' } as const;
/** 七段数码管的粗细与数字区大小（在角标内留边） */
const DIGIT = { dx: 16, dy: 14, w: 52, h: 88, t: 11 } as const;
const VIDEO_EXT = /\.(mp4|webm|mov|ogv|m4v|mkv)(\?.*)?$/i;
const HTTP = /^https?:\/\//i;
/** ffmpeg 读远程视频的网络超时（微秒） */
const NET_TIMEOUT_US = '30000000';
const DOWNLOAD_TIMEOUT_MS = 30_000;

export interface SheetOptions {
  fetchImpl?: typeof fetch;
  /** 每个候选的静帧缓存目录（去重算哈希复用同一批图）；缺省为联系表所在目录下的 stills */
  stillsDir?: string;
}

/** contactSheet 缺省的静帧目录：联系表同目录下的 stills */
export const defaultStillsDir = (out: string): string => join(dirname(out), 'stills');

/** 七段 a-g 对应的矩形（相对数字区） */
function segmentBox(seg: string): { x: number; y: number; w: number; h: number } {
  const { w, h, t } = DIGIT;
  const half = Math.floor(h / 2);
  const boxes: Record<string, { x: number; y: number; w: number; h: number }> = {
    a: { x: 0, y: 0, w, h: t },
    b: { x: w - t, y: 0, w: t, h: half + Math.ceil(t / 2) },
    c: { x: w - t, y: half - Math.floor(t / 2), w: t, h: half + Math.ceil(t / 2) },
    d: { x: 0, y: h - t, w, h: t },
    e: { x: 0, y: half - Math.floor(t / 2), w: t, h: half + Math.ceil(t / 2) },
    f: { x: 0, y: 0, w: t, h: half + Math.ceil(t / 2) },
    g: { x: 0, y: half - Math.floor(t / 2), w, h: t },
  };
  return boxes[seg];
}

const SEGMENTS = ['', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgecd', 'abc', 'abcdefg', 'abcdfg'];

/** 角标的 drawbox 滤镜串：亮黄底 + 黑色数码管数字。不依赖字体（ffmpeg 常不带 drawtext），底色高对比，缩略后仍能读 */
export function badgeFilter(digit: number): string {
  const box = (x: number, y: number, w: number, h: number, color: string): string => `drawbox=x=${x}:y=${y}:w=${w}:h=${h}:color=${color}:t=fill`;
  const segs = [...SEGMENTS[digit]].map((s) => {
    const b = segmentBox(s);
    return box(BADGE.x + DIGIT.dx + b.x, BADGE.y + DIGIT.dy + b.y, b.w, b.h, BADGE.fg);
  });
  return [box(BADGE.x, BADGE.y, BADGE.w, BADGE.h, BADGE.bg), ...segs].join(',');
}

const isVideoFile = (path: string): boolean => VIDEO_EXT.test(path);
const stillName = (id: string): string => createHash('sha1').update(id).digest('hex').slice(0, 16);

async function download(url: string, dest: string, fetchImpl: typeof fetch): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`预览图下载失败 ${res.status}：${url}`);
  const tmp = `${dest}.tmp`;
  writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  renameSync(tmp, dest);
}

/** 从视频的中间位置抽一帧（远程视频走 ffmpeg 自带的范围请求，不下载整段） */
async function middleFrame(video: string, durationSec: number | undefined, dest: string, ffmpeg: string): Promise<void> {
  const at = durationSec && durationSec > 0 ? durationSec / 2 : 0;
  const net = HTTP.test(video) ? ['-rw_timeout', NET_TIMEOUT_US] : [];
  const tmp = `${dest}.tmp.jpg`;
  try {
    await run(ffmpeg, ['-v', 'error', '-y', ...net, '-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '3', tmp]);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 取候选的一张静帧本地路径（缓存在 dir 里）：优先来源给的预览图，远程的下载、本地的直接用；
 * 没有预览图（或预览图本身是视频）的视频抽中间帧。取不到时抛错
 */
export async function stillOf(c: Candidate, dir: string, ffmpeg: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${stillName(c.id)}.jpg`);
  if (existsSync(dest)) return dest;
  const preview = c.thumb.trim();
  if (preview && !isVideoFile(preview)) {
    if (!HTTP.test(preview)) {
      if (!existsSync(preview)) throw new Error(`预览图不存在：${preview}`);
      return preview;
    }
    await download(preview, dest, fetchImpl);
    return dest;
  }
  if (c.kind === 'video' || isVideoFile(preview)) {
    await middleFrame(preview || c.url, c.durationSec, dest, ffmpeg);
    return dest;
  }
  await download(c.url, dest, fetchImpl);
  return dest;
}

/** 一格的滤镜：保持原比例缩进正方形格（灰底 letterbox），右上角标序号 */
function cellFilter(i: number): string {
  const fit = `scale=${CELL}:${CELL}:force_original_aspect_ratio=decrease,format=rgba,pad=${CELL}:${CELL}:(ow-iw)/2:(oh-ih)/2:color=${LETTERBOX}`;
  return `[${i}:v]${fit},${badgeFilter(i + 1)}[c${i}]`;
}

function layoutOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `${(i % SHEET_COLS) * CELL}_${Math.floor(i / SHEET_COLS) * CELL}`).join('|');
}

/**
 * 最多 9 个候选拼成 3×3 联系表（每格 512，总宽 ≤ 1536），格内按原比例居中、右上角标 1-9 的序号。
 * 单格取图失败时该格留空白（序号仍在），模型会给低分；全部候选都为空时抛错
 */
export async function contactSheet(candidates: Candidate[], out: string, ffmpeg: string, opts: SheetOptions = {}): Promise<string> {
  const picked = candidates.slice(0, SHEET_MAX);
  if (picked.length === 0) throw new Error('没有候选可拼联系表');
  const stillsDir = opts.stillsDir ?? defaultStillsDir(out);
  const stills = await Promise.all(picked.map((c) => stillOf(c, stillsDir, ffmpeg, opts.fetchImpl).catch(() => undefined)));
  const inputs = stills.flatMap((f) => (f ? ['-i', f] : ['-f', 'lavfi', '-i', `color=c=${BLANK}:s=${CELL}x${CELL}`]));
  const cells = picked.map((_, i) => cellFilter(i)).join(';');
  const stack = picked.length === 1 ? '[c0]null[sheet]' : `${picked.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${picked.length}:layout=${layoutOf(picked.length)}:fill=${LETTERBOX}[sheet]`;
  const quality = /\.jpe?g$/i.test(out) ? ['-q:v', '3'] : [];
  mkdirSync(dirname(out), { recursive: true });
  await run(ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', `${cells};${stack};[sheet]format=rgb24[final]`, '-map', '[final]', '-frames:v', '1', ...quality, out]);
  return out;
}
