// 修改引擎对新版式（broll / pip / overlay）的支持：约束与归一化不回退
import { describe, expect, it } from 'vitest';
import { applyOps, type VersionState } from '../src/edit/apply.js';
import { checkOp } from '../src/edit/check.js';
import { buildEditContext, formatContext } from '../src/edit/context.js';
import { EditOpSchema } from '../src/edit/ops.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
import type { Broll, Shot } from '../src/storyboard/schema.js';
import { makeState } from './helpers/edit-state.js';

const B: Broll = { file: 'broll/site.jpg', kind: 'photo', focal: { x: 0.4, y: 0.5 } };
/** 第 1 个镜头（4–7 秒，无卡片全屏）带上素材 */
function withBroll(): VersionState {
  const s = makeState();
  return { ...s, storyboard: { ...s.storyboard, shots: s.storyboard.shots.map((sh, i) => (i === 1 ? { ...sh, broll: B } : sh)) } };
}
const layoutOf = (state: VersionState, i: number): Shot => state.storyboard.shots[i];

describe('setLayout：新版式', () => {
  it('操作模式接受 5 种版式', () => {
    for (const layout of ['split', 'full', 'broll', 'pip', 'overlay']) expect(EditOpSchema.safeParse({ type: 'setLayout', shotIndex: 0, layout }).success).toBe(true);
    expect(EditOpSchema.safeParse({ type: 'setLayout', shotIndex: 0, layout: 'wide' }).success).toBe(false);
  });
  it('带素材的镜头可改成全屏插入或画中画，归一化后版式与素材都保留，也不和相邻镜头合并', () => {
    for (const layout of ['broll', 'pip'] as const) {
      const next = applyOps(withBroll(), [{ type: 'setLayout', shotIndex: 1, layout }]);
      expect(next.storyboard.shots).toHaveLength(3);
      expect(layoutOf(next, 1)).toEqual({ start: 4, end: 7, layout, broll: B });
    }
  });
  it('没有素材不能改成全屏插入或画中画', () => {
    expect(() => applyOps(makeState(), [{ type: 'setLayout', shotIndex: 1, layout: 'broll' }])).toThrow('素材');
    expect(() => applyOps(makeState(), [{ type: 'setLayout', shotIndex: 1, layout: 'pip' }])).toThrow('素材');
  });
  it('带卡片的镜头改成全屏插入/画中画：卡片看不见，一并去掉', () => {
    const s = makeState();
    const state: VersionState = { ...s, storyboard: { ...s.storyboard, shots: s.storyboard.shots.map((sh, i) => (i === 0 ? { ...sh, broll: B } : sh)) } };
    const next = applyOps(state, [{ type: 'setLayout', shotIndex: 0, layout: 'pip' }]);
    expect(layoutOf(next, 0)).toEqual({ start: 0, end: 4, layout: 'pip', broll: B });
  });
  it('浮层：有卡片保留卡片；只有素材也可以；两者都没有不行', () => {
    expect(layoutOf(applyOps(makeState(), [{ type: 'setLayout', shotIndex: 0, layout: 'overlay' }]), 0)).toMatchObject({ layout: 'overlay', card: { template: 'title' } });
    expect(layoutOf(applyOps(withBroll(), [{ type: 'setLayout', shotIndex: 1, layout: 'overlay' }]), 1)).toEqual({ start: 4, end: 7, layout: 'overlay', broll: B });
    expect(() => applyOps(makeState(), [{ type: 'setLayout', shotIndex: 1, layout: 'overlay' }])).toThrow('卡片或素材');
  });
  it('分屏：无卡片但有素材时允许（上半屏铺素材）', () => {
    expect(layoutOf(applyOps(withBroll(), [{ type: 'setLayout', shotIndex: 1, layout: 'split' }]), 1)).toEqual({ start: 4, end: 7, layout: 'split', broll: B });
  });
  it('cta 只能全屏', () => {
    const s = makeState();
    const cta: Shot = { start: 7, end: 10, layout: 'full', broll: B, card: { template: 'cta', props: { actions: ['关注'] } } };
    const state: VersionState = { ...s, storyboard: { ...s.storyboard, shots: [...s.storyboard.shots.slice(0, 2), cta] } };
    for (const layout of ['broll', 'pip', 'overlay'] as const) expect(() => applyOps(state, [{ type: 'setLayout', shotIndex: 2, layout }])).toThrow('cta');
  });
});

describe('预检与上下文', () => {
  it('上下文标出带素材的镜头；预检与执行的约束一致', () => {
    const ctx = buildEditContext(withBroll(), '');
    expect(ctx.shots[1].broll).toBe(true);
    expect(ctx.shots[0].broll).toBeUndefined();
    expect(formatContext(ctx)).toContain('#1 [4-7] full 无卡片 带素材');
    expect(checkOp({ type: 'setLayout', shotIndex: 1, layout: 'broll' }, ctx)).toBeNull();
    expect(checkOp({ type: 'setLayout', shotIndex: 0, layout: 'pip' }, ctx)).toContain('素材');
    expect(checkOp({ type: 'setLayout', shotIndex: 0, layout: 'overlay' }, ctx)).toBeNull();
    expect(checkOp({ type: 'setLayout', shotIndex: 1, layout: 'split' }, ctx)).toBeNull();
    expect(checkOp({ type: 'setLayout', shotIndex: 1, layout: 'overlay' }, buildEditContext(makeState(), ''))).toContain('卡片或素材');
  });
});

describe('归一化：新版式不被打回全屏', () => {
  it('无卡片的全屏插入保留且不与相邻全屏合并；缺素材的画中画退回全屏并合并', () => {
    const raw = { shots: [{ start: 0, end: 2, layout: 'full' }, { start: 2, end: 4, layout: 'broll', broll: B }, { start: 4, end: 6, layout: 'full' }, { start: 6, end: 8, layout: 'pip' }] };
    const { storyboard } = normalizeStoryboard(raw, 8, []);
    expect(storyboard.shots.map((s) => [s.start, s.end, s.layout])).toEqual([[0, 2, 'full'], [2, 4, 'broll'], [4, 8, 'full']]);
    expect(storyboard.shots[1].broll).toEqual(B);
  });
});
