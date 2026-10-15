import { describe, expect, it } from 'vitest';
import { blendTransform, captionAt, personTransform, shotAt } from '../src/compose/layout.js';

describe('personTransform', () => {
  it('全屏：按宽铺满并垂直居中（9:16 视频正好铺满）', () => {
    expect(personTransform('full', null, 360, 640)).toEqual({ scale: 3, x: 0, y: 0 });
  });
  it('分屏：按宽铺满，头顶放在分界线下 60px，且画面不露出分界线以上、不露出底部', () => {
    const t = personTransform('split', { top: 0.2, bottom: 1, left: 0.2, right: 0.8 }, 1080, 1920);
    expect(t.scale).toBe(1);
    expect(t.x).toBe(0);
    expect(t.y).toBe(960 + 60 - 0.2 * 1920);
  });
  it('分屏：头顶很低时 y 不超过分界线（上方不露底色）；头顶很高时视频底部不高于画布底', () => {
    expect(personTransform('split', { top: 0, bottom: 1, left: 0, right: 1 }, 1080, 1920).y).toBe(960);
    // 1080×1350 的横宽视频：缩放后高 1350，y 最小为 1920-1350=570，但不能超过 960
    const wide = personTransform('split', { top: 0.9, bottom: 1, left: 0, right: 1 }, 1080, 1350);
    expect(wide.y).toBe(570);
  });
  it('横屏原片全屏：按高铺满（cover），水平方向以人物中心对齐且不露边', () => {
    // 1280×720 → scale = 1920/720；人物居中 → x 让人物中心落在画布中线
    const t = personTransform('full', { top: 0.1, bottom: 1, left: 0.4, right: 0.6 }, 1280, 720);
    expect(t.scale).toBeCloseTo(1920 / 720);
    expect(t.y).toBe(0);
    const w = 1280 * t.scale;
    expect(t.x).toBe(Math.round(540 - 0.5 * w));
    // 人物在画面最左：x 夹到 0，不露出右侧底色
    expect(personTransform('full', { top: 0.1, bottom: 1, left: 0, right: 0.1 }, 1280, 720).x).toBe(0);
    expect(personTransform('full', { top: 0.1, bottom: 1, left: 0.9, right: 1 }, 1280, 720).x).toBe(Math.round(1080 - w));
  });
  it('横屏原片分屏：下半屏（960 高）铺满，不留空', () => {
    const t = personTransform('split', { top: 0.15, bottom: 1, left: 0.3, right: 0.7 }, 1280, 720);
    const h = 720 * t.scale;
    expect(h).toBeGreaterThanOrEqual(960);
    expect(t.y).toBeLessThanOrEqual(960);
    expect(t.y + h).toBeGreaterThanOrEqual(1920);
    expect(t.x).toBeLessThanOrEqual(0);
    expect(t.x + 1280 * t.scale).toBeGreaterThanOrEqual(1080);
  });
  it('没有取景框时按头顶在 12% 处估计', () => {
    expect(personTransform('split', null, 1080, 1920).y).toBe(960 + 60 - 0.12 * 1920);
  });
});

describe('blendTransform / captionAt / shotAt', () => {
  it('线性插值', () => {
    expect(blendTransform({ scale: 1, x: 0, y: 0 }, { scale: 3, x: 10, y: 100 }, 0.5)).toEqual({ scale: 2, x: 5, y: 50 });
  });
  it('按时间找当前字幕与镜头；不在任何区间返回 null', () => {
    const caps = [{ start: 0, end: 1, text: 'a' }, { start: 1.5, end: 2, text: 'b' }];
    expect(captionAt(caps, 0.5)?.text).toBe('a');
    expect(captionAt(caps, 1.2)).toBeNull();
    const shots = [{ start: 0, end: 2, layout: 'full' as const }, { start: 2, end: 4, layout: 'split' as const }];
    expect(shotAt(shots, 2)).toEqual({ shot: shots[1], index: 1 });
    expect(shotAt(shots, 9)).toBeNull();
  });
});
