import type { VersionState } from '../../src/edit/apply.js';
import { DEFAULT_PLAN_OPTIONS } from '../../src/cut/plan.js';

/** 修改引擎测试用的版本状态：成片 10 秒，保留 [1,5] 与 [7,13]（原片 14 秒） */
export function makeState(): VersionState {
  return {
    settings: { background: { kind: 'preset', id: 'study' }, captionStyle: 'blade', budgetYuan: 5, broll: true, maxVideos: 1 },
    plan: { keep: [{ start: 1, end: 5 }, { start: 7, end: 13 }], sourceDurationSec: 14, outputDurationSec: 10 },
    captions: [
      { start: 0, end: 3, text: '第一句话' },
      { start: 3, end: 6, text: '第二句话' },
      { start: 6, end: 10, text: '第三句话' },
    ],
    storyboard: {
      shots: [
        { start: 0, end: 4, layout: 'split', card: { template: 'title', props: { title: '开场标题' } } },
        { start: 4, end: 7, layout: 'full' },
        { start: 7, end: 10, layout: 'split', card: { template: 'photo', props: { image: 'broll/a.jpg', label: '图' } } },
      ],
      bgm: 'chill',
    },
    coverStyle: 'bauhaus',
    bgm: { bgm: 'auto' },
    cutOptions: { ...DEFAULT_PLAN_OPTIONS },
    extraCuts: [],
    restored: [],
  };
}
