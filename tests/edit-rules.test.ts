import { describe, expect, it } from 'vitest';
import type { Track } from '../src/assets/catalog.js';
import { applyOps } from '../src/edit/apply.js';
import { remapStoryboard, retimeCaptions } from '../src/edit/retime.js';
import { validateOps } from '../src/edit/validate.js';
import type { EditPlan as CutPlan } from '../src/cut/plan.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';
import { makeState } from './helpers/edit-state.js';

const tracks: Track[] = [];
const title = (t: string) => ({ template: 'title', props: { title: t } }) as const;
const visual = { source: 'generate', prompt: 'a red apple on desk' } as const;
const photo = { template: 'photo', props: { visual } } as const;
const hook = { template: 'hook', props: { index: 1, total: 1, headline: '开场钩子', highlight: [] } } as const;
const cta: CardSpec = { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } };

/** 24 秒、四个镜头的状态：0-6 标题、6-12 标题、12-16 标题、16-24 全屏 */
function longState() {
  const shots: Shot[] = [
    { start: 0, end: 6, layout: 'split', card: title('一') },
    { start: 6, end: 12, layout: 'split', card: title('二') },
    { start: 12, end: 16, layout: 'split', card: title('三') },
    { start: 16, end: 24, layout: 'full' },
  ];
  const base = makeState();
  return { ...base, plan: { ...base.plan, outputDurationSec: 24 }, storyboard: { ...base.storyboard, shots } };
}

describe('validateOps：来源与参数', () => {
  it('不是数组整体拒绝', () => {
    expect(validateOps('x', makeState(), tracks)).toEqual({ ops: [], dropped: ['操作列表格式不对'] });
  });

  it('背景只接受预设和一句话：file 类和未知预设被拒', () => {
    const res = validateOps([
      { type: 'setBackground', spec: { kind: 'file', path: '/etc/passwd' } },
      { type: 'setBackground', spec: { kind: 'preset', id: '../../x' } },
      { type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } },
    ], makeState(), tracks);
    expect(res.ops).toEqual([{ type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } }]);
    expect(res.dropped).toHaveLength(2);
  });

  it('后一条看到前一条的结果；被拒的不影响后续', () => {
    const res = validateOps([
      { type: 'replaceCard', shotIndex: 1, card: photo },
      { type: 'setLayout', shotIndex: 1, layout: 'full' },
      { type: 'editCaption', index: 9, text: 'x' },
    ], makeState(), tracks);
    expect(res.ops.map((o) => o.type)).toEqual(['replaceCard', 'setLayout']);
    expect(res.dropped).toHaveLength(1);
  });
});

describe('I1：卡片不接受模型给的素材文件', () => {
  it('image / video 路径被拒（含 ../../etc/passwd），photo 没有 visual 也被拒', () => {
    const res = validateOps([
      { type: 'replaceCard', shotIndex: 2, card: { template: 'photo', props: { image: '../../etc/passwd', visual } } },
      { type: 'replaceCard', shotIndex: 2, card: { template: 'photo', props: { image: '../../etc/passwd' } } },
      { type: 'replaceCard', shotIndex: 2, card: { template: 'photo', props: { video: 'x.mp4' } } },
      { type: 'replaceCard', shotIndex: 2, card: { template: 'browser', props: { url: 'a.com', image: 'x.png' } } },
      { type: 'replaceCard', shotIndex: 2, card: { template: 'photo', props: { label: '空' } } },
    ], makeState(), tracks);
    expect(res.ops).toEqual([]);
    expect(res.dropped).toHaveLength(5);
    expect(res.dropped.join('')).toContain('image / video');
    expect(res.dropped.join('')).toContain('需要 visual');
  });

  it('带 visual 的 photo 通过，并且只触发 broll（见 stagesFor）', () => {
    expect(validateOps([{ type: 'replaceCard', shotIndex: 2, card: photo }], makeState(), tracks).ops).toHaveLength(1);
  });

  it('applyOps 自己也拒绝带文件的卡片', () => {
    expect(() => applyOps(makeState(), [{ type: 'replaceCard', shotIndex: 2, card: { template: 'photo', props: { image: '../../etc/passwd' } } }])).toThrow('image / video');
  });
});

describe('I2：版式规则', () => {
  const run = (op: unknown, state = longState()) => validateOps([op], state, tracks);

  it('cta 只能放在最后一个镜头', () => {
    const res = run({ type: 'replaceCard', shotIndex: 1, card: cta });
    expect(res.ops).toEqual([]);
    expect(res.dropped[0]).toContain('cta');
  });

  it('hook 超出 15 秒窗口被拒；窗口内允许并在整批结束后重新编号', () => {
    const late = run({ type: 'replaceCard', shotIndex: 3, card: hook });
    expect(late.ops).toEqual([]);
    expect(late.dropped[0]).toContain('hook');
    const state = longState();
    const early = validateOps([{ type: 'replaceCard', shotIndex: 0, card: hook }, { type: 'replaceCard', shotIndex: 1, card: { ...hook, props: { ...hook.props, headline: '第二个钩子' } } }], state, tracks);
    expect(early.ops).toHaveLength(2);
    const next = applyOps(state, early.ops);
    expect(next.storyboard.shots.map((s) => (s.card?.template === 'hook' ? [s.card.props.index, s.card.props.total] : null)).slice(0, 2)).toEqual([[1, 2], [2, 2]]);
  });

  it('第 4 张 hook 被拒', () => {
    const three = validateOps([0, 1, 2].map((i) => ({ type: 'replaceCard', shotIndex: i, card: hook })), longState(), tracks);
    expect(three.ops).toHaveLength(3);
    const state = { ...longState(), storyboard: { ...longState().storyboard, shots: [
      { start: 0, end: 4, layout: 'split' as const, card: title('a') }, { start: 4, end: 8, layout: 'split' as const, card: title('b') },
      { start: 8, end: 12, layout: 'split' as const, card: title('c') }, { start: 12, end: 14, layout: 'split' as const, card: title('d') },
    ] } };
    const four = validateOps([0, 1, 2, 3].map((i) => ({ type: 'replaceCard', shotIndex: i, card: hook })), state, tracks);
    expect(four.ops).toHaveLength(3);
    expect(four.dropped).toHaveLength(1);
  });

  it('给 8 秒以上的全屏镜头放卡片被拒', () => {
    const state = { ...longState(), storyboard: { ...longState().storyboard, shots: [{ start: 0, end: 20, layout: 'full' as const }, { start: 20, end: 24, layout: 'split' as const, card: title('尾') }] } };
    const res = run({ type: 'replaceCard', shotIndex: 0, card: title('长') }, state);
    expect(res.ops).toEqual([]);
    expect(res.dropped[0]).toContain('最长 8 秒');
  });

  it('cta 不能改成分屏；最后一个镜头换成 cta 可以', () => {
    const ctaState = { ...longState(), storyboard: { ...longState().storyboard, shots: [
      { start: 0, end: 20, layout: 'split' as const, card: title('主') }, { start: 20, end: 24, layout: 'full' as const, card: cta },
    ] } };
    const res = run({ type: 'setLayout', shotIndex: 1, layout: 'split' }, ctaState);
    expect(res.ops).toEqual([]);
    expect(res.dropped[0]).toContain('cta');
    expect(run({ type: 'replaceCard', shotIndex: 1, card: cta }, ctaState).ops).toHaveLength(1);
    expect(() => applyOps(ctaState, [{ type: 'setLayout', shotIndex: 1, layout: 'split' }])).toThrow('cta');
  });
});

describe('retimeCaptions / remapStoryboard', () => {
  const oldPlan = makeState().plan;
  const plan = (keep: CutPlan['keep']): CutPlan => ({ keep, sourceDurationSec: 14, outputDurationSec: keep.reduce((s, r) => s + r.end - r.start, 0) });

  it('字幕按原片位置换算到新成片时间，文字不变，整句被剪掉的丢弃', () => {
    const state = makeState();
    const out = retimeCaptions(state.captions, oldPlan, plan([{ start: 1, end: 4 }, { start: 7, end: 13 }]));
    expect(out).toEqual([
      { start: 0, end: 3, text: '第一句话' },
      { start: 3, end: 5, text: '第二句话' },
      { start: 5, end: 9, text: '第三句话' },
    ]);
    const gone = retimeCaptions(state.captions, oldPlan, plan([{ start: 7, end: 13 }]));
    expect(gone.map((c) => c.text)).toEqual(['第二句话', '第三句话']);
  });

  it('用户改过的字幕文字在重新对时后保留', () => {
    const state = applyOps(makeState(), [{ type: 'editCaption', index: 0, text: '改过的' }]);
    expect(retimeCaptions(state.captions, oldPlan, plan([{ start: 0, end: 14 }]))[0].text).toBe('改过的');
  });

  it('分镜平移：卡片保留，时间按新方案，首尾对齐新成片', () => {
    const state = makeState();
    const sb = remapStoryboard(oldPlan, plan([{ start: 1, end: 4 }, { start: 7, end: 13 }]), state.storyboard);
    expect(sb.shots.map((s) => [s.start, s.end, s.card?.template])).toEqual([[0, 3, 'title'], [3, 6, undefined], [6, 9, 'photo']]);
    expect(sb.bgm).toBe('chill');
  });

  it('完全落在被删区间的镜头删掉，卡片镜头保留其卡片', () => {
    const sb = remapStoryboard(oldPlan, plan([{ start: 7, end: 13 }]), makeState().storyboard);
    expect(sb.shots).toHaveLength(2);
    expect(sb.shots[0].start).toBe(0);
    expect(sb.shots[1]).toMatchObject({ end: 6, card: { template: 'photo' } });
  });

  it('过短的镜头并入相邻镜头', () => {
    const sb = remapStoryboard(oldPlan, plan([{ start: 1, end: 5 }, { start: 7, end: 7.5 }, { start: 9.9, end: 13 }]), makeState().storyboard);
    expect(sb.shots.map((s) => [s.start, s.end, s.card?.template])).toEqual([[0, 4.6, 'title'], [4.6, 7.6, 'photo']]);
  });

  it('不修改入参', () => {
    const state = makeState();
    const frozen = JSON.stringify(state);
    remapStoryboard(oldPlan, plan([{ start: 1, end: 4 }, { start: 7, end: 13 }]), state.storyboard);
    retimeCaptions(state.captions, oldPlan, plan([{ start: 1, end: 4 }]));
    expect(JSON.stringify(state)).toBe(frozen);
  });
});
