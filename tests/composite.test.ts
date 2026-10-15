// tests/composite.test.ts
import { describe, expect, it } from 'vitest';
import { alphaBox, chooseDownsample, colorMatchGains, compositeFrame, foregroundMean, meanRgb, medianBox } from '../src/matting/composite.js';

describe('chooseDownsample', () => {
  it('让长边缩到约 512 像素，小视频不放大', () => {
    expect(chooseDownsample(1080, 1920)).toBeCloseTo(512 / 1920, 5);
    expect(chooseDownsample(360, 640)).toBeCloseTo(0.8, 5);
    expect(chooseDownsample(200, 300)).toBe(1);
  });
});

describe('meanRgb / foregroundMean', () => {
  it('rgb24 平均到 0–1', () => {
    expect(meanRgb(Buffer.from([255, 0, 0, 0, 0, 255]))).toEqual([0.5, 0, 0.5]);
  });
  it('只统计 alpha>0.5 的前景像素；没有前景返回 null', () => {
    // 2 个像素，平面 CHW：R=[1,0] G=[0,0] B=[0,1]
    const fgr = new Float32Array([1, 0, 0, 0, 0, 1]);
    expect(foregroundMean(fgr, new Float32Array([0.9, 0.1]), 2)).toEqual([1, 0, 0]);
    expect(foregroundMean(fgr, new Float32Array([0.1, 0.2]), 2)).toBeNull();
  });
});

describe('colorMatchGains', () => {
  it('前景与背景色调一致时不调整', () => {
    const g = colorMatchGains([0.5, 0.5, 0.5], [0.5, 0.5, 0.5]);
    g.forEach((v) => expect(v).toBeCloseTo(1, 5));
  });
  it('背景偏暖时红通道增益 >1、蓝通道 <1', () => {
    const [r, , b] = colorMatchGains([0.5, 0.5, 0.5], [0.6, 0.5, 0.35]);
    expect(r).toBeGreaterThan(1);
    expect(b).toBeLessThan(1);
  });
  it('背景更亮时整体增益 >1；白平衡与亮度因子各限制在 0.85–1.15，乘积落在 0.85²–1.15²', () => {
    const lum = colorMatchGains([0.3, 0.3, 0.3], [0.6, 0.6, 0.6]);
    lum.forEach((v) => expect(v).toBeGreaterThan(1));
    const extreme = colorMatchGains([0.9, 0.1, 0.1], [0.1, 0.1, 0.9], 1, 1);
    extreme.forEach((v) => { expect(v).toBeGreaterThanOrEqual(0.85 ** 2 - 1e-9); expect(v).toBeLessThanOrEqual(1.15 ** 2 + 1e-9); });
  });
  it('前景灰、背景暗中性色时三通道增益相等（只变亮度、不偏色）', () => {
    const [r, g, b] = colorMatchGains([0.5, 0.5, 0.5], [0.2, 0.2, 0.2]);
    expect(r).toBeCloseTo(g, 10);
    expect(g).toBeCloseTo(b, 10);
    expect(r).toBeLessThan(1);
  });
  it('白平衡因子与亮度因子分别限幅后相乘：亮度被压到下限时，白平衡调整不会被一并吞掉', () => {
    // 背景偏暖且很暗：白平衡 r 因子限到 1.15、b 因子限到 0.85，亮度因子限到 0.85
    const [r, , b] = colorMatchGains([0.5, 0.5, 0.5], [0.24, 0.2, 0.16], 1, 1);
    expect(r).toBeCloseTo(1.15 * 0.85, 10);
    expect(b).toBeCloseTo(0.85 * 0.85, 10);
  });
  it('强度为 0 时不调整', () => {
    colorMatchGains([0.3, 0.4, 0.5], [0.6, 0.5, 0.2], 0, 0).forEach((v) => expect(v).toBeCloseTo(1, 5));
  });
});

describe('compositeFrame', () => {
  it('按 alpha 混合前景（乘增益）与背景，结果四舍五入并截到 0–255', () => {
    // 2 个像素：第 1 个全前景，第 2 个全背景
    const fgr = new Float32Array([1, 0.5, 0, 0, 0.5, 0]); // R=[1,0.5] G=[0,0] B=[0.5,0]
    const pha = new Float32Array([1, 0]);
    const bg = Buffer.from([10, 20, 30, 40, 50, 60]);
    const out = Buffer.alloc(6);
    compositeFrame(fgr, pha, bg, [1.1, 1, 1], out);
    expect([...out]).toEqual([255, 0, 128, 40, 50, 60]);
  });
  it('半透明时线性混合', () => {
    const out = Buffer.alloc(3);
    compositeFrame(new Float32Array([1, 1, 1]), new Float32Array([0.5]), Buffer.from([0, 0, 0]), [1, 1, 1], out);
    expect([...out]).toEqual([128, 128, 128]);
  });
  it('alpha 恰为 0 时直接复制背景，即使前景非零', () => {
    const out = Buffer.alloc(3);
    compositeFrame(new Float32Array([1, 1, 1]), new Float32Array([0]), Buffer.from([7, 8, 9]), [1.1, 0.9, 1], out);
    expect([...out]).toEqual([7, 8, 9]);
  });
  it('非单位增益下 alpha=0.25 的混合结果手算校验', () => {
    // 单像素：fgr=[0.8,0.4,0.2]，增益 [1.1,0.9,1]，背景 [100,200,50]
    // R: 0.25·(0.8·1.1·255)+0.75·100 = 56.1+75 = 131.1 → 131
    // G: 0.25·(0.4·0.9·255)+0.75·200 = 22.95+150 = 172.95 → 173
    // B: 0.25·(0.2·1·255)+0.75·50 = 12.75+37.5 = 50.25 → 50
    const out = Buffer.alloc(3);
    compositeFrame(new Float32Array([0.8, 0.4, 0.2]), new Float32Array([0.25]), Buffer.from([100, 200, 50]), [1.1, 0.9, 1], out);
    expect([...out]).toEqual([131, 173, 50]);
  });
  it('alpha 略大于 1 或略小于 0 时结果仍截到 0–255', () => {
    const hi = Buffer.alloc(3);
    compositeFrame(new Float32Array([1, 1, 1]), new Float32Array([1.02]), Buffer.from([255, 255, 255]), [1, 1, 1], hi);
    expect([...hi]).toEqual([255, 255, 255]);
    const lo = Buffer.alloc(3);
    compositeFrame(new Float32Array([0, 0, 0]), new Float32Array([-0.01]), Buffer.from([10, 0, 255]), [1, 1, 1], lo);
    [...lo].forEach((v) => { expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThanOrEqual(255); });
  });
});

describe('alphaBox / medianBox', () => {
  it('alpha>0.5 的像素外接框（归一化）；全背景返回 null', () => {
    // 4×2：前景在 (1,0) 与 (2,1)
    const pha = new Float32Array([0, 1, 0, 0, 0, 0, 1, 0]);
    expect(alphaBox(pha, 4, 2)).toEqual({ top: 0, bottom: 1, left: 0.25, right: 0.75 });
    expect(alphaBox(new Float32Array(8), 4, 2)).toBeNull();
  });
  it('可自定义阈值', () => {
    // 4×2：(1,0)=0.6，(2,1)=0.3
    const pha = new Float32Array([0, 0.6, 0, 0, 0, 0, 0.3, 0]);
    expect(alphaBox(pha, 4, 2, 0.5)).toEqual({ top: 0, bottom: 0.5, left: 0.25, right: 0.5 });
    expect(alphaBox(pha, 4, 2, 0.2)).toEqual({ top: 0, bottom: 1, left: 0.25, right: 0.75 });
  });
  it('逐边取中位数；空数组返回 null', () => {
    const boxes = [
      { top: 0.1, bottom: 0.9, left: 0.2, right: 0.8 },
      { top: 0.3, bottom: 1, left: 0.1, right: 0.7 },
      { top: 0.2, bottom: 0.8, left: 0.3, right: 0.9 },
    ];
    expect(medianBox(boxes)).toEqual({ top: 0.2, bottom: 0.9, left: 0.2, right: 0.8 });
    expect(medianBox([])).toBeNull();
  });
  it('偶数个框时取中间两个值的平均', () => {
    const boxes = [
      { top: 0.25, bottom: 0.5, left: 0, right: 0.25 },
      { top: 0.75, bottom: 1, left: 0.5, right: 0.75 },
    ];
    expect(medianBox(boxes)).toEqual({ top: 0.5, bottom: 0.75, left: 0.25, right: 0.5 });
  });
});
