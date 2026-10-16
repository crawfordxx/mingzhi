/**
 * 整片抽帧度量（审片报告 docs/acceptance/p7-audit.md 第 1.1 节的口径，度量脚本 motion.py 的移植）：
 * 成片缩到 108×192 灰度、每秒 5 帧，只看上半屏（y < 84/192，卡片区，避开压在分界线上的字幕）。
 * - 静止：相邻两帧（0.2 秒）平均差 < 0.8，连续超过 3 秒记一个静止段
 * - 空白率（平坦块口径）：上半屏 6×6 像素块标准差 < 2.5 的比例（米色底、白卡内部、纯色背景都算平坦）
 * 分镜阶段的米色底口径（render/templates/coverage.ts 的 estimateBlank.stage）只用于生成期快速估计，验收以这里的平坦块口径为准
 */
import { runBuffer } from '../media/exec.js';
import { throwIfCancelled } from '../cancel.js';

export const GRID = { fps: 5, width: 108, height: 192, topRows: 84, block: 6 } as const;
/** 相邻帧平均差小于它算「没动」 */
export const STILL_DIFF = 0.8;
/** 连续没动超过它记一个静止段（秒） */
export const STATIC_MIN_SEC = 3;
/** 6×6 块的标准差小于它算平坦 */
export const FLAT_STD = 2.5;
/** 空白率按这么长的滑动窗口平均后判「任何时刻」（秒）：一两帧的过渡闪白不算，停留 1 秒以上才算 */
export const BLANK_WINDOW_SEC = 1;

export interface Span { start: number; end: number }
/** diffs[k] 是第 k 与 k+1 帧上半屏的平均差；blank[k] 是第 k 帧上半屏的平坦块比例；first 是第 0 帧（上半屏空白率与整帧标准差） */
export interface FrameSeries { fps: number; count: number; diffs: number[]; blank: number[]; first: { blank: number; std: number } }

const FRAME_PX = GRID.width * GRID.height;
const TOP_PX = GRID.width * GRID.topRows;
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** 上半屏两帧的平均绝对差 */
function topDiff(buf: Uint8Array, a: number, b: number): number {
  let sum = 0;
  for (let i = 0; i < TOP_PX; i++) sum += Math.abs(buf[a + i] - buf[b + i]);
  return sum / TOP_PX;
}

/** 一个 6×6 块的总体标准差 */
function blockStd(buf: Uint8Array, offset: number, bx: number, by: number): number {
  const n = GRID.block * GRID.block;
  let sum = 0;
  let sq = 0;
  for (let y = 0; y < GRID.block; y++) {
    for (let x = 0; x < GRID.block; x++) {
      const v = buf[offset + (by * GRID.block + y) * GRID.width + bx * GRID.block + x];
      sum += v;
      sq += v * v;
    }
  }
  const mean = sum / n;
  return Math.sqrt(Math.max(0, sq / n - mean * mean));
}

/** 上半屏平坦块的比例 */
function topBlank(buf: Uint8Array, offset: number): number {
  const cols = Math.floor(GRID.width / GRID.block);
  const rows = Math.floor(GRID.topRows / GRID.block);
  let flat = 0;
  for (let by = 0; by < rows; by++) for (let bx = 0; bx < cols; bx++) if (blockStd(buf, offset, bx, by) < FLAT_STD) flat += 1;
  return flat / (cols * rows);
}

/** 整帧标准差（判断是不是纯黑、纯米色这类纯色帧） */
function frameStd(buf: Uint8Array, offset: number): number {
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < FRAME_PX; i++) { const v = buf[offset + i]; sum += v; sq += v * v; }
  const mean = sum / FRAME_PX;
  return Math.sqrt(Math.max(0, sq / FRAME_PX - mean * mean));
}

/** 灰度帧序列（108×192 逐帧拼接）→ 逐帧度量 */
export function analyzeGray(buf: Uint8Array): FrameSeries {
  const count = Math.floor(buf.length / FRAME_PX);
  if (count === 0) throw new Error('没有抽到画面帧');
  const diffs = Array.from({ length: count - 1 }, (_, k) => topDiff(buf, k * FRAME_PX, (k + 1) * FRAME_PX));
  const blank = Array.from({ length: count }, (_, k) => topBlank(buf, k * FRAME_PX));
  return { fps: GRID.fps, count, diffs, blank, first: { blank: blank[0], std: round3(frameStd(buf, 0)) } };
}

/** 静止段：连续 diffs < STILL_DIFF 超过 minSec 秒；返回成片秒数区间 */
export function staticSpans(s: FrameSeries, minSec = STATIC_MIN_SEC): Span[] {
  const spans: Span[] = [];
  let from = -1;
  const close = (k: number): void => {
    if (from >= 0 && (k - from) / s.fps > minSec) spans.push({ start: round3(from / s.fps), end: round3(k / s.fps) });
    from = -1;
  };
  s.diffs.forEach((d, k) => { if (d < STILL_DIFF) { if (from < 0) from = k; } else close(k); });
  close(s.diffs.length);
  return spans;
}

/** 空白率按 1 秒滑动平均：峰值、峰值时刻（窗口中点）与超过 limit 的区间（相连的窗口合并） */
export function blankSpans(s: FrameSeries, limit: number): { peak: number; peakAt: number; spans: Span[] } {
  const w = Math.max(1, Math.round(BLANK_WINDOW_SEC * s.fps));
  const n = Math.max(1, s.blank.length - w + 1);
  const avg = Array.from({ length: n }, (_, k) => s.blank.slice(k, k + w).reduce((a, b) => a + b, 0) / Math.min(w, s.blank.length - k));
  const peakK = avg.reduce((best, v, k) => (v > avg[best] ? k : best), 0);
  const spans = avg.reduce<Span[]>((acc, v, k) => {
    if (v <= limit + 1e-9) return acc;
    const span = { start: round3(k / s.fps), end: round3((k + w) / s.fps) };
    const last = acc[acc.length - 1];
    return last && last.end >= span.start ? [...acc.slice(0, -1), { start: last.start, end: span.end }] : [...acc, span];
  }, []);
  return { peak: round3(avg[peakK]), peakAt: round3((peakK + w / 2) / s.fps), spans };
}

/** 抽取成片前 endSec 秒的灰度帧（108×192、每秒 5 帧）；ffmpeg 出错时抛错 */
export async function extractGray(ffmpeg: string, video: string, endSec: number, signal?: AbortSignal): Promise<Uint8Array> {
  throwIfCancelled(signal);
  const vf = `fps=${GRID.fps},scale=${GRID.width}:${GRID.height}:flags=area,format=gray`;
  const buf = await runBuffer(ffmpeg, ['-v', 'error', '-i', video, '-t', endSec.toFixed(3), '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'gray', '-']);
  throwIfCancelled(signal);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}
