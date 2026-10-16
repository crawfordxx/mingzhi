import { describe, expect, it } from 'vitest';
import {
  CTA_FROM_END, CTA_SEC, DEFAULT_OUTRO, HOLD_SEC, OUTRO_DEFAULT_TEXT, OUTRO_MAX_SEC, OUTRO_MIN_SEC, OUTRO_RATIO, outroProps, outroSecFor, placeCta, planEnding, resolveOutro,
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
  it('片尾时长 = clamp(片长 × 8%, 1.0, 2.5) 秒，整片时长 = 片尾开始 + 片尾时长；片尾开始在整帧上', () => {
    const { captions, content } = typical();
    const plan = planEnding(captions, content, true);
    expect(plan.durationSec - plan.outroStartSec).toBeCloseTo(outroSecFor(plan.outroStartSec), 6);
    expect(Math.abs(plan.outroStartSec * 30 - Math.round(plan.outroStartSec * 30))).toBeLessThan(1e-6);
    // 60 秒的片：8% = 4.8 秒，封顶 2.5 秒
    expect(plan.durationSec - plan.outroStartSec).toBeCloseTo(OUTRO_MAX_SEC, 1);
  });
  it('片尾时长随片长按比例：短片取下限 1 秒，中等片按 8%，长片封顶 2.5 秒；占比不超过 8%（下限除外）', () => {
    expect(OUTRO_RATIO).toBe(0.08);
    expect(outroSecFor(12)).toBeCloseTo(1, 1);
    expect(outroSecFor(8)).toBeCloseTo(OUTRO_MIN_SEC, 6);
    expect(outroSecFor(20)).toBeCloseTo(1.6, 1);
    expect(outroSecFor(25)).toBeCloseTo(2, 1);
    expect(outroSecFor(300)).toBeCloseTo(OUTRO_MAX_SEC, 6);
    [14, 20, 30, 45, 60].forEach((content) => {
      const plan = planEnding([cap(content - 3, content - 0.2)], content, true);
      const outro = plan.durationSec - plan.outroStartSec;
      expect(outro / plan.durationSec, String(content)).toBeLessThanOrEqual(OUTRO_RATIO + 1e-9);
      // 时刻按毫秒取整（11.133），所以与整帧差不到半毫秒
      expect(Math.abs(outro * 30 - Math.round(outro * 30)), String(content)).toBeLessThan(0.02);
    });
    // 两条验收 mock：横屏 11.1 秒内容、竖屏 12.0 秒内容，片尾占比 ≤ 8% 或只因 1 秒下限略高
    expect(outroSecFor(13.1)).toBeLessThanOrEqual(1.2);
    expect(outroSecFor(14.1)).toBeLessThanOrEqual(1.2);
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
  it('最后一句太长、窗口放不下时：CTA 放到最后一句之后（不再退到最后一句之前盖住前面的内容），不与它同时出现', () => {
    const shots: Shot[] = [{ start: 0, end: 56, layout: 'full' }, { start: 56, end: 60, layout: 'full', card: cta }];
    const caps = [cap(0, 10), cap(40, 59.8)];
    const out = place(shots, caps, 60);
    const c = ctaOf(out);
    expect(c).toBeDefined();
    expect(c?.start ?? 0).toBeGreaterThanOrEqual(59.8 - 1e-9);
    expect(c?.end ?? 0).toBeGreaterThan(60);
    expect(placedOf(c)).toBe(true);
    // CTA 是最后一个镜头；它之前镜头首尾相接覆盖到 CTA 起点
    expect(out[out.length - 1]).toBe(c);
    expect(covered(out.slice(0, -1), c?.start ?? 0)).toBe(true);
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
  it('会截断或吃掉其他卡片、B-roll 素材、钩子时不往前挪：改放到最后一句之后，已有镜头原样保留', () => {
    const { captions, content } = typical();
    const broll: Shot = { start: 52, end: 57, layout: 'broll', broll: { file: 'broll/a.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } } };
    const withBroll: Shot[] = [{ start: 0, end: 52, layout: 'full' }, broll, { start: 57, end: 60, layout: 'full', card: cta }];
    const a = place(withBroll, captions, content);
    expect(a.slice(0, 2)).toEqual(withBroll.slice(0, 2));
    expect(ctaOf(a)?.start ?? 0).toBeGreaterThanOrEqual(59.8 - 1e-9);
    const withCard: Shot[] = [{ start: 0, end: 52, layout: 'full' }, { start: 52, end: 56, layout: 'split', card: title('乙') }, { start: 56, end: 60, layout: 'full', card: cta }];
    const b = place(withCard, captions, content);
    expect(b.slice(0, 2)).toEqual(withCard.slice(0, 2));
    expect(ctaOf(b)?.start ?? 0).toBeGreaterThanOrEqual(59.8 - 1e-9);
    const short: Shot[] = [{ start: 0, end: 3, layout: 'split', card: hook(1) }, { start: 3, end: 6, layout: 'full', card: cta }];
    const c = place(short, [cap(0, 2), cap(3.2, 5.8)], 6);
    expect(c[0]).toEqual(short[0]);
    expect(ctaOf(c)?.start ?? 0).toBeGreaterThanOrEqual(5.8 - 1e-9);
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
    // 最后一句之前被塞进一张卡片：还原后前移放不下，CTA 改放到最后一句之后
    const blocked: Shot[] = [{ start: 0, end: 50, layout: 'full' }, { start: 50, end: 56, layout: 'split', card: title('丙') },
      { start: 56, end: 57, layout: 'full', card: { template: 'cta', props: { actions: ['关注'], placed: true } } }, { start: 57, end: 60, layout: 'full' }];
    const back = place(blocked, captions, content);
    expect(back[back.length - 1].card?.template).toBe('cta');
    expect(back[back.length - 1].start).toBeGreaterThanOrEqual(59.8 - 1e-9);
  });
  it('不改入参', () => {
    const { shots, captions, content } = typical();
    const snapshot = JSON.stringify(shots);
    place(shots, captions, content);
    expect(JSON.stringify(shots)).toBe(snapshot);
  });
});

describe('placeCta：短片放到最后一句之后（两条验收 mock 的形态）', () => {
  const ctaOf = (shots: Shot[]): Shot | undefined => shots.find((s) => s.card?.template === 'cta');
  const names = (c: Shot | undefined): string[] => (c?.card?.template === 'cta' ? c.card.props.actions : []);
  /** 横屏 mock：11.133 秒内容，最后一个内容句「口误和气口它 / 都会自动剪掉」8.18–11.0（两行字幕一句话），CTA 原在 9.1–11.133 */
  const landscape = {
    shots: [{ start: 0, end: 3.1, layout: 'full' }, { start: 3.1, end: 6.167, layout: 'split', card: title('甲') }, { start: 6.167, end: 9.1, layout: 'split', card: title('乙') }, { start: 9.1, end: 11.133, layout: 'full', card: cta }] as Shot[],
    captions: [{ start: 0.68, end: 2.99, text: '今天聊聊怎么用 AI 剪口播' }, { start: 6.2, end: 8.18, text: '现在只要把原片丢进去' }, { start: 8.18, end: 9.32, text: '口误和气口它' }, { start: 9.77, end: 11, text: '都会自动剪掉' }],
    content: 11.133,
  };
  /** 竖屏 mock：内容句「第三个 / 每天睡前 / 列出明天的清单」9.369–12.007，CTA 原在 10.1–12.133 */
  const portrait = {
    shots: [{ start: 0, end: 3.867, layout: 'split', card: hook(1) }, { start: 3.867, end: 6.167, layout: 'split', card: title('甲') }, { start: 6.167, end: 9, layout: 'full' }, { start: 9, end: 10.1, layout: 'split', card: title('丙') }, { start: 10.1, end: 12.133, layout: 'full', card: cta }] as Shot[],
    captions: [{ start: 7.085, end: 8.839, text: '手机放到另一个房间' }, { start: 9.369, end: 10.029, text: '第三个' }, { start: 10.029, end: 10.869, text: '每天睡前' }, { start: 10.869, end: 12.007, text: '列出明天的清单' }],
    content: 12.133,
  };
  const overlap = (c: Shot | undefined, a: number, b: number): number => Math.min(c?.end ?? 0, b) - Math.max(c?.start ?? 0, a);

  it.each([['横屏', landscape, 8.18, 11], ['竖屏', portrait, 9.369, 12.007]] as const)('%s：CTA 不盖住最后一个内容句，起点在内容句结束之后', (_n, mock, sentenceStart, sentenceEnd) => {
    const out = placeCta(mock.shots, mock.captions, mock.content, true);
    const c = ctaOf(out);
    expect(c).toBeDefined();
    expect(overlap(c, sentenceStart, sentenceEnd)).toBeLessThanOrEqual(1e-9);
    expect(c?.start ?? 0).toBeGreaterThanOrEqual(sentenceEnd - 1e-9);
    expect((c?.start ?? 0) - sentenceEnd).toBeLessThan(0.5);
    expect((c?.end ?? 0) - (c?.start ?? 0)).toBeGreaterThanOrEqual(CTA_SEC.min - 1e-9);
    expect(out[out.length - 1]).toBe(c);
    expect(names(c)).toEqual(['关注', '点赞', '收藏']);
  });
  it('CTA 结束就是片尾开始（planEnding 认 CTA 的结束），片尾占比 ≤ 8%（短片下限除外）', () => {
    [landscape, portrait].forEach((mock) => {
      const out = placeCta(mock.shots, mock.captions, mock.content, true);
      const c = ctaOf(out);
      const plan = planEnding(mock.captions, mock.content, true, out);
      expect(plan.outroStartSec).toBeCloseTo(c?.end ?? 0, 6);
      expect(plan.durationSec - plan.outroStartSec).toBeLessThanOrEqual(1.2);
      expect((plan.durationSec - plan.outroStartSec) / plan.durationSec).toBeLessThan(0.085);
    });
  });
  it('卡片和前面的镜头原样保留，CTA 之前的镜头覆盖到 CTA 起点，幂等', () => {
    [landscape, portrait].forEach((mock) => {
      const out = placeCta(mock.shots, mock.captions, mock.content, true);
      const c = ctaOf(out);
      const body = out.slice(0, -1);
      expect(covered(body, c?.start ?? 0)).toBe(true);
      mock.shots.filter((s) => s.card && s.card.template !== 'cta').forEach((card) => expect(body.some((s) => s.card === card.card)).toBe(true));
      expect(placeCta(out, mock.captions, mock.content, true)).toEqual(out);
    });
  });
  it('内容句之后还有「关注我」这类收尾话：不算内容句，CTA 可以与它同时出现', () => {
    const shots: Shot[] = [{ start: 0, end: 6, layout: 'full' }, { start: 6, end: 10, layout: 'full', card: cta }];
    const caps = [{ start: 1, end: 5.5, text: '这就是三个关键点' }, { start: 7, end: 9.5, text: '记得点赞关注我' }];
    const out = placeCta(shots, caps, 10, true);
    const c = ctaOf(out);
    expect(overlap(c, 1, 5.5)).toBeLessThanOrEqual(1e-9);
    expect(c?.start ?? 0).toBeGreaterThanOrEqual(5.5 - 1e-9);
  });
  it('不改入参；没有字幕时不动', () => {
    const snap = JSON.stringify(landscape.shots);
    placeCta(landscape.shots, landscape.captions, landscape.content, true);
    expect(JSON.stringify(landscape.shots)).toBe(snap);
    expect(placeCta(landscape.shots, [], landscape.content, true)).toEqual(landscape.shots);
  });
  it('长片窗口放得下时仍放在倒数 5–8 秒、最后一个内容句开始前（不用延长片长）', () => {
    const shots: Shot[] = [{ start: 0, end: 56, layout: 'full' }, { start: 56, end: 60, layout: 'full', card: cta }];
    const out = placeCta(shots, [cap(0, 10), cap(57, 59.8)], 60, true);
    const c = ctaOf(out);
    expect((c?.end ?? 99)).toBeLessThanOrEqual(57 + 1e-9);
    expect(out[out.length - 1].end).toBe(60);
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

describe('人像定格点与分段缓存', () => {
  const props = { person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 6.4, captions: [{ start: 0, end: 2.8, text: '一句话' }] };
  const shots: Shot[] = [{ start: 0, end: 1.5, layout: 'full' }, { start: 1.5, end: 5, layout: 'full', card: { template: 'cta', props: { actions: ['关注'], placed: true } } }];
  const hashes = (contentSec?: number): string[] => segmentBounds(shots, props.durationSec).map((range, i) => shotHash(shots[i], { ...props, ...(contentSec === undefined ? {} : { contentSec }) }, i, { shots, range }));
  it('CTA 超出口播内容结尾时，人像定格点（contentSec）只影响包含它的末段', () => {
    const a = hashes(3);
    const b = hashes(3.5);
    expect(b[0]).toBe(a[0]);
    expect(b[1]).not.toBe(a[1]);
    // 内容结尾在 CTA 之后（没有超出）：不进哈希，与没给时一致
    expect(hashes(6.4)).toEqual(hashes());
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
  it('提前到片尾前的 CTA（placed，结束晚于片长）归一化不截断、不丢、不拉长；planEnding 的片尾接在它之后', () => {
    const shots: Shot[] = [{ start: 0, end: 3.1, layout: 'full' }, { start: 3.1, end: 6.1, layout: 'split', card: title('甲') }, { start: 6.1, end: 11.1, layout: 'full' },
      { start: 11.1, end: 13.1, layout: 'full', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'], placed: true } } }];
    const again = normalizeStoryboard({ shots }, 11.133, []).storyboard.shots;
    expect(again[again.length - 1]).toEqual(shots[3]);
    expect(again).toHaveLength(4);
    expect(again.slice(0, 3).map((s) => [s.start, s.end])).toEqual([[0, 3.1], [3.1, 6.1], [6.1, 11.1]]);
  });
});
