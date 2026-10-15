import { describe, expect, it } from 'vitest';
import { COVER_YUAN, estimateCost, formatEstimate } from '../src/cost/estimate.js';

const base = { durationSec: 60, bgPrompt: false, broll: false, maxVideos: 1, qa: false, cover: false };
const item = (est: ReturnType<typeof estimateCost>, label: string) => est.items.find((i) => i.label.startsWith(label));

describe('estimateCost', () => {
  it('只有 LLM 步骤：1 分钟 = 剪口误 0.15 + 字幕校对 0.05 + 分镜 0.05', () => {
    const est = estimateCost(base);
    expect(est.items.map((i) => [i.label, i.yuan])).toEqual([['剪口误', 0.15], ['字幕校对', 0.05], ['分镜', 0.05]]);
    expect(est.low).toBe(0.25);
    expect(est.high).toBe(0.25);
  });

  it('LLM 费用随时长线性增长', () => {
    expect(estimateCost({ ...base, durationSec: 120 }).high).toBe(0.5);
    expect(estimateCost({ ...base, durationSec: 0 }).high).toBe(0);
  });

  it('B-roll：60 秒按每 15 秒 / 每 10 秒 1 张图 = 0.8 ~ 1.2；Seedance low 为 0、high 为 maxVideos × 2.4', () => {
    const est = estimateCost({ ...base, broll: true, maxVideos: 2 });
    expect(item(est, 'B-roll 生图')).toMatchObject({ low: 0.8, yuan: 1.2 });
    expect(item(est, 'B-roll 视频')).toMatchObject({ low: 0, yuan: 4.8 });
    expect(item(est, 'B-roll 联网搜索')).toMatchObject({ low: 0.2, yuan: 0.3 }); // 每个截图需求 0.05，沿用生图数口径（4 ~ 6 个）
    expect(est.low).toBe(1.25);
    expect(est.high).toBe(6.55);
  });

  it('不取素材时没有 B-roll 项；maxVideos 为 0 时视频项为 0', () => {
    expect(item(estimateCost(base), 'B-roll')).toBeUndefined();
    expect(item(estimateCost({ ...base, broll: true, maxVideos: 0 }), 'B-roll 视频')).toMatchObject({ low: 0, yuan: 0 });
  });

  it('背景生图 0.2；封面 low 1.25、high 重生一轮 2.5；缺省 cover 视为开启', () => {
    expect(item(estimateCost({ ...base, bgPrompt: true }), '背景生图')).toMatchObject({ low: 0.2, yuan: 0.2 });
    expect(COVER_YUAN).toBeCloseTo(1.25);
    expect(item(estimateCost({ ...base, cover: true }), '封面')).toMatchObject({ low: 1.25, yuan: 2.5 });
    const { cover: _cover, ...noCoverField } = base;
    expect(item(estimateCost(noCoverField), '封面')).toBeDefined();
  });

  it('卡片自检：每 6 秒 1 张 × 0.05，最坏 ×5', () => {
    expect(item(estimateCost({ ...base, qa: true }), '卡片自检')).toMatchObject({ low: 0.5, yuan: 2.5 });
    expect(item(estimateCost(base), '卡片自检')).toBeUndefined();
  });

  it('low ≤ high，且等于各项之和', () => {
    const est = estimateCost({ durationSec: 95, bgPrompt: true, broll: true, maxVideos: 1, qa: true, cover: true });
    expect(est.low).toBeLessThanOrEqual(est.high);
    expect(est.high).toBeCloseTo(est.items.reduce((s, i) => s + i.yuan, 0), 1);
    expect(est.low).toBeCloseTo(est.items.reduce((s, i) => s + i.low, 0), 1);
  });
});

describe('formatEstimate', () => {
  it('必需步骤（剪口误、字幕校对、分镜）合计超过上限时单独提示「仍会花费」；没超就没有这行', () => {
    const est = estimateCost(base); // 必需项合计 ¥0.25
    expect(formatEstimate(est, 0.1)).toContain('必需步骤（剪口误、字幕校对、分镜）约 ¥0.25 已超上限 ¥0.10，仍会花费');
    expect(formatEstimate(est, 0.25)).not.toContain('必需步骤');
    expect(formatEstimate(estimateCost({ ...base, broll: true }), 1)).not.toContain('必需步骤'); // 只是总额超了，必需项没超
  });

  it('显示区间、上限与明细；未超预算时没有降级提示', () => {
    const text = formatEstimate(estimateCost({ ...base, broll: true }), 10);
    expect(text).toContain('预估花费 ¥1.25–¥4.15（上限 ¥10.00）');
    expect(text).toContain('剪口误 ¥0.15');
    expect(text).toContain('B-roll 视频（Seedance） ¥0.00–¥2.40');
    expect(text).not.toContain('自动降级');
  });

  it('最高值超出预算时提示自动降级', () => {
    const text = formatEstimate(estimateCost({ ...base, broll: true, maxVideos: 5 }), 3);
    expect(text).toContain('预估最高 ¥13.75，超过上限 ¥3.00：将自动降级（不用 Seedance，必要时少生图）');
  });
});
