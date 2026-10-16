import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { run } from '../media/exec.js';
import { badgeFilter, blankMarkFilter, BLANK_COLOR, CELL } from './sheet-draw.js';
import type { Candidate } from './sources/types.js';
import { stillOf } from './still-fetch.js';

export { CELL } from './sheet-draw.js';
export { stillOf } from './still-fetch.js';
export const SHEET_COLS = 3;
export const SHEET_MAX = 9;
const LETTERBOX = '0x808080';

export interface SheetOptions {
  fetchImpl?: typeof fetch;
  /** 每个候选的静帧缓存目录（去重算哈希复用同一批图）；缺省为联系表所在目录下的 stills，由调用方在流水线收尾时清理 */
  stillsDir?: string;
  /** 取消信号：传给远程下载与抽帧 */
  signal?: AbortSignal;
}

/** 取图失败而留空的格：index 是联系表序号（从 1 开始） */
export interface BlankCell { index: number; id: string; reason: string }
export interface SheetResult { file: string; /** 放进表里的候选数 */ count: number; blanks: BlankCell[] }

/** contactSheet 缺省的静帧目录：联系表同目录下的 stills */
export const defaultStillsDir = (out: string): string => join(dirname(out), 'stills');

/** 一格的滤镜：保持原比例缩进正方形格（灰底 letterbox），右上角标序号；空格画「空」字 */
function cellFilter(i: number, blank: boolean): string {
  const fit = `scale=${CELL}:${CELL}:force_original_aspect_ratio=decrease,format=rgba,pad=${CELL}:${CELL}:(ow-iw)/2:(oh-ih)/2:color=${LETTERBOX}`;
  const mark = blank ? `,${blankMarkFilter()}` : '';
  return `[${i}:v]${fit}${mark},${badgeFilter(i + 1)}[c${i}]`;
}

function layoutOf(n: number): string {
  return Array.from({ length: n }, (_, i) => `${(i % SHEET_COLS) * CELL}_${Math.floor(i / SHEET_COLS) * CELL}`).join('|');
}

const reasonOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 最多 9 个候选拼成 3×3 联系表（每格 512，总宽 ≤ 1536），格内按原比例居中、右上角标 1-9 的序号。
 * 单格取图失败时该格是深红底的「空」格，并在 blanks 里给出序号与原因（调用方应把这些序号从打分里剔除）；全部取图失败时抛错
 */
export async function buildContactSheet(candidates: readonly Candidate[], out: string, ffmpeg: string, opts: SheetOptions = {}): Promise<SheetResult> {
  const picked = candidates.slice(0, SHEET_MAX);
  if (picked.length === 0) throw new Error('没有候选可拼联系表');
  const stillsDir = opts.stillsDir ?? defaultStillsDir(out);
  const fetched = await Promise.all(picked.map((c) => stillOf(c, stillsDir, ffmpeg, opts.fetchImpl, opts.signal).then((file) => ({ file }), (err: unknown) => ({ reason: reasonOf(err) }))));
  const blanks = fetched.flatMap((f, i): BlankCell[] => ('reason' in f ? [{ index: i + 1, id: picked[i].id, reason: f.reason }] : []));
  if (blanks.length === picked.length) throw new Error(`所有候选的画面都取不到：${blanks[0].reason}`);
  const inputs = fetched.flatMap((f) => ('file' in f ? ['-i', f.file] : ['-f', 'lavfi', '-i', `color=c=${BLANK_COLOR}:s=${CELL}x${CELL}`]));
  const cells = picked.map((_, i) => cellFilter(i, 'reason' in fetched[i])).join(';');
  const stack = picked.length === 1 ? '[c0]null[sheet]' : `${picked.map((_, i) => `[c${i}]`).join('')}xstack=inputs=${picked.length}:layout=${layoutOf(picked.length)}:fill=${LETTERBOX}[sheet]`;
  const quality = /\.jpe?g$/i.test(out) ? ['-q:v', '3'] : [];
  mkdirSync(dirname(out), { recursive: true });
  await run(ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', `${cells};${stack};[sheet]format=rgb24[final]`, '-map', '[final]', '-frames:v', '1', ...quality, out]);
  return { file: out, count: picked.length, blanks };
}

/** 联系表（只要文件路径时用；要空格信息用 buildContactSheet） */
export async function contactSheet(candidates: Candidate[], out: string, ffmpeg: string, opts: SheetOptions = {}): Promise<string> {
  return (await buildContactSheet(candidates, out, ffmpeg, opts)).file;
}
