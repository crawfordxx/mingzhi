import { describe, expect, it } from 'vitest';
import { personTransform } from '../src/compose/layout.js';
import type { Shot, TalkProps } from '../src/storyboard/schema.js';
import { transformAt } from '../render/layers/PersonLayer.js';

const p: TalkProps = { person: 'p.mp4', personWidth: 1080, personHeight: 1920, subject: null, captions: [], shots: [], durationSec: 10 };
const split = personTransform('split', null, 1080, 1920);
const full = personTransform('full', null, 1080, 1920);

describe('人像版式过渡', () => {
  it('上一个镜头短于过渡时长：下一次过渡从当时的实际位置开始，不跳变', () => {
    const shots: Shot[] = [{ start: 0, end: 5, layout: 'split' }, { start: 5, end: 5.2, layout: 'full' }, { start: 5.2, end: 10, layout: 'split' }];
    const before = transformAt(shots, 5.2 - 1e-9, p);
    const after = transformAt(shots, 5.2, p);
    expect(before.y).toBeGreaterThan(full.y);
    expect(before.y).toBeLessThan(split.y);
    expect(after.y).toBeCloseTo(before.y, 3);
    expect(transformAt(shots, 9, p)).toEqual(split);
  });
  it('版式相同但上一个镜头还在过渡中：继续过渡到位，不跳变', () => {
    const shots: Shot[] = [{ start: 0, end: 5, layout: 'split' }, { start: 5, end: 5.2, layout: 'full' }, { start: 5.2, end: 10, layout: 'full' }];
    expect(transformAt(shots, 5.2, p).y).toBeCloseTo(transformAt(shots, 5.2 - 1e-9, p).y, 3);
    expect(transformAt(shots, 9, p)).toEqual(full);
  });
  it('过渡结束后、首个镜头、镜头之外都直接取目标版式', () => {
    const shots: Shot[] = [{ start: 0, end: 5, layout: 'full' }, { start: 5, end: 10, layout: 'split' }];
    expect(transformAt(shots, 1, p)).toEqual(full);
    expect(transformAt(shots, 5.5, p)).toEqual(split);
    expect(transformAt(shots, 20, p)).toEqual(full);
  });
});
