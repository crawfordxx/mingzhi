import { describe, expect, it } from 'vitest';
import {
  CTA_FROM_END, CTA_SEC, DEFAULT_OUTRO, HOLD_SEC, OUTRO_DEFAULT_TEXT, OUTRO_SEC, outroProps, planEnding, resolveOutro,
} from '../src/compose/ending.js';
import { segmentBounds, shotHash } from '../src/compose/segments.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';

const FRAME = 1 / 30;
const cta: CardSpec = { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } };
const title = (t: string): CardSpec => ({ template: 'title', props: { title: t } });
const hook = (i: number): CardSpec => ({ template: 'hook', props: { index: i, total: 2, headline: 'h', highlight: [] } });
const cap = (start: number, end: number) => ({ start, end, text: 'x' });

/** 典型口播：钩子、若干分屏卡、全屏、末尾 cta（归一化后 cta 覆盖最后一句） */
function typical(): { shots: Shot[]; captions: ReturnType<typeof cap>[]; content: number } {
  const shots: Shot[] = [
    { start: 0, end: 4, layout: 'split', card: hook(1) }, { start: 4, end: 8, layout: 'split', card: hook(2) },
    { start: 8, end: 20, layout: 'full' }, { start: 20, end: 26, layout: 'split', card: title('甲') },
    { start: 26, end: 40, layout: 'full' }, { start: 40, end: 47, layout: 'split', card: title('乙') },
    { start: 47, end: 56, layout: 'full' }, { start: 56, end: 60, layout: 'full', card: cta },
  ];
  return { shots, captions: [cap(0, 10), cap(40, 50), cap(57, 59.8)], content: 60 };
}

const covered = (shots: Shot[], end: number): boolean => shots.every((s, i) => s.end > s.start && (i === 0 ? s.start === 0 : Math.abs(s.start - shots[i - 1].end) < 1e-9)) && Math.abs(shots[shots.length - 1].end - end) < 1e-9;

describe('planEnding：留白与片尾', () => {
  it('最后一句字幕结束后留 ≥ 0.6 秒再接片尾；内容比这更长就不加长', () => {
    const { shots } = typical();
    const tight = planEnding(shots, [cap(57, 59.9)], 60, true);
    expect(tight.outroStartSec).toBeGreaterThanOrEqual(59.9 + HOLD_SEC - 1e-9);
    expect(tight.outroStartSec - 59.9).toBeLessThan(HOLD_SEC + FRAME);
    const roomy = planEnding(shots, [cap(57, 58)], 60, true);
    expect(roomy.outroStartSec).toBe(60);
  });
  it('片尾 2–3 秒，整片时长 = 片尾开始 + 片尾时长；片尾开始在整帧上', () => {
    const { shots, captions, content } = typical();
    const plan = planEnding(shots, captions, content, true);
    expect(OUTRO_SEC).toBeGreaterThanOrEqual(2);
    expect(OUTRO_SEC).toBeLessThanOrEqual(3);
    expect(plan.durationSec - plan.outroStartSec).toBeCloseTo(OUTRO_SEC, 6);
    expect(Math.abs(plan.outroStartSec * 30 - Math.round(plan.outroStartSec * 30))).toBeLessThan(1e-6);
  });
  it('关闭片尾：不加片尾，但最后一句后仍留 ≥ 0.6 秒', () => {
    const { shots, captions, content } = typical();
    const plan = planEnding(shots, captions, content, false);
    expect(plan.hasOutro).toBe(false);
    expect(plan.durationSec).toBeGreaterThanOrEqual(59.8 + HOLD_SEC - 1e-9);
    expect(plan.durationSec).toBe(plan.outroStartSec);
  });
  it('没有字幕：不留白，片尾紧接内容', () => {
    const plan = planEnding([{ start: 0, end: 5, layout: 'full' }], [], 5, true);
    expect(plan.outroStartSec).toBe(5);
  });
});

describe('planEnding：CTA 位置', () => {
  it('CTA 起点在整片倒数第 5–8 秒，且在最后一句字幕开始前结束', () => {
    const { shots, captions, content } = typical();
    const plan = planEnding(shots, captions, content, true);
    const ctaShot = plan.shots.find((s) => s.card?.template === 'cta');
    expect(ctaShot).toBeDefined();
    const fromEnd = plan.durationSec - (ctaShot?.start ?? 0);
    expect(fromEnd).toBeGreaterThanOrEqual(CTA_FROM_END.min - 1e-9);
    expect(fromEnd).toBeLessThanOrEqual(CTA_FROM_END.max + FRAME);
    expect(ctaShot?.end ?? 99).toBeLessThanOrEqual(57 + 1e-9);
    expect((ctaShot?.end ?? 0) - (ctaShot?.start ?? 0)).toBeGreaterThanOrEqual(CTA_SEC.min - FRAME);
    expect((ctaShot?.end ?? 0) - (ctaShot?.start ?? 0)).toBeLessThanOrEqual(CTA_SEC.max + 1e-9);
  });
  it('CTA 与最后一句字幕不同时出现，最后一个镜头不再是 CTA；镜头仍首尾相接覆盖全片内容', () => {
    const { shots, captions, content } = typical();
    const plan = planEnding(shots, captions, content, true);
    const ctaShot = plan.shots.find((s) => s.card?.template === 'cta');
    const last = captions[captions.length - 1];
    expect(Math.min(ctaShot?.end ?? 0, last.end) - Math.max(ctaShot?.start ?? 0, last.start)).toBeLessThanOrEqual(0);
    expect(plan.shots[plan.shots.length - 1].card).toBeUndefined();
    expect(covered(plan.shots, content)).toBe(true);
    expect(plan.shots.filter((s) => s.card?.template === 'cta')).toHaveLength(1);
  });
  it('不同的口播长度与字幕长度下，CTA 都落在窗口内且避开最后一句', () => {
    for (const content of [30, 45.3, 90]) {
      for (const lastLen of [1.2, 2.5, 2.8]) {
        const lastStart = content - 0.2 - lastLen;
        const shots: Shot[] = [{ start: 0, end: content - 4, layout: 'full' }, { start: content - 4, end: content, layout: 'full', card: cta }];
        const plan = planEnding(shots, [cap(0, lastStart - 0.5), cap(lastStart, content - 0.2)], content, true);
        const c = plan.shots.find((s) => s.card?.template === 'cta');
        const fromEnd = plan.durationSec - (c?.start ?? 0);
        expect(c, `${content}/${lastLen}`).toBeDefined();
        expect(fromEnd, `${content}/${lastLen}`).toBeGreaterThanOrEqual(CTA_FROM_END.min - 1e-9);
        expect(fromEnd, `${content}/${lastLen}`).toBeLessThanOrEqual(CTA_FROM_END.max + FRAME);
        expect(c?.end ?? 99, `${content}/${lastLen}`).toBeLessThanOrEqual(lastStart + 1e-9);
        expect(covered(plan.shots, content), `${content}/${lastLen}`).toBe(true);
      }
    }
  });
  it('最后一句太长、窗口放不下时：CTA 退到最后一句之前，仍不与它同时出现', () => {
    const { shots, content } = typical();
    const plan = planEnding(shots, [cap(0, 10), cap(40, 59.8)], content, true);
    const c = plan.shots.find((s) => s.card?.template === 'cta');
    expect(c).toBeDefined();
    expect(c?.end ?? 99).toBeLessThanOrEqual(40 + 1e-9);
    expect(covered(plan.shots, content)).toBe(true);
  });
  it('起点靠近已有镜头边界时吸附到边界，避免留下不足 1 秒的碎镜头', () => {
    const { shots, captions, content } = typical();
    const plan = planEnding(shots, captions, content, true);
    plan.shots.forEach((s) => expect(s.end - s.start).toBeGreaterThanOrEqual(1 - 1e-9));
  });
  it('没有 CTA、CTA 已不在末尾、或移动会吃掉钩子卡时，镜头原样不动', () => {
    const { shots, captions, content } = typical();
    const noCta = shots.slice(0, -1).map((s, i, a) => (i === a.length - 1 ? { ...s, end: 60 } : s));
    expect(planEnding(noCta, captions, content, true).shots).toEqual(noCta);
    const early = [...shots.slice(0, -2), { start: 56, end: 58, layout: 'full' as const, card: cta }, { start: 58, end: 60, layout: 'full' as const }];
    expect(planEnding(early, captions, content, true).shots).toEqual(early);
    const short: Shot[] = [{ start: 0, end: 3, layout: 'split', card: hook(1) }, { start: 3, end: 6, layout: 'full', card: cta }];
    expect(planEnding(short, [cap(0, 2), cap(3.2, 5.8)], 6, true).shots).toEqual(short);
  });
  it('不改入参', () => {
    const { shots, captions, content } = typical();
    const snapshot = JSON.stringify(shots);
    planEnding(shots, captions, content, true);
    expect(JSON.stringify(shots)).toBe(snapshot);
  });
});

describe('片尾设置', () => {
  it('缺省：开启，文字「用明知AI剪辑制作」', () => {
    expect(resolveOutro(undefined)).toEqual(DEFAULT_OUTRO);
    expect(DEFAULT_OUTRO).toEqual({ enabled: true, text: OUTRO_DEFAULT_TEXT });
    expect(OUTRO_DEFAULT_TEXT).toBe('用明知AI剪辑制作');
  });
  it('可改文字、可关闭；文字去首尾空白，空文字表示只放 logo', () => {
    expect(resolveOutro({ enabled: true, text: '  某某出品 ' })).toEqual({ enabled: true, text: '某某出品' });
    expect(resolveOutro({ enabled: false, text: 'x' }).enabled).toBe(false);
    expect(resolveOutro({ enabled: true, text: '   ' }).text).toBe('');
  });
  it('outroProps：给渲染用的片尾字段；关闭或没有片尾返回 undefined', () => {
    const { shots, captions, content } = typical();
    const on = planEnding(shots, captions, content, true);
    expect(outroProps(on, DEFAULT_OUTRO, 'brand/logo.png')).toEqual({ startSec: on.outroStartSec, text: OUTRO_DEFAULT_TEXT, logo: 'brand/logo.png' });
    const off = planEnding(shots, captions, content, false);
    expect(outroProps(off, { enabled: false, text: 'x' }, 'brand/logo.png')).toBeUndefined();
  });
});

describe('片尾与分段缓存', () => {
  const base = {
    person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 6.4,
    captions: [{ start: 0, end: 2.8, text: '一句话' }],
  };
  const shots: Shot[] = [{ start: 0, end: 1.5, layout: 'full' }, { start: 1.5, end: 3, layout: 'full' }];
  const hashes = (outro?: { startSec: number; text: string; logo: string }): string[] => {
    const props = { ...base, ...(outro ? { outro } : {}) };
    return segmentBounds(shots, props.durationSec).map((range, i) => shotHash(shots[i], props, i, { shots, range }));
  };
  it('改片尾文字只让包含片尾的末段重渲，前面的段命中缓存；有无片尾哈希不同', () => {
    const a = hashes({ startSec: 3.4, text: '用明知AI剪辑制作', logo: 'brand/logo.png' });
    const b = hashes({ startSec: 3.4, text: '某某出品', logo: 'brand/logo.png' });
    expect(b[0]).toBe(a[0]);
    expect(b[1]).not.toBe(a[1]);
    expect(hashes()[1]).not.toBe(a[1]);
  });
});
