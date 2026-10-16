// 修改引擎：换一张 B-roll（replaceBroll）
import { describe, expect, it } from 'vitest';
import { applyOps, stagesFor, type VersionState } from '../src/edit/apply.js';
import { EditOpSchema } from '../src/edit/ops.js';
import { validateOps } from '../src/edit/plan.js';
import type { Broll } from '../src/storyboard/schema.js';
import { makeState } from './helpers/edit-state.js';

const B: Broll = { file: 'broll/site.jpg', kind: 'photo', focal: { x: 0.4, y: 0.5 } };
function withBroll(): VersionState {
  const s = makeState();
  return { ...s, storyboard: { ...s.storyboard, shots: s.storyboard.shots.map((sh, i) => (i === 1 ? { ...sh, layout: 'broll', broll: B } : sh)) } };
}

describe('replaceBroll', () => {
  it('schema：只要 shotIndex', () => {
    expect(EditOpSchema.safeParse({ type: 'replaceBroll', shotIndex: 1 }).success).toBe(true);
    expect(EditOpSchema.safeParse({ type: 'replaceBroll', shotIndex: -1 }).success).toBe(false);
    expect(EditOpSchema.safeParse({ type: 'replaceBroll' }).success).toBe(false);
  });

  it('只跑素材与成片两个阶段', () => {
    expect([...stagesFor([{ type: 'replaceBroll', shotIndex: 1 }])].sort()).toEqual(['broll', 'compose']);
  });

  it('validateOps：镜头越界、镜头不带素材的丢弃并说明原因；带素材的通过，状态不变（素材在素材步骤里重做）', () => {
    const state = withBroll();
    const ok = validateOps([{ type: 'replaceBroll', shotIndex: 1 }], state, []);
    expect(ok.ops).toEqual([{ type: 'replaceBroll', shotIndex: 1 }]);
    expect(applyOps(state, ok.ops)).toEqual(state);
    const bad = validateOps([{ type: 'replaceBroll', shotIndex: 0 }, { type: 'replaceBroll', shotIndex: 99 }], state, []);
    expect(bad.ops).toEqual([]);
    expect(bad.dropped[0]).toContain('没有 B-roll 素材');
    expect(bad.dropped[1]).toContain('没有第 99 个镜头');
  });
});
