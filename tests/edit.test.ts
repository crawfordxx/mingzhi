import { describe, expect, it } from 'vitest';
import { applyOps, stagesFor } from '../src/edit/apply.js';
import type { EditOp } from '../src/edit/plan.js';
import { parseTimeRefs, shotForTime } from '../src/edit/refs.js';
import { makeState } from './helpers/edit-state.js';

/** 剪辑节奏类操作：字幕重新对时、分镜平移，不重取素材 */
const RETIME = ['cut', 'matte', 'captions', 'storyboard', 'compose'];
const stages = (...ops: EditOp[]): string[] => [...stagesFor(ops)].sort();
const card = { template: 'title', props: { title: '新标题' } } as const;

function deepFreeze<T>(o: T): T {
  if (o && typeof o === 'object') {
    Object.freeze(o);
    for (const v of Object.values(o)) deepFreeze(v);
  }
  return o;
}

describe('parseTimeRefs', () => {
  it('识别 @mm:ss 与后随的卡片名', () => {
    expect(parseTimeRefs('把 @01:05 对比条卡 改成大数字')).toEqual([{ sec: 65, label: '对比条卡' }]);
  });
  it('单个数字分钟、无卡片名', () => {
    expect(parseTimeRefs('看看@1:05')).toEqual([{ sec: 65 }]);
  });
  it('多个引用按出现顺序；没有引用返回空', () => {
    expect(parseTimeRefs('@00:03 和 @00:10 互换').map((r) => r.sec)).toEqual([3, 10]);
    expect(parseTimeRefs('没有引用，邮箱 a@b.com 12:30 开会')).toEqual([]);
  });
  it('秒数 >= 60 的不识别', () => {
    expect(parseTimeRefs('@01:75')).toEqual([]);
  });
  it('手打的 @时间：只认时间，后面的话不当卡片名（卡片名只认「插入」生成的模板名）', () => {
    expect(parseTimeRefs('@00:07 这张卡换成大字标题「2. 手机放到另一个房间」')).toEqual([{ sec: 7 }]);
    expect(parseTimeRefs('@00:07 钩子卡2/3 换个图')).toEqual([{ sec: 7, label: '钩子卡2/3' }]);
    expect(parseTimeRefs('@00:07 纯人像')).toEqual([{ sec: 7, label: '纯人像' }]);
    expect(parseTimeRefs('@00:07 标题卡写得太长')).toEqual([{ sec: 7 }]);
  });
});

describe('shotForTime', () => {
  const shots = makeState().storyboard.shots;
  it('落在哪个镜头返回哪个序号（左闭右开）', () => {
    expect(shotForTime(shots, 0)).toBe(0);
    expect(shotForTime(shots, 4)).toBe(1);
    expect(shotForTime(shots, 9.9)).toBe(2);
  });
  it('超出范围取首/尾镜头，空列表返回 -1', () => {
    expect(shotForTime(shots, 99)).toBe(2);
    expect(shotForTime(shots, -1)).toBe(0);
    expect(shotForTime([], 1)).toBe(-1);
  });
});

describe('stagesFor', () => {
  it('setBackground → matte + compose', () => {
    expect(stages({ type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } })).toEqual(['compose', 'matte']);
  });
  it('replaceCard → compose；带待取素材的 visual 时还要 broll', () => {
    expect(stages({ type: 'replaceCard', shotIndex: 0, card })).toEqual(['compose']);
    const withVisual = { template: 'photo', props: { visual: { source: 'generate', prompt: 'a red apple on desk' } } } as const;
    expect(stages({ type: 'replaceCard', shotIndex: 0, card: withVisual })).toEqual(['broll', 'compose']);
  });
  it('regenerateVisual → broll + compose', () => {
    expect(stages({ type: 'regenerateVisual', shotIndex: 2, visual: { source: 'generate', prompt: 'a red apple on desk' } })).toEqual(['broll', 'compose']);
  });
  it('setLayout / editCaption / setCaptionStyle / setBgm → compose', () => {
    expect(stages({ type: 'setLayout', shotIndex: 0, layout: 'full' })).toEqual(['compose']);
    expect(stages({ type: 'editCaption', index: 0, text: 'x' })).toEqual(['compose']);
    expect(stages({ type: 'setCaptionStyle', id: 'wenkai' })).toEqual(['compose']);
    expect(stages({ type: 'setBgm', bgm: 'none' })).toEqual(['compose']);
  });
  it('setCoverStyle 只重做封面，不重跑任何阶段', () => {
    expect(stages({ type: 'setCoverStyle', id: 'swiss' })).toEqual([]);
  });
  it('pace / removeSpan / restoreSpan → 重剪阶段，不含 broll', () => {
    expect(stages({ type: 'pace', direction: 'tighter' })).toEqual([...RETIME].sort());
    expect(stages({ type: 'removeSpan', fromSec: 1, toSec: 2 })).toEqual([...RETIME].sort());
    expect(stages({ type: 'restoreSpan', fromSec: 5, toSec: 7 })).toEqual([...RETIME].sort());
  });
  it('空操作没有阶段；剪辑类与换图类合并取并集', () => {
    expect(stages()).toEqual([]);
    expect(stages({ type: 'pace', direction: 'looser' }, { type: 'regenerateVisual', shotIndex: 2, visual: { source: 'generate', prompt: 'a red apple on desk' } })).toEqual(['broll', ...RETIME].sort());
  });
  it('多个操作取并集', () => {
    expect(stages({ type: 'setBgm', bgm: 'none' }, { type: 'setBackground', spec: { kind: 'prompt', prompt: '海边咖啡馆' } })).toEqual(['compose', 'matte']);
  });
});

describe('applyOps', () => {
  it('不修改入参（深冻结后不抛错），返回新对象', () => {
    const state = deepFreeze(makeState());
    const next = applyOps(state, [
      { type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } },
      { type: 'editCaption', index: 1, text: '改过了' },
      { type: 'replaceCard', shotIndex: 0, card },
      { type: 'pace', direction: 'tighter' },
      { type: 'removeSpan', fromSec: 1, toSec: 2 },
    ]);
    expect(next).not.toBe(state);
    expect(state.settings.background).toEqual({ kind: 'preset', id: 'study' });
    expect(state.captions[1].text).toBe('第二句话');
  });

  it('每种操作单独应用到深冻结的状态都不抛错、不改入参', () => {
    const visual = { source: 'generate', prompt: 'a red apple on desk' } as const;
    const every: EditOp[] = [
      { type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } },
      { type: 'setCaptionStyle', id: 'wenkai' },
      { type: 'setCoverStyle', id: 'swiss' },
      { type: 'setBgm', bgm: 'none' },
      { type: 'setBgm', bgm: 'tech' },
      { type: 'replaceCard', shotIndex: 0, card },
      { type: 'setLayout', shotIndex: 0, layout: 'full' },
      { type: 'regenerateVisual', shotIndex: 2, visual },
      { type: 'editCaption', index: 0, text: '改' },
      { type: 'pace', direction: 'tighter' },
      { type: 'pace', direction: 'looser' },
      { type: 'removeSpan', fromSec: 3, toSec: 6 },
      { type: 'restoreSpan', fromSec: 5, toSec: 7 },
    ];
    for (const op of every) {
      const state = deepFreeze(makeState());
      expect(() => applyOps(state, [op]), op.type).not.toThrow();
    }
    const all = deepFreeze(makeState());
    expect(() => applyOps(all, every.filter((o) => o.type !== 'setLayout'))).not.toThrow();
  });

  it('空操作返回内容相同的状态', () => {
    const state = makeState();
    expect(applyOps(state, [])).toEqual(state);
  });

  it('setBackground / setCaptionStyle / setCoverStyle', () => {
    const next = applyOps(makeState(), [
      { type: 'setBackground', spec: { kind: 'prompt', prompt: '海边咖啡馆' } },
      { type: 'setCaptionStyle', id: 'wenkai' },
      { type: 'setCoverStyle', id: 'swiss' },
    ]);
    expect(next.settings.background).toEqual({ kind: 'prompt', prompt: '海边咖啡馆' });
    expect(next.settings.captionStyle).toBe('wenkai');
    expect(next.coverStyle).toBe('swiss');
  });

  it('setBgm：none / 曲目 id 映射到 AudioOptions，情绪改分镜 bgm 并回到 auto', () => {
    expect(applyOps(makeState(), [{ type: 'setBgm', bgm: 'none' }]).bgm).toEqual({ bgm: 'none' });
    expect(applyOps(makeState(), [{ type: 'setBgm', bgm: 'track-7' }]).bgm).toEqual({ bgm: 'track-7' });
    const mood = applyOps({ ...makeState(), bgm: { bgm: 'none' } }, [{ type: 'setBgm', bgm: 'upbeat' }]);
    expect(mood.bgm).toEqual({ bgm: 'auto' });
    expect(mood.storyboard.bgm).toBe('upbeat');
  });

  it('replaceCard 换卡并按 zod 校验；非法卡片抛中文错误；越界抛错', () => {
    const next = applyOps(makeState(), [{ type: 'replaceCard', shotIndex: 1, card }]);
    expect(next.storyboard.shots[1]).toMatchObject({ layout: 'split', card });
    expect(() => applyOps(makeState(), [{ type: 'replaceCard', shotIndex: 0, card: { template: 'title', props: {} } as never }])).toThrow('卡片');
    expect(() => applyOps(makeState(), [{ type: 'replaceCard', shotIndex: 9, card }])).toThrow('镜头');
  });

  it('setLayout：变全屏去掉卡片（cta 除外）；无卡片的镜头不能变分屏', () => {
    const next = applyOps(makeState(), [{ type: 'setLayout', shotIndex: 0, layout: 'full' }]);
    // 变成无卡片的全屏镜头后，与相邻的全屏镜头合并
    expect(next.storyboard.shots[0]).toEqual({ start: 0, end: 7, layout: 'full' });
    expect(applyOps(makeState(), [{ type: 'setLayout', shotIndex: 2, layout: 'split' }]).storyboard.shots[2].layout).toBe('split');
    expect(() => applyOps(makeState(), [{ type: 'setLayout', shotIndex: 1, layout: 'split' }])).toThrow('卡片');
  });

  it('regenerateVisual 写入 visual 并清掉旧图', () => {
    const visual = { source: 'generate', prompt: 'a red apple on desk' } as const;
    const next = applyOps(makeState(), [{ type: 'regenerateVisual', shotIndex: 2, visual }]);
    expect(next.storyboard.shots[2].card).toEqual({ template: 'photo', props: { label: '图', visual } });
    expect(() => applyOps(makeState(), [{ type: 'regenerateVisual', shotIndex: 0, visual }])).toThrow('素材');
  });

  it('editCaption 改文字，越界抛错', () => {
    expect(applyOps(makeState(), [{ type: 'editCaption', index: 2, text: '改' }]).captions[2].text).toBe('改');
    expect(() => applyOps(makeState(), [{ type: 'editCaption', index: 5, text: '改' }])).toThrow('字幕');
  });

  it('pace tighter 缩小 pad/mergeGap，looser 放大，且有上下限', () => {
    const base = makeState().cutOptions;
    const tight = applyOps(makeState(), [{ type: 'pace', direction: 'tighter' }]).cutOptions;
    const loose = applyOps(makeState(), [{ type: 'pace', direction: 'looser' }]).cutOptions;
    expect(tight.pad).toBeLessThan(base.pad);
    expect(tight.mergeGap).toBeLessThan(base.mergeGap);
    expect(loose.pad).toBeGreaterThan(base.pad);
    expect(loose.mergeGap).toBeGreaterThan(base.mergeGap);
    const many = applyOps(makeState(), Array.from({ length: 30 }, () => ({ type: 'pace', direction: 'tighter' }) as const)).cutOptions;
    expect(many.pad).toBeGreaterThan(0);
    expect(many.mergeGap).toBeGreaterThan(0);
  });

  it('removeSpan：成片时间换算成原片时间（跨保留区间会拆开）', () => {
    // 成片 [3,6] = 原片 [4,5] + 原片 [7,9]
    const next = applyOps(makeState(), [{ type: 'removeSpan', fromSec: 3, toSec: 6 }]);
    expect(next.extraCuts).toEqual([{ start: 4, end: 5 }, { start: 7, end: 9 }]);
  });

  it('removeSpan 恰好落在保留段接缝处时只取接缝另一侧', () => {
    expect(applyOps(makeState(), [{ type: 'removeSpan', fromSec: 4, toSec: 5 }]).extraCuts).toEqual([{ start: 7, end: 8 }]);
  });

  it('removeSpan 删到成片不足 1 秒时抛错', () => {
    expect(() => applyOps(makeState(), [{ type: 'removeSpan', fromSec: 0, toSec: 9.5 }])).toThrow('不足 1 秒');
    expect(() => applyOps(makeState(), [{ type: 'removeSpan', fromSec: 0, toSec: 5 }, { type: 'removeSpan', fromSec: 5, toSec: 10 }])).toThrow('不足 1 秒');
  });

  it('editCaption 超过每行宽度上限时抛错', () => {
    expect(() => applyOps(makeState(), [{ type: 'editCaption', index: 0, text: '这是一句特别特别特别特别长的字幕' }])).toThrow('字幕太长');
  });

  it('removeSpan 的范围非法时抛错', () => {
    expect(() => applyOps(makeState(), [{ type: 'removeSpan', fromSec: 5, toSec: 2 }])).toThrow('时间');
    expect(() => applyOps(makeState(), [{ type: 'removeSpan', fromSec: 20, toSec: 30 }])).toThrow('时间');
  });

  it('restoreSpan（原片时间）加入恢复列表，并从额外删除里扣掉重叠部分；removeSpan 反向同理', () => {
    const removed = applyOps(makeState(), [{ type: 'removeSpan', fromSec: 3, toSec: 6 }]);
    const back = applyOps(removed, [{ type: 'restoreSpan', fromSec: 4.5, toSec: 8 }]);
    expect(back.restored).toEqual([{ start: 4.5, end: 8 }]);
    expect(back.extraCuts).toEqual([{ start: 4, end: 4.5 }, { start: 8, end: 9 }]);
    // 成片 [3.5,4.5] = 原片 [4.5,5] + [7,7.5]，从恢复列表里扣掉
    const again = applyOps(back, [{ type: 'removeSpan', fromSec: 3.5, toSec: 4.5 }]);
    expect(again.restored).toEqual([{ start: 5, end: 7 }, { start: 7.5, end: 8 }]);
  });

  it('同一批里的 removeSpan 都按应用前的成片时间换算', () => {
    const next = applyOps(makeState(), [{ type: 'removeSpan', fromSec: 0, toSec: 1 }, { type: 'removeSpan', fromSec: 7, toSec: 8 }]);
    expect(next.extraCuts).toEqual([{ start: 1, end: 2 }, { start: 10, end: 11 }]);
  });
});
