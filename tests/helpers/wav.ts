import { readFileSync } from 'node:fs';

export interface Wav { data: Float64Array; rate: number }

/** 读 16 bit PCM wav（取第一声道） */
export function readWav(path: string): Wav {
  const buf = readFileSync(path);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.readUInt16LE(34) !== 16) throw new Error(`不是 16 bit PCM wav：${path}`);
  const rate = buf.readUInt32LE(24);
  const channels = buf.readUInt16LE(22);
  let offset = 12;
  while (offset + 8 <= buf.length && buf.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + buf.readUInt32LE(offset + 4);
  const n = Math.floor(buf.readUInt32LE(offset + 4) / 2 / channels);
  return { data: Float64Array.from({ length: n }, (_, i) => buf.readInt16LE(offset + 8 + i * 2 * channels) / 32768), rate };
}

const peakOf = (d: Float64Array): number => d.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** 20ms 窗均方根最大处的中心时刻（whoosh 的响度峰值） */
export function rmsPeakSec({ data, rate }: Wav): number {
  const win = Math.round(rate * 0.02);
  let best = -1; let at = 0;
  for (let i = 0; i + win <= data.length; i += win / 2) {
    const e = data.slice(i, i + win).reduce((s, v) => s + v * v, 0);
    if (e > best) { best = e; at = i + win / 2; }
  }
  return at / rate;
}

/** 起音：第一个超过峰值 20% 的采样 */
export function onsetSec({ data, rate }: Wav): number {
  const peak = peakOf(data);
  return data.findIndex((v) => Math.abs(v) > peak * 0.2) / rate;
}

/** 响度结束处：最后一个超过峰值 20% 的采样（riser 的高潮） */
export function lastLoudSec({ data, rate }: Wav): number {
  const peak = peakOf(data);
  let i = data.length - 1;
  while (i > 0 && Math.abs(data[i]) < peak * 0.2) i -= 1;
  return i / rate;
}
