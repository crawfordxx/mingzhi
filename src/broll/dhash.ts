import { runBuffer } from '../media/exec.js';

const WIDTH = 9;
const HEIGHT = 8;
/** 全片去重阈值：汉明距离小于它视为同一素材 */
export const DUPLICATE_HAMMING = 10;

/** 9×8 灰度像素标准差低于它视为纯色或近乎无细节的画面（黑场、纯色背景），dHash 在这类画面上不可靠 */
export const FLAT_STDDEV = 4;

export interface HashStats { hash: bigint; stddev: number }

/** 64 位 dHash 与缩略灰度的标准差：缩到 9×8 灰度，每行相邻像素左亮于右记 1；视频取第一帧 */
export async function dhashStats(file: string, ffmpeg: string): Promise<HashStats> {
  const pixels = await runBuffer(ffmpeg, [
    '-v', 'error', '-i', file, '-vf', `scale=${WIDTH}:${HEIGHT}:flags=area,format=gray`, '-frames:v', '1', '-f', 'rawvideo', '-',
  ]);
  if (pixels.length < WIDTH * HEIGHT) throw new Error(`dHash 读不出画面：${file}`);
  let hash = 0n;
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH - 1; x += 1) {
      hash = (hash << 1n) | (pixels[y * WIDTH + x] > pixels[y * WIDTH + x + 1] ? 1n : 0n);
    }
  }
  const values = [...pixels.subarray(0, WIDTH * HEIGHT)];
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const stddev = Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
  return { hash, stddev };
}

export async function dhash(file: string, ffmpeg: string): Promise<bigint> {
  return (await dhashStats(file, ffmpeg)).hash;
}

/** 去重用的哈希：纯色或低方差画面返回 null（不参与重复判断，避免黑场互相误判成同一素材） */
export async function dedupHash(file: string, ffmpeg: string): Promise<bigint | null> {
  const { hash, stddev } = await dhashStats(file, ffmpeg);
  return stddev < FLAT_STDDEV ? null : hash;
}

/** 两个哈希里不同的位数 */
export function hamming(a: bigint, b: bigint): number {
  let diff = a ^ b;
  let count = 0;
  while (diff > 0n) {
    count += Number(diff & 1n);
    diff >>= 1n;
  }
  return count;
}
