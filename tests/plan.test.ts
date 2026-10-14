import { describe, expect, it } from 'vitest';
import { buildEditPlan, cutsToRanges, mapToOutput } from '../src/cut/plan.js';

const opts = { pad: 0.1, mergeGap: 0.3, minKeep: 0.25 };

describe('cutsToRanges', () => {
  it('从首 token 的 start 到末 token 的 end', () => {
    const tokens = [{ text: 'a', start: 1, end: 1.2 }, { text: 'b', start: 1.2, end: 1.5 }, { text: 'c', start: 2, end: 2.2 }];
    expect(cutsToRanges([{ from: 0, to: 1, type: 'repeat', reason: '' }], tokens)).toEqual([{ start: 1, end: 1.5 }]);
  });
});

describe('buildEditPlan', () => {
  it('语音段加边距、短间隔合并、长停顿删除', () => {
    const plan = buildEditPlan([{ start: 1, end: 2 }, { start: 2.2, end: 3 }, { start: 5, end: 6 }], [], 8, opts);
    expect(plan.keep).toEqual([{ start: 0.9, end: 3.1 }, { start: 4.9, end: 6.1 }]);
    expect(plan.outputDurationSec).toBeCloseTo(3.4, 5);
    expect(plan.sourceDurationSec).toBe(8);
  });

  it('扣掉剪切区间，并丢弃过短碎片', () => {
    const plan = buildEditPlan([{ start: 0, end: 4 }], [{ start: 1, end: 2 }, { start: 3.9, end: 4.05 }], 4, opts);
    expect(plan.keep).toEqual([{ start: 0, end: 1 }, { start: 2, end: 3.9 }]);
  });

  it('丢弃宽度为正但短于 minKeep 的残留碎片', () => {
    const plan = buildEditPlan([{ start: 0, end: 4 }], [{ start: 1, end: 3.9 }], 4, opts);
    expect(plan.keep).toEqual([{ start: 0, end: 1 }]);
  });

  it('边距不超出片头片尾', () => {
    const plan = buildEditPlan([{ start: 0.05, end: 3.98 }], [], 4, opts);
    expect(plan.keep).toEqual([{ start: 0, end: 4 }]);
  });
});

describe('mapToOutput', () => {
  const keep = [{ start: 1, end: 2 }, { start: 4, end: 6 }];
  it('映射到成片时间', () => {
    expect(mapToOutput(1.5, keep)).toBeCloseTo(0.5);
    expect(mapToOutput(4.5, keep)).toBeCloseTo(1.5);
  });
  it('被剪掉的时刻返回 null', () => {
    expect(mapToOutput(3, keep)).toBeNull();
  });
});
