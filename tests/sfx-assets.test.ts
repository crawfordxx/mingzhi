import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { lastLoudSec, onsetSec, readWav, rmsPeakSec } from './helpers/wav.js';
import { dirname, join } from 'node:path';
import { SFX, sfxPath, type SfxId } from '../src/assets/catalog.js';
import { ANCHOR_SEC, KIND_OF, MAX_PER_SFX, VARIANTS } from '../src/audio/sfx-map.js';
// @ts-expect-error 合成脚本是 .mjs，没有类型声明
import { SAMPLE_RATE, SPECS, toWav } from '../scripts/make-sfx.mjs';

interface Spec { name: string; sync: 'peak' | 'onset' | 'end'; anchor: number; make: () => Float64Array }
const specs = SPECS as Spec[];
const FRAME = 1 / 30;
const SFX_DIR = dirname(sfxPath('click'));

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
  it('入库的 wav 与合成脚本一致（改了脚本要重新生成：node scripts/make-sfx.mjs）；Math 函数跨平台可能差 1 个 LSB，所以按样本比较、容差 2 LSB', () => {
    for (const spec of specs) {
      const a = readFileSync(join(SFX_DIR, `${spec.name}.wav`));
      const b = toWav(spec.make());
      expect(a.length, spec.name).toBe(b.length);
      let worst = 0;
      for (let i = 44; i + 1 < a.length; i += 2) worst = Math.max(worst, Math.abs(a.readInt16LE(i) - b.readInt16LE(i)));
      expect(worst, spec.name).toBeLessThanOrEqual(2);
    }
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
      const wav = readWav(join(SFX_DIR, `${spec.name}.wav`));
      expect(wav.rate).toBe(SAMPLE_RATE);
      const measured = spec.sync === 'peak' ? rmsPeakSec(wav) : spec.sync === 'end' ? lastLoudSec(wav) : onsetSec(wav);
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
