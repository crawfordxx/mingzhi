// 局部重做与规则复检不撤已放好的素材：首帧改钩子留住 B-roll；浮层降级保留素材小窗
import { describe, expect, it } from 'vitest';
import { planRedo } from '../src/qa/film-redo.js';
import type { FilmReport } from '../src/qa/film.js';
import { applyStoryboardRules } from '../src/storyboard/rules.js';
import type { Broll, CardSpec, Shot } from '../src/storyboard/schema.js';

const pic: Broll = { file: 'broll/paid.jpg', kind: 'photo', focal: { x: 0.4, y: 0.5 }, label: { kind: 'ai', text: 'AI 生成' } };
const title = (t: string): CardSpec => ({ template: 'title', props: { title: t } });
const ev = (t: string): CardSpec => ({ template: 'evidenceList', props: { title: t, rows: [{ badge: '要点', text: '一行' }] } });
const firstFrame: FilmReport = { ok: false, durationSec: 20, metrics: [{ id: 'firstFrame', label: '首帧', value: 0.9, limit: 0.8, ok: false, detail: '空', shots: [0] }], templates: [], skipped: [] };

describe('首帧改钩子保留原来的 B-roll', () => {
  it('第 1 镜整段改钩子：B-roll（焦点、角标）留作钩子的铺图底', () => {
    const shots: Shot[] = [{ start: 0, end: 3, layout: 'split', card: title('开场'), broll: pic }, { start: 3, end: 20, layout: 'full' }];
    const plan = planRedo({ shots }, firstFrame, [{ start: 0, end: 3, text: '开场白' }], 20);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 0, kind: 'hook' })]);
    expect(plan.storyboard.shots[0]).toMatchObject({ layout: 'split', card: { template: 'hook', props: { headline: '开场' } }, broll: pic });
  });
  it('第 1 镜是全屏素材：改钩子后素材仍在', () => {
    const shots: Shot[] = [{ start: 0, end: 3, layout: 'broll', broll: pic }, { start: 3, end: 20, layout: 'full' }];
    const plan = planRedo({ shots }, firstFrame, [{ start: 0.2, end: 3, text: '开场白' }], 20);
    expect(plan.storyboard.shots[0]).toMatchObject({ card: { template: 'hook' }, broll: pic });
  });
});

describe('规则复检降级浮层卡片时保留素材', () => {
  it('连用的第 3 张卡在浮层镜头上：去掉卡片，素材小窗保留', () => {
    const shots: Shot[] = [
      { start: 0, end: 5, layout: 'split', card: ev('一') },
      { start: 5, end: 10, layout: 'split', card: ev('二') },
      { start: 10, end: 20, layout: 'overlay', card: ev('三'), broll: pic },
      { start: 20, end: 25, layout: 'split', card: title('四') },
      { start: 25, end: 30, layout: 'split', card: title('五') },
      { start: 30, end: 100, layout: 'full' },
    ];
    const r = applyStoryboardRules(shots, 100);
    expect(r.shots[2]).toEqual({ start: 10, end: 20, layout: 'overlay', broll: pic });
  });
});
