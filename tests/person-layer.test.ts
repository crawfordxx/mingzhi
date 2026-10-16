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

describe('新版式的人像位置', () => {
  const pip = personTransform('pip', null, 1080, 1920);
  const B = { file: 'broll/a.jpg', kind: 'photo' as const, focal: { x: 0.5, y: 0.5 } };
  it('全屏插入时人像停在上一个镜头的位置（被素材盖住），切回同版式时不动', () => {
    const shots: Shot[] = [{ start: 0, end: 5, layout: 'split' }, { start: 5, end: 7, layout: 'broll', broll: B }, { start: 7, end: 10, layout: 'split' }];
    expect(transformAt(shots, 6, p)).toEqual(split);
    expect(transformAt(shots, 7, p)).toEqual(split);
    expect(transformAt(shots, 7.2, p)).toEqual(split);
  });
  it('首个镜头就是全屏插入：人像按全屏', () => {
    expect(transformAt([{ start: 0, end: 2, layout: 'broll', broll: B }], 1, p)).toEqual(full);
  });
  it('全屏 → 画中画：切换瞬间不跳变，0.4 秒内收拢到小窗，之后停在小窗', () => {
    const shots: Shot[] = [{ start: 0, end: 5, layout: 'full' }, { start: 5, end: 9, layout: 'pip', broll: B }, { start: 9, end: 12, layout: 'full' }];
    const before = transformAt(shots, 5 - 1e-9, p);
    const at = transformAt(shots, 5, p);
    expect(at.scale).toBeCloseTo(before.scale, 6);
    expect(at.clip?.w ?? 1080).toBeCloseTo(1080, 3);
    const mid = transformAt(shots, 5.2, p);
    expect(mid.clip!.w).toBeLessThan(1080);
    expect(mid.clip!.w).toBeGreaterThan(360);
    expect(transformAt(shots, 5.5, p)).toEqual(pip);
    // 画中画 → 全屏：同样从小窗连续放大回去
    expect(transformAt(shots, 9, p).clip?.w).toBeCloseTo(360, 3);
    expect(transformAt(shots, 9.5, p)).toEqual(full);
  });
  it('画中画没有素材时按全屏（不在米色底上缩小窗）', () => {
    expect(transformAt([{ start: 0, end: 5, layout: 'full' }, { start: 5, end: 9, layout: 'pip' }], 6, p)).toEqual(full);
  });
});
