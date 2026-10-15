import { describe, expect, it } from 'vitest';
import type { Track } from '../src/assets/catalog.js';
import { DUCK_DB, OPEN_DB, bgmEnvelope, dbAt, pickTrack, sfxCues } from '../src/audio/plan.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';
import { ctaClickTimes } from '../render/templates/Cta.js';
import { clickTimes } from '../render/templates/Toggles.js';

const cap = (start: number, end: number) => ({ start, end, text: 'x' });
const split = (start: number, end: number, card?: CardSpec): Shot => ({ start, end, layout: 'split', card });
const sfxOf = (shots: Shot[], name: string) => sfxCues(shots).filter((c) => c.sfx === name);

describe('bgmEnvelope', () => {
  it('三段字幕：短空隙不抬起，长空隙抬起并在下一句前压回，首尾淡入淡出', () => {
    const keys = bgmEnvelope([cap(0, 2), cap(2.2, 4), cap(5, 8)], 8);
    expect(keys).toEqual([
      { sec: 0, db: -60 },
      { sec: 0.5, db: DUCK_DB },
      { sec: 4, db: DUCK_DB },
      { sec: 4.3, db: OPEN_DB },
      { sec: 4.7, db: OPEN_DB },
      { sec: 5, db: DUCK_DB },
      { sec: 6.5, db: DUCK_DB },
      { sec: 8, db: -60 },
    ]);
  });
  it('空隙恰好 0.8 秒也抬起；0.79 秒不抬', () => {
    expect(bgmEnvelope([cap(0, 2), cap(2.8, 6)], 10).some((k) => k.db === OPEN_DB)).toBe(true);
    expect(bgmEnvelope([cap(0, 2), cap(2.79, 6)], 10).some((k) => k.db === OPEN_DB)).toBe(false);
  });
  it('关键帧时间严格递增、相邻同值不重复；字幕乱序也一样', () => {
    const keys = bgmEnvelope([cap(5, 8), cap(0, 2), cap(2.2, 4)], 8);
    keys.slice(1).forEach((k, i) => expect(k.sec).toBeGreaterThan(keys[i].sec));
    expect(bgmEnvelope([], 10)).toEqual([{ sec: 0, db: -60 }, { sec: 0.5, db: DUCK_DB }, { sec: 8.5, db: DUCK_DB }, { sec: 10, db: -60 }]);
  });
  it('淡入淡出区间内的空隙忽略；片子太短时两端按比例缩短', () => {
    expect(bgmEnvelope([cap(0, 0.1), cap(1.2, 3)], 10).some((k) => k.db === OPEN_DB)).toBe(false);
    const short = bgmEnvelope([], 1);
    expect(short[0]).toEqual({ sec: 0, db: -60 });
    expect(short[short.length - 1]).toEqual({ sec: 1, db: -60 });
    expect(bgmEnvelope([], 0)).toEqual([{ sec: 0, db: -60 }]);
  });
});

describe('dbAt', () => {
  const keys = [{ sec: 0, db: -60 }, { sec: 1, db: -20 }, { sec: 3, db: -10 }];
  it('关键帧之间线性插值', () => {
    expect(dbAt(keys, 0.5)).toBeCloseTo(-40);
    expect(dbAt(keys, 2)).toBeCloseTo(-15);
    expect(dbAt(keys, 1)).toBe(-20);
  });
  it('越界取端点；空关键帧取压低音量', () => {
    expect(dbAt(keys, -1)).toBe(-60);
    expect(dbAt(keys, 9)).toBe(-10);
    expect(dbAt([], 1)).toBe(DUCK_DB);
  });
});

describe('sfxCues', () => {
  const title: CardSpec = { template: 'title', props: { title: '标题' } };
  it('分屏带卡片的镜头开始处一个 enter；没有卡片的镜头没有音效', () => {
    const cues = sfxCues([split(2, 6, title), split(6, 9)]);
    expect(cues).toEqual([{ sec: 2, sfx: 'enter', volume: 0.35 }]);
  });
  it('toggles：每个 on 行一个 toggle，时间与模板 clickTimes 一致，off 行不响', () => {
    const card: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: false }, { label: 'c', on: true }] } };
    const toggles = sfxOf([split(10, 16, card)], 'toggle');
    expect(toggles.map((c) => c.sec)).toEqual(clickTimes(2, 6).map((t) => Math.round((10 + t) * 1000) / 1000));
    expect(toggles[0].sec).toBeCloseTo(10.6);
  });
  it('toggles：镜头很短时与模板同样压缩间隔', () => {
    const card: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: true }, { label: 'c', on: true }] } };
    const toggles = sfxOf([split(0, 2.2, card)], 'toggle');
    expect(toggles.map((c) => c.sec)).toEqual(clickTimes(3, 2.2).map((t) => Math.round(t * 1000) / 1000).filter((t, i, a) => i === 0 || t - a[i - 1] > 0.05));
  });
  it('cta：全屏镜头按 actions 数量点击，时间与 ctaClickTimes 一致，不放 enter', () => {
    const card: CardSpec = { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } };
    const cues = sfxCues([{ start: 20, end: 24, layout: 'full', card }]);
    expect(cues.every((c) => c.sfx === 'click')).toBe(true);
    expect(cues.map((c) => c.sec)).toEqual(ctaClickTimes(3, 4).map((t) => 20 + t));
    expect(cues.map((c) => c.sec)).toEqual([20.5, 21, 21.5]);
  });
  it('cta：一个 action 只有一次点击', () => {
    const card: CardSpec = { template: 'cta', props: { actions: ['关注'] } };
    expect(sfxCues([{ start: 0, end: 3, layout: 'full', card }])).toHaveLength(1);
  });
  it('bigNumber：纯数字在 0.1–0.7 秒每 0.1 秒一个轻音量 tick；非数字不滚也不响', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '35000', label: '星' } };
    const ticks = sfxOf([split(5, 9, num)], 'tick');
    expect(ticks.map((c) => c.sec)).toEqual([5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7]);
    expect(ticks.every((c) => c.volume === 0.15)).toBe(true);
    const text: CardSpec = { template: 'bigNumber', props: { value: '3 倍', label: '快' } };
    expect(sfxOf([split(5, 9, text)], 'tick')).toHaveLength(0);
  });
  it('browser：开始处是 load，不再叠 enter', () => {
    const card: CardSpec = { template: 'browser', props: { url: 'github.com' } };
    expect(sfxCues([split(3, 7, card)])).toEqual([{ sec: 3, sfx: 'load', volume: 0.35 }]);
  });
  it('chips：每个 yes 项一个 confirm，按全卡序号间隔 0.12 秒，no/maybe 不响', () => {
    const card: CardSpec = { template: 'chips', props: { groups: [
      { label: 'g1', items: [{ text: 'a', mark: 'yes' }, { text: 'b', mark: 'no' }] },
      { label: 'g2', items: [{ text: 'c', mark: 'yes' }, { text: 'd', mark: 'maybe' }, { text: 'e', mark: 'yes' }] },
    ] } };
    const confirms = sfxOf([split(0, 6, card)], 'confirm');
    expect(confirms.map((c) => c.sec)).toEqual([0.15, 0.39, 0.63]);
  });
  it('同一时刻（±0.05 秒）只保留一个，先出现的保留', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '9', label: 'x' } };
    // 前一镜头的 tick 落在 4.7，下一镜头 enter 在 4.72：只留前者
    const cues = sfxCues([split(4, 4.8, num), split(4.72, 8, title)]);
    expect(cues.find((c) => c.sfx === 'enter' && c.sec === 4.72)).toBeUndefined();
    expect(cues.slice(1).every((c, i) => c.sec - cues[i].sec > 0.05)).toBe(true);
  });
  it('晚于镜头结束的音效丢弃', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '9', label: 'x' } };
    expect(sfxOf([split(0, 0.45, num)], 'tick').map((c) => c.sec)).toEqual([0.1, 0.2, 0.3, 0.4]);
  });
});

describe('pickTrack', () => {
  const mk = (id: string, mood: Track['mood']): Track => ({ id, title: id, zip: 'z', entry: id, mood, energy: 1, durationSec: 100 });
  const tracks = [mk('c1', 'chill'), mk('c2', 'chill'), mk('c3', 'chill'), mk('t1', 'tech'), mk('t2', 'tech'), mk('u1', 'upbeat')];
  it('同 seed 结果稳定，且与曲库顺序无关', () => {
    expect(pickTrack(tracks, 'chill', 'job-1').id).toBe(pickTrack(tracks, 'chill', 'job-1').id);
    expect(pickTrack([...tracks].reverse(), 'chill', 'job-1').id).toBe(pickTrack(tracks, 'chill', 'job-1').id);
  });
  it('只从对应情绪里选，不同 seed 能选到不同曲目', () => {
    const picks = Array.from({ length: 30 }, (_, i) => pickTrack(tracks, 'tech', `s${i}`));
    expect(picks.every((t) => t.mood === 'tech')).toBe(true);
    expect(new Set(picks.map((t) => t.id)).size).toBe(2);
    expect(pickTrack(tracks, 'upbeat', 'any').id).toBe('u1');
  });
  it('该情绪没有曲目时退到全部曲目；曲库为空报错', () => {
    const noUpbeat = tracks.filter((t) => t.mood !== 'upbeat');
    expect(noUpbeat).toContain(pickTrack(noUpbeat, 'upbeat', 's'));
    expect(() => pickTrack([], 'chill', 's')).toThrow();
  });
});
