import { describe, expect, it } from 'vitest';
import {
  CTA_FROM_END, CTA_SEC, DEFAULT_OUTRO, HOLD_SEC, OUTRO_DEFAULT_TEXT, OUTRO_SEC, outroProps, placeCta, planEnding, resolveOutro,
} from '../src/compose/ending.js';
import { segmentBounds, shotHash } from '../src/compose/segments.js';
import { normalizeStoryboard } from '../src/storyboard/normalize.js';
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
    const tight = planEnding([cap(57, 59.9)], 60, true);
    expect(tight.outroStartSec).toBeGreaterThanOrEqual(59.9 + HOLD_SEC - 1e-9);
    expect(tight.outroStartSec - 59.9).toBeLessThan(HOLD_SEC + FRAME);
    expect(planEnding([cap(57, 58)], 60, true).outroStartSec).toBe(60);
  });
  it('片尾 2–3 秒，整片时长 = 片尾开始 + 片尾时长；片尾开始在整帧上', () => {
    const { captions, content } = typical();
    const plan = planEnding(captions, content, true);
    expect(OUTRO_SEC).toBeGreaterThanOrEqual(2);
    expect(OUTRO_SEC).toBeLessThanOrEqual(3);
    expect(plan.durationSec - plan.outroStartSec).toBeCloseTo(OUTRO_SEC, 6);
    expect(Math.abs(plan.outroStartSec * 30 - Math.round(plan.outroStartSec * 30))).toBeLessThan(1e-6);
  });
  it('关闭片尾：不加片尾，但最后一句后仍留 ≥ 0.6 秒', () => {
    const { captions, content } = typical();
    const plan = planEnding(captions, content, false);
    expect(plan.hasOutro).toBe(false);
    expect(plan.durationSec).toBeGreaterThanOrEqual(59.8 + HOLD_SEC - 1e-9);
    expect(plan.durationSec).toBe(plan.outroStartSec);
  });
  it('没有字幕：不留白，片尾紧接内容', () => {
    expect(planEnding([], 5, true).outroStartSec).toBe(5);
  });
});

describe('placeCta：CTA 位置（分镜阶段）', () => {
  const place = (shots: Shot[], captions: ReturnType<typeof cap>[], content: number, outro = true): Shot[] => placeCta(shots, captions, content, outro);
  const ctaOf = (shots: Shot[]): Shot | undefined => shots.find((s) => s.card?.template === 'cta');
  const placedOf = (s: Shot | undefined): boolean | undefined => (s?.card?.template === 'cta' ? s.card.props.placed : undefined);

  it('CTA 起点在整片倒数第 5–8 秒，且在最后一句字幕开始前结束；标记 placed', () => {
    const { shots, captions, content } = typical();
    const total = planEnding(captions, content, true).durationSec;
    const c = ctaOf(place(shots, captions, content));
    expect(c).toBeDefined();
    const fromEnd = total - (c?.start ?? 0);
    expect(fromEnd).toBeGreaterThanOrEqual(CTA_FROM_END.min - 1e-9);
    expect(fromEnd).toBeLessThanOrEqual(CTA_FROM_END.max + FRAME);
    expect(c?.end ?? 99).toBeLessThanOrEqual(57 + 1e-9);
    expect((c?.end ?? 0) - (c?.start ?? 0)).toBeGreaterThanOrEqual(CTA_SEC.min - FRAME);
    expect((c?.end ?? 0) - (c?.start ?? 0)).toBeLessThanOrEqual(CTA_SEC.max + 1e-9);
    expect(placedOf(c)).toBe(true);
  });
  it('CTA 与最后一句字幕不同时出现，最后一个镜头不再是 CTA；镜头首尾相接覆盖全片内容，只有一个 CTA', () => {
    const { shots, captions, content } = typical();
    const out = place(shots, captions, content);
    const c = ctaOf(out);
    const last = captions[captions.length - 1];
    expect(Math.min(c?.end ?? 0, last.end) - Math.max(c?.start ?? 0, last.start)).toBeLessThanOrEqual(0);
    expect(out[out.length - 1].card).toBeUndefined();
    expect(covered(out, content)).toBe(true);
    expect(out.filter((s) => s.card?.template === 'cta')).toHaveLength(1);
  });
  it('不同的口播长度与字幕长度下，CTA 都落在窗口内且避开最后一句', () => {
    for (const content of [30, 45.3, 90]) {
      for (const lastLen of [1.2, 2.5, 2.8]) {
        const lastStart = content - 0.2 - lastLen;
        const shots: Shot[] = [{ start: 0, end: content - 4, layout: 'full' }, { start: content - 4, end: content, layout: 'full', card: cta }];
        const caps = [cap(0, lastStart - 0.5), cap(lastStart, content - 0.2)];
        const out = place(shots, caps, content);
        const c = ctaOf(out);
        const fromEnd = planEnding(caps, content, true).durationSec - (c?.start ?? 0);
        const tag = `${content}/${lastLen}`;
        expect(c, tag).toBeDefined();
        expect(fromEnd, tag).toBeGreaterThanOrEqual(CTA_FROM_END.min - 1e-9);
        expect(fromEnd, tag).toBeLessThanOrEqual(CTA_FROM_END.max + FRAME);
        expect(c?.end ?? 99, tag).toBeLessThanOrEqual(lastStart + 1e-9);
        expect(covered(out, content), tag).toBe(true);
      }
    }
  });
  it('最后一句太长、窗口放不下时：CTA 退到最后一句之前，仍不与它同时出现', () => {
    const shots: Shot[] = [{ start: 0, end: 56, layout: 'full' }, { start: 56, end: 60, layout: 'full', card: cta }];
    const out = place(shots, [cap(0, 10), cap(40, 59.8)], 60);
    const c = ctaOf(out);
    expect(c).toBeDefined();
    expect(c?.end ?? 99).toBeLessThanOrEqual(40 + 1e-9);
    expect(covered(out, 60)).toBe(true);
  });
  it('不吃别的卡片：起点前有非纯人像镜头时 CTA 只占纯人像部分；起点离卡片镜头结尾不足 1 秒且在窗口内时吸附到它的结尾', () => {
    const { captions, content } = typical();
    const shots: Shot[] = [{ start: 0, end: 54.5, layout: 'split', card: title('甲') }, { start: 54.5, end: 56, layout: 'full' }, { start: 56, end: 60, layout: 'full', card: cta }];
    const out = place(shots, captions, content);
    expect(out[0]).toEqual(shots[0]);
    expect(ctaOf(out)?.start).toBeGreaterThanOrEqual(54.5 - 1e-9);
    const snapped = place([{ start: 0, end: 55, layout: 'split', card: title('甲') }, { start: 55, end: 56, layout: 'full' }, { start: 56, end: 60, layout: 'full', card: cta }], captions, content);
    expect(ctaOf(snapped)?.start).toBeCloseTo(55, 6);
    snapped.forEach((s) => expect(s.end - s.start).toBeGreaterThanOrEqual(1 - 1e-9));
  });
  it('会截断或吃掉其他卡片、B-roll 素材、钩子时不提前：CTA 留在末尾，镜头原样', () => {
    const { captions, content } = typical();
    const broll: Shot = { start: 52, end: 57, layout: 'broll', broll: { file: 'broll/a.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } } };
    const withBroll: Shot[] = [{ start: 0, end: 52, layout: 'full' }, broll, { start: 57, end: 60, layout: 'full', card: cta }];
    expect(place(withBroll, captions, content)).toEqual(withBroll);
    const withCard: Shot[] = [{ start: 0, end: 52, layout: 'full' }, { start: 52, end: 56, layout: 'split', card: title('乙') }, { start: 56, end: 60, layout: 'full', card: cta }];
    expect(place(withCard, captions, content)).toEqual(withCard);
    const short: Shot[] = [{ start: 0, end: 3, layout: 'split', card: hook(1) }, { start: 3, end: 6, layout: 'full', card: cta }];
    expect(place(short, [cap(0, 2), cap(3.2, 5.8)], 6)).toEqual(short);
  });
  it('没有 CTA、没有字幕时镜头原样不动', () => {
    const { shots, captions, content } = typical();
    const noCta = shots.slice(0, -1).map((s, i, a) => (i === a.length - 1 ? { ...s, end: 60 } : s));
    expect(place(noCta, captions, content)).toEqual(noCta);
    expect(place(shots, [], content)).toEqual(shots);
  });
  it('幂等：对已提前的分镜再放一次结果不变；片尾设置变了会重新放置；放不下时还原成末尾 CTA', () => {
    const { shots, captions, content } = typical();
    const once = place(shots, captions, content);
    expect(place(once, captions, content)).toEqual(once);
    const noOutro = place(once, captions, content, false);
    expect(placedOf(ctaOf(noOutro))).toBe(true);
    // 提前后其后的镜头被改成 B-roll：不再是「CTA 之后全是纯人像」，原样保留
    const edited = once.map((s, i) => (i === once.length - 1 ? { ...s, layout: 'broll' as const, broll: { file: 'broll/a.mp4', kind: 'video' as const, focal: { x: 0.5, y: 0.5 } } } : s));
    expect(place(edited, captions, content)).toEqual(edited);
    // 最后一句之前被塞进一张卡片：还原后放不下，CTA 回到末尾且不带 placed
    const blocked: Shot[] = [{ start: 0, end: 50, layout: 'full' }, { start: 50, end: 56, layout: 'split', card: title('丙') },
      { start: 56, end: 57, layout: 'full', card: { template: 'cta', props: { actions: ['关注'], placed: true } } }, { start: 57, end: 60, layout: 'full' }];
    const back = place(blocked, captions, content);
    expect(back[back.length - 1].card?.template).toBe('cta');
    expect(placedOf(back[back.length - 1])).toBeUndefined();
  });
  it('不改入参', () => {
    const { shots, captions, content } = typical();
    const snapshot = JSON.stringify(shots);
    place(shots, captions, content);
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
    const on = planEnding(captions, content, true);
    expect(outroProps(on, DEFAULT_OUTRO, 'brand/logo.png')).toEqual({ startSec: on.outroStartSec, text: OUTRO_DEFAULT_TEXT, logo: 'brand/logo.png' });
    const off = planEnding(captions, content, false);
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

describe('已提前的 CTA 与分镜归一化', () => {
  it('归一化认 placed：不拉回末尾、不降级；未标记的末尾 CTA 行为不变', () => {
    const { shots, captions, content } = typical();
    const placed = placeCta(shots, captions, content, true);
    const again = normalizeStoryboard({ shots: placed }, content, []).storyboard.shots;
    const c = again.find((s) => s.card?.template === 'cta');
    expect(c).toEqual(placed.find((s) => s.card?.template === 'cta'));
    expect(again[again.length - 1].card).toBeUndefined();
    // 没标 placed 的 CTA 按旧规则：延伸回末尾，覆盖到内容结尾
    const unmarked = placed.map((s) => (s.card?.template === 'cta' ? { ...s, card: { template: 'cta' as const, props: { actions: ['关注'] } } } : s));
    const back = normalizeStoryboard({ shots: unmarked }, content, []).storyboard.shots;
    expect(back[back.length - 1].card?.template).toBe('cta');
    expect(back[back.length - 1].end).toBe(content);
    // 原始形态（CTA 在末尾覆盖最后一句）归一化后仍是末尾 CTA，由 placeCta 再提前
    const raw = normalizeStoryboard({ shots }, content, []).storyboard.shots;
    expect(raw[raw.length - 1].card?.template).toBe('cta');
  });
});
