import { describe, expect, it } from 'vitest';
import type { SfxId, Track } from '../src/assets/catalog.js';
import { DUCK_DB, OPEN_DB, OUTRO_DB, PURE_NUMBER, TIMING, bgmEnvelope, dbAt, pickTrack, sfxCues } from '../src/audio/plan.js';
import { HOOK_HIT_SEC } from '../src/audio/sfx-plan.js';
import { HOOK_MARK_SEC, HOOK_MARK_START } from '../render/templates/timing.js';
import { SFX, sfxPath } from '../src/assets/catalog.js';
import { lastLoudSec, onsetSec, readWav, rmsPeakSec } from './helpers/wav.js';
// @ts-expect-error 合成脚本是 .mjs，没有类型声明
import { SPECS } from '../scripts/make-sfx.mjs';
import { ANCHOR_SEC, MAX_PER_SFX, MIN_KINDS, sfxKind, sfxStats, type SfxCue } from '../src/audio/sfx-map.js';
import { visualShots } from '../src/compose/layout.js';
import { FRESH_LEAD_SEC, cardLead } from '../src/compose/card-carry.js';
import { OUTRO_LOGO_SEC } from '../src/compose/ending.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';
import { COUNT_SEC, COUNT_START, PURE_NUMBER as TEMPLATE_PURE_NUMBER } from '../render/templates/BigNumber.js';
import { FIRST_POP, STAGGER } from '../render/templates/Chips.js';
import { ctaClickTimes } from '../render/templates/Cta.js';
import { EXIT_SEC } from '../render/templates/parts.js';
import { clickTimes } from '../render/templates/Toggles.js';

const cap = (start: number, end: number) => ({ start, end, text: 'x' });
const split = (start: number, end: number, card?: CardSpec): Shot => ({ start, end, layout: 'split', card });
type SyncKind = 'peak' | 'onset' | 'end';
/** 音效文件的对齐方式（合成脚本清单里按文件名查） */
const syncOf = (file: string): SyncKind => (SPECS as { name: string; sync: SyncKind }[]).find((x) => `${x.name}.wav` === file)?.sync ?? 'onset';
/** 从 wav 实测的对齐时刻：响度峰值 / 起音 / 高潮结束（不用 ANCHOR_SEC 表，避免自我引用） */
function measuredAnchor(id: SfxId, sync: SyncKind): number {
  const wav = readWav(sfxPath(id));
  return sync === 'peak' ? rmsPeakSec(wav) : sync === 'end' ? lastLoudSec(wav) : onsetSec(wav);
}
const kindOf = (shots: Shot[], kind: string) => sfxCues(shots).filter((c) => sfxKind(c.sfx) === kind);

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
  it('嵌套、重叠的字幕按累计结束时间判断空隙：说话期间不抬起', () => {
    expect(bgmEnvelope([cap(0, 9), cap(2, 3), cap(5, 6)], 12).some((k) => k.db === OPEN_DB)).toBe(false);
    // 嵌套字幕之后真正的空隙（9–10）仍然抬起
    const keys = bgmEnvelope([cap(0, 9), cap(2, 3), cap(10, 12)], 14);
    expect(keys.filter((k) => k.db === OPEN_DB).map((k) => k.sec)).toEqual([9.3, 9.7]);
  });
  it('超出片长的字幕被忽略，关键帧不晚于片尾', () => {
    const keys = bgmEnvelope([cap(0, 2), cap(3, 4), cap(20, 22)], 8);
    expect(keys).toEqual(bgmEnvelope([cap(0, 2), cap(3, 4)], 8));
    expect(keys[keys.length - 1].sec).toBe(8);
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
  it('时间是 NaN 时取第一个关键帧', () => {
    expect(dbAt(keys, Number.NaN)).toBe(-60);
  });
});

describe('sfxCues', () => {
  const title: CardSpec = { template: 'title', props: { title: '标题' } };
  it('分屏带卡片的镜头开始处一个轻 pop；没有卡片的镜头没有音效', () => {
    const cues = sfxCues([split(2, 6, title), split(6, 9)]);
    expect(cues).toEqual([{ sec: 2, sfx: 'pop', volume: 0.2 }]);
  });
  it('toggles：每个 on 行一个 toggle，时间与模板 clickTimes 一致，off 行不响', () => {
    const card: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: false }, { label: 'c', on: true }] } };
    const toggles = kindOf([split(10, 16, card)], 'toggle');
    expect(toggles.map((c) => c.sec)).toEqual(clickTimes(2, 6).map((t) => Math.round((10 + t) * 1000) / 1000));
    expect(toggles[0].sec).toBeCloseTo(10.6);
  });
  it('toggles：镜头 2.2 秒时间隔压缩为 0.375 秒', () => {
    const card: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: true }, { label: 'c', on: true }] } };
    expect(kindOf([split(0, 2.2, card)], 'toggle').map((c) => c.sec)).toEqual([0.6, 0.975, 1.35]);
  });
  it('toggles：镜头太短，点击压到同一时刻时只留一个', () => {
    const card: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: true }, { label: 'c', on: true }] } };
    expect(kindOf([split(0, 1.5, card)], 'toggle').map((c) => c.sec)).toEqual([0.6]);
  });
  it('toggles、cta 的点击时间在各种镜头时长下都与模板函数一致', () => {
    const toggles = (n: number): CardSpec => ({ template: 'toggles', props: { rows: Array.from({ length: n }, (_, i) => ({ label: `r${i}`, on: true })) } });
    const cta = (n: number): CardSpec => ({ template: 'cta', props: { actions: ['关注', '点赞', '收藏'].slice(0, n) } });
    for (const dur of [3, 4.5, 8]) {
      for (const n of [1, 2, 3]) {
        expect(kindOf([split(0, dur, toggles(n))], 'toggle').map((c) => c.sec)).toEqual(clickTimes(n, dur));
        expect(sfxCues([{ start: 0, end: dur, layout: 'full', card: cta(n) }]).map((c) => c.sec)).toEqual(ctaClickTimes(n, dur));
      }
    }
  });
  it('cta：全屏镜头按 actions 数量点击，时间与 ctaClickTimes 一致，不放入场音', () => {
    const card: CardSpec = { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } };
    const cues = sfxCues([{ start: 20, end: 24, layout: 'full', card }]);
    expect(cues.every((c) => sfxKind(c.sfx) === 'click')).toBe(true);
    expect(cues.map((c) => c.sec)).toEqual(ctaClickTimes(3, 4).map((t) => 20 + t));
    expect(cues.map((c) => c.sec)).toEqual([20.5, 21, 21.5]);
  });
  it('cta：一个 action 只有一次点击', () => {
    const card: CardSpec = { template: 'cta', props: { actions: ['关注'] } };
    expect(sfxCues([{ start: 0, end: 3, layout: 'full', card }])).toHaveLength(1);
  });
  it('bigNumber：纯数字入场 pop，数字滚动期间每 0.1 秒一个轻 tick，滚完（COUNT_START + COUNT_SEC）最后一下 hit；非数字不滚也不 tick', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '35000', label: '星' } };
    const cues = sfxCues([split(5, 9, num)]);
    const ticks = cues.filter((c) => sfxKind(c.sfx) === 'tick');
    expect(ticks.map((c) => c.sec)).toEqual([5.15, 5.25, 5.35, 5.45, 5.55]);
    expect(ticks.every((c) => c.volume === 0.15)).toBe(true);
    const hits = cues.filter((c) => sfxKind(c.sfx) === 'hit');
    expect(hits).toEqual([{ sec: 5.65, sfx: 'hit', volume: 0.5 }]);
    expect(5 + COUNT_START + COUNT_SEC).toBeCloseTo(5.65, 9);
    expect(cues.filter((c) => sfxKind(c.sfx) === 'pop')).toHaveLength(1);
    const text: CardSpec = { template: 'bigNumber', props: { value: '3 倍', label: '快' } };
    expect(kindOf([split(5, 9, text)], 'tick')).toHaveLength(0);
    expect(kindOf([split(5, 9, text)], 'hit')).toHaveLength(0);
  });
  it('browser：开始处是 load，不再叠 pop', () => {
    const card: CardSpec = { template: 'browser', props: { url: 'github.com' } };
    expect(sfxCues([split(3, 7, card)])).toEqual([{ sec: 3, sfx: 'load', volume: 0.35 }]);
  });
  it('chips：每个 yes 项一个 confirm，按全卡序号间隔 0.12 秒，no/maybe 不响', () => {
    const card: CardSpec = { template: 'chips', props: { groups: [
      { label: 'g1', items: [{ text: 'a', mark: 'yes' }, { text: 'b', mark: 'no' }] },
      { label: 'g2', items: [{ text: 'c', mark: 'yes' }, { text: 'd', mark: 'maybe' }, { text: 'e', mark: 'yes' }] },
    ] } };
    const confirms = kindOf([split(0, 6, card)], 'confirm');
    expect(confirms.map((c) => c.sec)).toEqual([0.15, 0.39, 0.63]);
  });
  it('同一时刻（±0.05 秒）只保留更响的：pop 0.2 压过同刻的 tick 0.15', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '9', label: 'x' } };
    // 前一镜头的最后一个 tick 落在 4.55，下一镜头的 pop 在 4.57
    const cues = sfxCues([split(4, 4.6, num), split(4.57, 8, title)]);
    expect(cues.find((c) => c.sec === 4.55)).toBeUndefined();
    expect(cues.find((c) => c.sec === 4.57)).toEqual({ sec: 4.57, sfx: expect.stringMatching(/^pop/), volume: 0.2 });
    expect(cues.slice(1).every((c, i) => c.sec - cues[i].sec > 0.05)).toBe(true);
  });
  it('音量相同时保留更早的', () => {
    const toggles: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }] } };
    const cta: CardSpec = { template: 'cta', props: { actions: ['关注'] } };
    // toggle 在 0.6，另一个全屏 cta 的 click 在 0.14 + 0.5 = 0.64（相差 0.04 秒）
    const cues = sfxCues([split(0, 2, toggles), { start: 0.14, end: 4, layout: 'full', card: cta }]);
    expect(cues.filter((c) => c.sec > 0.5 && c.sec < 0.7)).toEqual([{ sec: 0.6, sfx: 'toggle', volume: 0.35 }]);
  });
  it('chips：入场 pop 与第一个 confirm 不互相去重', () => {
    const card: CardSpec = { template: 'chips', props: { groups: [{ label: 'g', items: [{ text: 'a', mark: 'yes' }] }] } };
    expect(sfxCues([split(0, 4, card)]).map((c) => [sfxKind(c.sfx), c.sec])).toEqual([['pop', 0], ['confirm', 0.15]]);
  });
  it('晚于镜头结束的音效丢弃', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '9', label: 'x' } };
    expect(kindOf([split(0, 0.35, num)], 'tick').map((c) => c.sec)).toEqual([0.15, 0.25]);
  });
});

describe('钩子、全屏 B-roll、片尾的音效', () => {
  const hook = (index: number, total = 3): CardSpec => ({ template: 'hook', props: { index, total, headline: '标题', highlight: [] } });
  const broll = (start: number, end: number, layout: Shot['layout'] = 'broll'): Shot => ({ start, end, layout, broll: { file: 'broll/a.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } } });
  const FRAME = 1 / 30;

  it('第一张钩子：riser 的高潮落在 hit 上，hit 在标题高亮刷开完成（HOOK_HIT_SEC，Hook.tsx 与它共用同一常量）；之后的钩子只有 hit', () => {
    const cues = sfxCues([split(2, 5, hook(1)), split(5, 8, hook(2)), split(8, 11, hook(3))]);
    const risers = cues.filter((c) => sfxKind(c.sfx) === 'riser');
    const hits = cues.filter((c) => sfxKind(c.sfx) === 'hit');
    expect(HOOK_HIT_SEC).toBeCloseTo(HOOK_MARK_START + HOOK_MARK_SEC, 9);
    expect(hits.map((c) => c.sec)).toEqual([2, 5, 8].map((t) => Math.round((t + HOOK_HIT_SEC) * 1000) / 1000));
    expect(risers).toHaveLength(1);
    expect(risers[0].sfx).toBe('riser');
    expect(risers[0].sec + ANCHOR_SEC.riser).toBeCloseTo(2 + HOOK_HIT_SEC, 3);
    expect(cues.filter((c) => sfxKind(c.sfx) === 'pop')).toHaveLength(0);
  });
  it('钩子在片头（0 秒起）：来不及放长 riser，换短 riser，高潮仍对上 hit', () => {
    const cues = sfxCues([split(0, 3, hook(1, 1))]);
    const riser = cues.find((c) => sfxKind(c.sfx) === 'riser');
    expect(riser?.sfx).toBe('riserShort');
    expect(riser?.sec).toBeCloseTo(HOOK_HIT_SEC - ANCHOR_SEC.riserShort, 3);
    expect((riser?.sec ?? 0) + ANCHOR_SEC.riserShort).toBeCloseTo(HOOK_HIT_SEC, 3);
  });
  it('全屏 B-roll 插入：whoosh 的响度峰值落在画面切入帧（J-cut 晚 2 帧）', () => {
    const shots: Shot[] = [split(0, 4), broll(4, 8), split(8, 12)];
    const whoosh = kindOf(shots, 'whoosh');
    expect(whoosh).toHaveLength(1);
    const cutIn = visualShots(shots)[1].start;
    expect(cutIn).toBeCloseTo(4 + 2 * FRAME, 6);
    expect(Math.abs(whoosh[0].sec + ANCHOR_SEC[whoosh[0].sfx] - cutIn)).toBeLessThanOrEqual(0.001);
  });
  it('B-roll 缺素材（按全屏渲染）不响；片头的 B-roll 来不及前导，丢弃；画中画用较轻的 whoosh', () => {
    expect(kindOf([{ start: 4, end: 8, layout: 'broll' }], 'whoosh')).toHaveLength(0);
    expect(kindOf([broll(0, 4)], 'whoosh')).toHaveLength(0);
    const pip = kindOf([split(0, 4), broll(4, 8, 'pip')], 'whoosh');
    expect(pip).toHaveLength(1);
    expect(pip[0].volume).toBeLessThan(0.4);
    expect(pip[0].sec + ANCHOR_SEC[pip[0].sfx]).toBeCloseTo(4, 3);
  });
  it('片尾 logo 音落在 logo 弹出的时刻（片尾开始后 OUTRO_LOGO_SEC）', () => {
    const cues = sfxCues([split(0, 3)], { outroStartSec: 60 });
    expect(cues.filter((c) => c.sfx === 'logo')).toEqual([{ sec: 60 + OUTRO_LOGO_SEC, sfx: 'logo', volume: 0.33 }]);
    expect(sfxCues([split(0, 3)]).some((c) => c.sfx === 'logo')).toBe(false);
  });
});

/** 一部典型口播片：3 张钩子、一批分屏卡片、数字卡、全屏 B-roll、画中画、cta */
function film(): Shot[] {
  const card = (template: 'title' | 'evidenceList' | 'strikeList', n: number): CardSpec => (
    template === 'title' ? { template, props: { title: `t${n}` } }
      : template === 'strikeList' ? { template, props: { items: ['a'] } }
        : { template, props: { title: `e${n}`, rows: [{ badge: '证据', text: 'x' }] } });
  const hookCard = (index: number): CardSpec => ({ template: 'hook', props: { index, total: 3, headline: 'h', highlight: [] } });
  const num: CardSpec = { template: 'bigNumber', props: { value: '650', label: '条' } };
  const brollOf = (start: number, end: number, layout: Shot['layout']): Shot => ({ start, end, layout, broll: { file: 'broll/a.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } } });
  const shots: Shot[] = [
    split(0, 3, hookCard(1)), split(3, 6, hookCard(2)), split(6, 9, hookCard(3)),
    split(9, 12, card('title', 1)), brollOf(12, 15, 'broll'), split(15, 19, num), split(19, 22, card('evidenceList', 2)),
    brollOf(22, 25, 'pip'), split(25, 29, card('strikeList', 3)), brollOf(29, 32, 'broll'),
    split(32, 36, { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: true }] } }),
    split(36, 40, num), { start: 40, end: 44, layout: 'full', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } } },
  ];
  return shots;
}

describe('音效分配规则（整片）', () => {
  it('典型片子：音效种类 ≥ 5，同一音效全片 ≤ 6 次', () => {
    const cues = sfxCues(film(), { outroStartSec: 46 });
    const stats = sfxStats(cues);
    expect(stats.kinds).toBeGreaterThanOrEqual(MIN_KINDS);
    expect(stats.maxRepeat).toBeLessThanOrEqual(MAX_PER_SFX);
    expect(new Set(cues.map((c) => sfxKind(c.sfx)))).toEqual(new Set(['pop', 'whoosh', 'hit', 'riser', 'tick', 'toggle', 'click', 'logo']));
  });
  it('重复超过上限就换同类变体，全部变体用尽才丢弃：23 张分屏卡 → 4 个 pop 变体各 ≤ 6 次', () => {
    const shots = Array.from({ length: 30 }, (_, i): Shot => split(i * 3, i * 3 + 3, { template: 'title', props: { title: `t${i}` } }));
    const cues = sfxCues(shots);
    const perSfx = sfxStats(cues).perSfx;
    expect(Object.keys(perSfx).sort()).toEqual(['pop', 'pop2', 'pop3', 'pop4']);
    expect(Object.values(perSfx).every((n) => n <= MAX_PER_SFX)).toBe(true);
    expect(cues).toHaveLength(4 * MAX_PER_SFX);
    // 相邻两个 pop 轮换变体，不连续重复同一个
    expect(cues.slice(1).every((c, i) => c.sfx !== cues[i].sfx)).toBe(true);
  });
  it('23 张卡片（try2 的规模）不丢音效：每张卡都有入场音', () => {
    const shots = Array.from({ length: 23 }, (_, i): Shot => split(i * 3, i * 3 + 3, { template: 'title', props: { title: `t${i}` } }));
    expect(sfxCues(shots)).toHaveLength(23);
  });
  it('每个音效与对应画面动作的偏差 ≤ 2 帧：用 wav 实测的响度峰值 / 起音 / 高潮对拍模板的动画时间点', () => {
    const shots = film();
    const vis = visualShots(shots);
    const cues = sfxCues(shots, { outroStartSec: 46 });
    const sync = new Map<string, SyncKind>(Object.entries(SFX).map(([id, file]) => [id, syncOf(file)]));
    /** 音效在整片时间轴上「与动作对齐」的实测时刻 */
    const landed = (c: SfxCue): number => c.sec + measuredAnchor(c.sfx, sync.get(c.sfx) as SyncKind);
    const near = (got: number[], want: number[], label: string): void => {
      expect(got, label).toHaveLength(want.length);
      got.forEach((t, i) => expect(Math.abs(t - want[i]), `${label}[${i}] ${t} vs ${want[i]}`).toBeLessThanOrEqual(2 / 30 + 1e-9));
    };
    const times = (kind: string): number[] => cues.filter((c) => sfxKind(c.sfx) === kind).map(landed);
    // whoosh：全屏插入是画面时间轴（J-cut 后）的切入帧，画中画是镜头开始
    near(times('whoosh'), vis.flatMap((s, i) => (s.broll && (shots[i].layout === 'broll' || shots[i].layout === 'pip') ? [s.start] : [])), 'whoosh');
    // logo：Outro.tsx 的 logo 弹簧从 OUTRO_LOGO_SEC 起
    near(times('logo'), [46 + OUTRO_LOGO_SEC], 'logo');
    // riser 的高潮、钩子 hit：Hook.tsx 第一行高亮刷开完成；数字 hit：BigNumber 滚完
    near(times('riser'), [0 + HOOK_MARK_START + HOOK_MARK_SEC], 'riser');
    // 数字 hit：BigNumber 滚完；从人物全屏 / 素材切进分屏的镜头（15 秒那张）卡片内部时钟提前 cardLead，hit 同步提前
    const numberAt = (start: number): number => start + COUNT_START + COUNT_SEC - cardLead(vis, shots.findIndex((x) => x.start === start));
    expect(cardLead(vis, shots.findIndex((x) => x.start === 15))).toBeGreaterThan(0);
    near(times('hit'), [0, 3, 6].map((t) => t + HOOK_MARK_START + HOOK_MARK_SEC).concat([15, 36].map(numberAt)), 'hit');
    // pop：卡片入场（CardLayer 的 spring 从镜头第 0 帧起）
    near(times('pop'), shots.filter((s) => s.card && s.layout === 'split' && s.card.template !== 'hook').map((s) => s.start), 'pop');
    // tick：数字滚动窗口内（同样扣掉提前量）
    times('tick').forEach((t) => {
      const start = t < 20 ? 15 : 36;
      const lo = start + COUNT_START - cardLead(vis, shots.findIndex((x) => x.start === start));
      expect(t).toBeGreaterThan(lo);
      expect(t).toBeLessThan(lo + COUNT_SEC + 1e-9);
    });
  });
  it('sfxStats：统计种类数、各音效次数与最大重复', () => {
    const stats = sfxStats([{ sec: 0, sfx: 'pop', volume: 1 }, { sec: 1, sfx: 'pop2', volume: 1 }, { sec: 2, sfx: 'pop', volume: 1 }, { sec: 3, sfx: 'hit', volume: 1 }]);
    expect(stats).toEqual({ kinds: 2, perSfx: { pop: 2, pop2: 1, hit: 1 }, maxRepeat: 2 });
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
  it('按 id 的码元顺序排序（大写 B 在小写 a 之前），不受本地化排序影响', () => {
    const fnv = (seed: string): number => [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
    const pool = [mk('a', 'tech'), mk('B', 'tech')];
    for (const seed of ['k0', 'k1', 'k2', 'k3']) expect(pickTrack(pool, 'tech', seed).id).toBe(['B', 'a'][fnv(seed) % 2]);
  });
  it('该情绪没有曲目时退到全部曲目；曲库为空报错', () => {
    const noUpbeat = tracks.filter((t) => t.mood !== 'upbeat');
    expect(noUpbeat).toContain(pickTrack(noUpbeat, 'upbeat', 's'));
    expect(() => pickTrack([], 'chill', 's')).toThrow();
  });
});

describe('与渲染模板常量对拍', () => {
  it('卡片出场时长、标签弹入节奏、数字滚动判定与模板一致', () => {
    expect(TIMING.exitSec).toBe(EXIT_SEC);
    expect(TIMING.chipsFirst).toBe(FIRST_POP);
    expect(TIMING.chipsStagger).toBe(STAGGER);
    expect(PURE_NUMBER.source).toBe(TEMPLATE_PURE_NUMBER.source);
  });
  it('tick 落在数字滚动的时间窗内，最后一下 hit 落在滚动结束的时刻', () => {
    const num: CardSpec = { template: 'bigNumber', props: { value: '12', label: 'x' } };
    const ticks = kindOf([split(0, 4, num)], 'tick').map((c) => c.sec);
    expect(ticks[0]).toBeGreaterThan(COUNT_START);
    expect(ticks[ticks.length - 1]).toBeLessThan(COUNT_START + COUNT_SEC);
    expect(kindOf([split(0, 4, num)], 'hit').map((c) => c.sec)).toEqual([0.65]);
    expect(COUNT_START + COUNT_SEC).toBeCloseTo(0.65, 9);
  });
});

describe('bgmEnvelope：品牌片尾', () => {
  it('最后一句说完后抬到 OUTRO_DB 收束，片尾开始 0.4 秒后一路淡出到片尾结束', () => {
    const keys = bgmEnvelope([cap(0, 10)], 13.1, 10.6);
    expect(keys).toEqual([
      { sec: 0, db: -60 }, { sec: 0.5, db: DUCK_DB }, { sec: 10, db: DUCK_DB }, { sec: 10.3, db: OUTRO_DB }, { sec: 11, db: OUTRO_DB }, { sec: 13.1, db: -60 },
    ]);
  });
  it('关键帧严格递增；抬起之后到片尾结束音量只会一路下降', () => {
    const keys = bgmEnvelope([cap(0, 4), cap(5.5, 10)], 13.1, 10.6);
    keys.slice(1).forEach((k, i) => expect(k.sec).toBeGreaterThan(keys[i].sec));
    const tail = Array.from({ length: 29 }, (_, i) => dbAt(keys, 10.3 + i * 0.1));
    tail.slice(1).forEach((db, i) => expect(db).toBeLessThanOrEqual(tail[i] + 1e-9));
    expect(dbAt(keys, 13.1)).toBe(-60);
  });
  it('没有字幕、或片尾开始晚于片长时退回普通包络', () => {
    expect(bgmEnvelope([], 10, 99)).toEqual(bgmEnvelope([], 10));
    const noCaptions = bgmEnvelope([], 8, 5);
    expect(noCaptions[noCaptions.length - 1]).toEqual({ sec: 8, db: -60 });
  });
});

describe('从人物全屏切进分屏：卡片内部音效随 cardLead 提前', () => {
  const full = (start: number, end: number): Shot => ({ start, end, layout: 'full' });
  const chips: CardSpec = { template: 'chips', props: { groups: [{ label: 'g', items: [{ text: 'a', mark: 'yes' }, { text: 'b', mark: 'yes' }, { text: 'c', mark: 'yes' }, { text: 'd', mark: 'yes' }] }] } };
  const toggles: CardSpec = { template: 'toggles', props: { rows: [{ label: 'a', on: true }, { label: 'b', on: true }] } };
  const num: CardSpec = { template: 'bigNumber', props: { value: '650', label: '条' } };

  it('提前量来自 cardLead：无卡镜头 → 分屏为 FRESH_LEAD_SEC，分屏 → 分屏与首个镜头为 0', () => {
    const shots = [full(0, 3), split(3, 8, chips), split(8, 12, chips)];
    expect(FRESH_LEAD_SEC).toBeCloseTo(0.4, 9);
    expect([0, 1, 2].map((i) => cardLead(visualShots(shots), i))).toEqual([0, FRESH_LEAD_SEC, 0]);
  });
  it('标签弹入：触发点比镜头内秒数早 lead；扣掉后早于镜头开始的（第 0 帧已就位）不响；与模板时间点对拍 ≤ 2 帧', () => {
    const fresh = kindOf([full(0, 3), split(3, 9, chips)], 'confirm').map((c) => c.sec);
    const plain = kindOf([split(3, 9, chips)], 'confirm').map((c) => c.sec);
    // 标签 i 在模板时间 FIRST_POP + i * STAGGER 弹入，镜头内秒数 = 模板时间 - lead
    const want = [0, 1, 2, 3].map((i) => 3 + FIRST_POP + i * STAGGER - FRESH_LEAD_SEC).filter((t) => t >= 3 - 1e-9);
    expect(plain).toHaveLength(4);
    expect(fresh).toHaveLength(want.length);
    fresh.forEach((t, i) => expect(Math.abs(t - want[i])).toBeLessThanOrEqual(2 / 30 + 1e-9));
    expect(fresh.every((t) => t >= 3)).toBe(true);
  });
  it('开关点击：按模板看到的镜头时长（dur + lead）算节奏，再整体提前 lead', () => {
    const fresh = kindOf([full(0, 3), split(3, 8, toggles)], 'toggle').map((c) => c.sec);
    const want = clickTimes(2, 5 + FRESH_LEAD_SEC).map((t) => 3 + t - FRESH_LEAD_SEC);
    expect(fresh).toHaveLength(2);
    fresh.forEach((t, i) => expect(Math.abs(t - want[i])).toBeLessThanOrEqual(2 / 30 + 1e-9));
    // 跟在同类分屏卡后面（叠化，没有提前）：照旧；结构不同的分屏卡之间是擦除，擦进来的卡也提前（见 card-wipe 测试）
    expect(kindOf([split(0, 3, { template: 'strikeList', props: { items: ['a', 'b'] } }), split(3, 8, toggles)], 'toggle').map((c) => c.sec)).toEqual(clickTimes(2, 5).map((t) => 3 + t));
  });
  it('数字卡：ticks 与最后一下 hit 同步提前；入场 pop 仍在镜头第 0 帧', () => {
    const cues = sfxCues([full(0, 3), split(3, 9, num)]);
    const hit = cues.find((c) => sfxKind(c.sfx) === 'hit');
    expect(hit?.sec).toBeCloseTo(3 + COUNT_START + COUNT_SEC - FRESH_LEAD_SEC, 3);
    cues.filter((c) => sfxKind(c.sfx) === 'tick').forEach((c) => expect(c.sec).toBeGreaterThanOrEqual(3));
    expect(cues.find((c) => sfxKind(c.sfx) === 'pop')?.sec).toBe(3);
  });
  it('从全屏 B-roll 切进分屏同样提前：4 个标签只剩最后一个（模板时间 0.51 秒 - 0.4）还在镜头内', () => {
    const broll: Shot = { start: 1, end: 3, layout: 'broll', broll: { file: 'broll/a.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } } };
    const after = kindOf([split(0, 1, chips), broll, split(3, 9, chips)], 'confirm').map((c) => c.sec).filter((t) => t >= 3);
    expect(after).toHaveLength(1);
    expect(Math.abs(after[0] - (3 + FIRST_POP + 3 * STAGGER - FRESH_LEAD_SEC))).toBeLessThanOrEqual(2 / 30 + 1e-9);
  });
});
