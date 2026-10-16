import { describe, expect, it } from 'vitest';
import { GRAIN_STRENGTH, PERSON_GRAIN_GAIN, grainField, grainLift, grainSpan } from '../render/layers/grain-field.js';
import { personRegionAt } from '../render/layers/person-region.js';
import { CANVAS, type Shot, type TalkProps } from '../src/storyboard/schema.js';

const W = 240;
const H = 200;

/** 取一个矩形内某通道的均值与标准差 */
function stats(buf: Uint8ClampedArray, width: number, rect: { x: number; y: number; w: number; h: number }, ch = 0): { mean: number; std: number } {
  let sum = 0, sq = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const v = buf[(y * width + x) * 4 + ch];
      sum += v; sq += v * v; n += 1;
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}

describe('颗粒场', () => {
  it('同一帧号完全相同、不同帧号不同；R=G=B（只有亮度）、alpha 不透明', () => {
    const a = grainField(12, W, H);
    expect(grainField(12, W, H)).toEqual(a);
    expect(grainField(13, W, H)).not.toEqual(a);
    for (let i = 0; i < a.length; i += 4) {
      if (a[i] !== a[i + 1] || a[i] !== a[i + 2] || a[i + 3] !== 255) throw new Error(`像素 ${i / 4} 不是不透明灰色`);
    }
  });

  it('强度：均方根 ≈ GRAIN_STRENGTH × 255，均值落在峰峰值一半；默认强度在 0.6%–1.5% 之间（手机上刚能察觉）', () => {
    expect(GRAIN_STRENGTH).toBeGreaterThanOrEqual(0.006);
    expect(GRAIN_STRENGTH).toBeLessThanOrEqual(0.015);
    const { mean, std } = stats(grainField(3, W, H), W, { x: 0, y: 0, w: W, h: H });
    expect(std / 255).toBeGreaterThan(GRAIN_STRENGTH * 0.9);
    expect(std / 255).toBeLessThan(GRAIN_STRENGTH * 1.1);
    expect(Math.abs(mean - grainSpan(GRAIN_STRENGTH) / 2)).toBeLessThan(0.3);
  });

  it('1:1 像素：相邻像素互不相关（不是放大后的粗颗粒），相邻帧互不相关（动态）', () => {
    const f0 = grainField(5, W, H);
    const f1 = grainField(6, W, H);
    const corr = (pick: (x: number, y: number) => [number, number]): number => {
      let sa = 0, sb = 0, sab = 0, saa = 0, sbb = 0, n = 0;
      for (let y = 1; y < H - 1; y += 1) {
        for (let x = 1; x < W - 1; x += 1) {
          const [a, b] = pick(x, y);
          sa += a; sb += b; sab += a * b; saa += a * a; sbb += b * b; n += 1;
        }
      }
      return (sab / n - (sa / n) * (sb / n)) / Math.sqrt((saa / n - (sa / n) ** 2) * (sbb / n - (sb / n) ** 2));
    };
    const at = (f: Uint8ClampedArray, x: number, y: number): number => f[(y * W + x) * 4];
    expect(Math.abs(corr((x, y) => [at(f0, x, y), at(f0, x + 1, y)]))).toBeLessThan(0.05);
    expect(Math.abs(corr((x, y) => [at(f0, x, y), at(f0, x, y + 1)]))).toBeLessThan(0.05);
    expect(Math.abs(corr((x, y) => [at(f0, x, y), at(f1, x, y)]))).toBeLessThan(0.05);
  });

  it('人物区域：区域内波动降到 1/3、均值不变（边缘无亮度台阶），远离区域的地方不受影响', () => {
    const region = { x: 80, y: 40, w: 80, h: 120 };
    const f = grainField(9, W, H, { region });
    const plain = grainField(9, W, H);
    const inside = stats(f, W, { x: 100, y: 60, w: 40, h: 80 });
    const outside = stats(f, W, { x: 0, y: 0, w: 30, h: 30 });
    expect(inside.std / outside.std).toBeGreaterThan(PERSON_GRAIN_GAIN * 0.85);
    expect(inside.std / outside.std).toBeLessThan(PERSON_GRAIN_GAIN * 1.15);
    expect(Math.abs(inside.mean - outside.mean)).toBeLessThan(0.5);
    // 区域外足够远（> 羽化宽度）的像素与无区域时逐位相同的随机序列，波动一致
    expect(stats(plain, W, { x: 0, y: 0, w: 30, h: 30 }).std).toBeCloseTo(outside.std, 5);
  });

  it('羽化：区域边缘强度单调渐变，没有一圈硬边', () => {
    const f = grainField(2, 400, 60, { region: { x: 200, y: -100, w: 300, h: 400 } });
    const col = (x0: number): number => stats(f, 400, { x: x0, y: 0, w: 8, h: 60 }).std;
    const [far, mid, near, inside] = [col(100), col(165), col(190), col(230)];
    expect(far).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(inside);
  });

  it('提亮量：抵消噪声平均抬升，使中灰（128）处亮度不变', () => {
    const lift = grainLift(GRAIN_STRENGTH);
    expect(128 * (1 - lift) + grainSpan(GRAIN_STRENGTH) / 2).toBeCloseTo(128, 5);
  });
});

const person = { person: 'person.mp4', personWidth: 1920, personHeight: 1080, durationSec: 10, captions: [] };
const shot = (start: number, end: number, layout: Shot['layout'], extra: Partial<Shot> = {}): Shot => ({ start, end, layout, ...extra }) as Shot;
const props = (shots: Shot[], subject: TalkProps['subject']): TalkProps => ({ ...person, subject, shots });
const SUBJECT = { top: 0.1, bottom: 1, left: 0.35, right: 0.65 };

describe('人物区域（画布像素）', () => {
  it('全屏：人物框按视频缩放与位置映射到画布', () => {
    const r = personRegionAt(props([shot(0, 10, 'full')], SUBJECT), 5);
    const scale = CANVAS.height / 1080;
    expect(r).not.toBeNull();
    expect(r!.h).toBeCloseTo(0.9 * 1080 * scale, 0);
    expect(r!.w).toBeCloseTo(0.3 * 1920 * scale, 0);
    expect(r!.x).toBeGreaterThan(0);
    expect(r!.x + r!.w).toBeLessThanOrEqual(CANVAS.width);
  });

  it('分屏：只取分界线以下', () => {
    const r = personRegionAt(props([shot(0, 10, 'split')], SUBJECT), 5);
    expect(r!.y).toBeGreaterThanOrEqual(CANVAS.seam);
    expect(r!.y + r!.h).toBeLessThanOrEqual(CANVAS.height);
  });

  it('画中画：落在小窗里', () => {
    const r = personRegionAt(props([shot(0, 5, 'full'), shot(5, 10, 'pip', { broll: { file: 'b.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } } } as Partial<Shot>)], SUBJECT), 8);
    expect(r!.w).toBeLessThanOrEqual(360 + 1e-6);
    expect(r!.x).toBeGreaterThanOrEqual(600);
  });

  it('素材全屏插入：人物被盖住，没有人物区域', () => {
    const shots = [shot(0, 5, 'full'), shot(5, 10, 'broll', { broll: { file: 'b.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } } } as Partial<Shot>)];
    expect(personRegionAt(props(shots, SUBJECT), 8)).toBeNull();
  });

  it('没有人物框：保守地把整块人像视频当人物区域', () => {
    const r = personRegionAt(props([shot(0, 10, 'full')], null), 5);
    expect(r).not.toBeNull();
    expect(r!.y).toBeLessThanOrEqual(0);
    expect(r!.h).toBeGreaterThanOrEqual(CANVAS.height - 1);
  });
});
