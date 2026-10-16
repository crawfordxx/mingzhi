import { runBuffer } from '../media/exec.js';

const WIDTH = 9;
const HEIGHT = 8;
/** 全片去重阈值：汉明距离小于它视为同一素材 */
export const DUPLICATE_HAMMING = 10;

/** 64 位 dHash：缩到 9×8 灰度，每行相邻像素左亮于右记 1；视频取第一帧 */
export async function dhash(file: string, ffmpeg: string): Promise<bigint> {
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
  return hash;
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
