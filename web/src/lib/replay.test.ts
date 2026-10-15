import { describe, expect, it } from 'vitest';
import { REPLAY_BUDGET_MS, REPLAY_HOLD_MS, REPLAY_LEAD_MS, REPLAY_MAX_MS, replayOffsets, type Timed } from './replay';

const ev = (t: number, step = 'asr', progress = false): Timed => ({ t, step, ...(progress ? { detail: { kind: 'progress' } } : {}) });

describe('重播时间表', () => {
  it('空事件返回空', () => expect(replayOffsets([])).toEqual([]));

  it('真实很短时按原速，单调不减，首条为 0', () => {
    const out = replayOffsets([ev(0), ev(500), ev(1500)]);
    expect(out[0]).toBe(0);
    expect(out.at(-1)).toBeCloseTo(1500, 0);
    out.slice(1).forEach((v, i) => expect(v).toBeGreaterThanOrEqual(out[i]));
  });

  it('真实很长（10 分钟、上千条）时，放映加首尾停顿也不超过 20 秒', () => {
    const many = Array.from({ length: 1200 }, (_, i) => ev(i * 500, i % 3 ? 'matte' : 'compose', true));
    const out = replayOffsets(many);
    expect(out.at(-1)).toBeLessThanOrEqual(REPLAY_BUDGET_MS + 1e-6);
    expect(REPLAY_LEAD_MS + REPLAY_BUDGET_MS + REPLAY_HOLD_MS).toBe(REPLAY_MAX_MS);
  });

  it('长间隔被压得比短间隔多；连续进度事件占的时间更少', () => {
    const out = replayOffsets([ev(0, 'asr'), ev(1000, 'cuts'), ev(101_000, 'matte'), ev(102_000, 'storyboard')]);
    const gaps = out.slice(1).map((v, i) => v - out[i]);
    expect(gaps[1] / gaps[0]).toBeLessThan(100);
    const plain = replayOffsets([ev(0, 'a'), ev(1000, 'matte'), ev(2000, 'matte'), ev(3000, 'b')]);
    const prog = replayOffsets([ev(0, 'a'), ev(1000, 'matte', true), ev(2000, 'matte', true), ev(3000, 'b')]);
    expect(prog[2] - prog[1]).toBeLessThan(plain[2] - plain[1]);
  });
});
