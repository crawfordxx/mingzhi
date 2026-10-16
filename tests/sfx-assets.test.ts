import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { SFX, sfxPath, type SfxId } from '../src/assets/catalog.js';
import { ANCHOR_SEC, KIND_OF, MAX_PER_SFX, VARIANTS } from '../src/audio/sfx-map.js';
// @ts-expect-error 合成脚本是 .mjs，没有类型声明
import { SAMPLE_RATE, SPECS, toWav } from '../scripts/make-sfx.mjs';

interface Spec { name: string; sync: 'peak' | 'onset' | 'end'; anchor: number; make: () => Float64Array }
const specs = SPECS as Spec[];
const FRAME = 1 / 30;
const SFX_DIR = dirname(sfxPath('click'));

/** 读 16 bit 单声道 PCM wav，返回采样与采样率 */
function readWav(path: string): { data: Float64Array; rate: number } {
  const buf = readFileSync(path);
  expect(buf.toString('ascii', 0, 4)).toBe('RIFF');
  const rate = buf.readUInt32LE(24);
  const bits = buf.readUInt16LE(34);
  expect(bits).toBe(16);
  const channels = buf.readUInt16LE(22);
  let offset = 12;
  while (offset + 8 <= buf.length && buf.toString('ascii', offset, offset + 4) !== 'data') offset += 8 + buf.readUInt32LE(offset + 4);
  const size = buf.readUInt32LE(offset + 4);
  const n = Math.floor(size / 2 / channels);
  return { data: Float64Array.from({ length: n }, (_, i) => buf.readInt16LE(offset + 8 + i * 2 * channels) / 32768), rate };
}

/** 20ms 窗均方根最大处的中心时刻 */
function rmsPeakSec(data: Float64Array, rate: number): number {
  const win = Math.round(rate * 0.02);
  let best = -1; let at = 0;
  for (let i = 0; i + win <= data.length; i += win / 2) {
    const e = data.slice(i, i + win).reduce((s, v) => s + v * v, 0);
    if (e > best) { best = e; at = i + win / 2; }
  }
  return at / rate;
}

function onsetSec(data: Float64Array, rate: number): number {
  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  return data.findIndex((v) => Math.abs(v) > peak * 0.2) / rate;
}

function lastLoudSec(data: Float64Array, rate: number): number {
  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
  let i = data.length - 1;
  while (i > 0 && Math.abs(data[i]) < peak * 0.2) i -= 1;
  return i / rate;
}

describe('音效素材', () => {
  it('SFX 清单、种类表、锚点表覆盖同一批 id', () => {
    const ids = Object.keys(SFX).sort();
    expect(Object.keys(KIND_OF).sort()).toEqual(ids);
    expect(Object.keys(ANCHOR_SEC).sort()).toEqual(ids);
    Object.values(VARIANTS).flat().forEach((id) => expect(ids).toContain(id));
  });
  it('不同种类 ≥ 5，且可轮换的变体总数够 try2 的规模（23 张卡片的入场音不被丢）', () => {
    expect(new Set(Object.values(KIND_OF)).size).toBeGreaterThanOrEqual(5);
    expect(VARIANTS.pop.length * MAX_PER_SFX).toBeGreaterThanOrEqual(23);
  });
  it('sfx 目录总体积 ≤ 1MB，每个文件都是 16 bit PCM 且不静音', () => {
    const files = readdirSync(SFX_DIR).filter((f) => f.endsWith('.wav'));
    expect(files.reduce((sum, f) => sum + statSync(join(SFX_DIR, f)).size, 0)).toBeLessThanOrEqual(1024 * 1024);
    for (const id of Object.keys(SFX) as SfxId[]) {
      const { data } = readWav(sfxPath(id));
      expect(data.length, id).toBeGreaterThan(0);
      expect(data.reduce((m, v) => Math.max(m, Math.abs(v)), 0), id).toBeGreaterThan(0.1);
    }
  });
  it('入库的 wav 与合成脚本逐字节一致（改了脚本要重新生成：node scripts/make-sfx.mjs）', () => {
    for (const spec of specs) expect(readFileSync(join(SFX_DIR, `${spec.name}.wav`)).equals(toWav(spec.make())), spec.name).toBe(true);
  });
  it('合成脚本的清单与 SFX 文件名一一对应，锚点与 ANCHOR_SEC 一致', () => {
    const byFile = new Map<string, SfxId>(Object.entries(SFX).map(([id, file]) => [file, id as SfxId]));
    for (const spec of specs) {
      const id = byFile.get(`${spec.name}.wav`);
      expect(id, spec.name).toBeDefined();
      expect(ANCHOR_SEC[id as SfxId], spec.name).toBe(spec.anchor);
    }
  });
  it('锚点实测：whoosh 的响度峰值、riser 的结尾、其余的起音，都在锚点 ±2 帧内', () => {
    for (const spec of specs) {
      const { data, rate } = readWav(join(SFX_DIR, `${spec.name}.wav`));
      expect(rate).toBe(SAMPLE_RATE);
      const measured = spec.sync === 'peak' ? rmsPeakSec(data, rate) : spec.sync === 'end' ? lastLoudSec(data, rate) : onsetSec(data, rate);
      expect(Math.abs(measured - spec.anchor), `${spec.name} 实测 ${measured.toFixed(3)}s 锚点 ${spec.anchor}s`).toBeLessThanOrEqual(2 * FRAME);
    }
  });
  it('LICENSE 说明了 Kenney CC0 与代码合成两部分来源', () => {
    const text = readFileSync(join(SFX_DIR, 'LICENSE.txt'), 'utf8');
    expect(text).toContain('Kenney');
    expect(text).toContain('CC0');
    expect(text).toContain('make-sfx.mjs');
    expect(text).toContain('MIT');
  });
});
