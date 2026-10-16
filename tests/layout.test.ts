import { describe, expect, it } from 'vitest';
import { blendTransform, captionAt, personTransform, shotAt } from '../src/compose/layout.js';
import { CANVAS, ShotSchema, type Broll, type Shot } from '../src/storyboard/schema.js';
import { FULL_CAPTION_Y } from '../src/captions/styles.js';
import { J_CUT_FRAMES, KB_PUSH, LAYOUT_TRANSITION_SEC, PIP, captionCenterY, captionSec, grainOn, kenBurnsAt, kenBurnsRects, underlayAt, visualLayout, visualShots, type Rect } from '../src/compose/layout.js';

describe('personTransform', () => {
  it('全屏：按宽铺满并垂直居中（9:16 视频正好铺满）', () => {
    expect(personTransform('full', null, 360, 640)).toEqual({ scale: 3, x: 0, y: 0 });
  });
  it('分屏：按宽铺满，头顶放在分界线下 60px，且画面不露出分界线以上、不露出底部', () => {
    const t = personTransform('split', { top: 0.2, bottom: 1, left: 0.2, right: 0.8 }, 1080, 1920);
    expect(t.scale).toBe(1);
    expect(t.x).toBe(0);
    expect(t.y).toBe(960 + 60 - 0.2 * 1920);
  });
  it('分屏：头顶很低时 y 不超过分界线（上方不露底色）；头顶很高时视频底部不高于画布底', () => {
    expect(personTransform('split', { top: 0, bottom: 1, left: 0, right: 1 }, 1080, 1920).y).toBe(960);
    // 1080×1350 的横宽视频：缩放后高 1350，y 最小为 1920-1350=570，但不能超过 960
    const wide = personTransform('split', { top: 0.9, bottom: 1, left: 0, right: 1 }, 1080, 1350);
    expect(wide.y).toBe(570);
  });
  it('横屏原片全屏：按高铺满（cover），水平方向以人物中心对齐且不露边', () => {
    // 1280×720 → scale = 1920/720；人物居中 → x 让人物中心落在画布中线
    const t = personTransform('full', { top: 0.1, bottom: 1, left: 0.4, right: 0.6 }, 1280, 720);
    expect(t.scale).toBeCloseTo(1920 / 720);
    expect(t.y).toBe(0);
    const w = 1280 * t.scale;
    expect(t.x).toBe(Math.round(540 - 0.5 * w));
    // 人物在画面最左：x 夹到 0，不露出右侧底色
    expect(personTransform('full', { top: 0.1, bottom: 1, left: 0, right: 0.1 }, 1280, 720).x).toBe(0);
    expect(personTransform('full', { top: 0.1, bottom: 1, left: 0.9, right: 1 }, 1280, 720).x).toBe(Math.round(1080 - w));
  });
  it('横屏原片分屏：下半屏（960 高）铺满，不留空', () => {
    const t = personTransform('split', { top: 0.15, bottom: 1, left: 0.3, right: 0.7 }, 1280, 720);
    const h = 720 * t.scale;
    expect(h).toBeGreaterThanOrEqual(960);
    expect(t.y).toBeLessThanOrEqual(960);
    expect(t.y + h).toBeGreaterThanOrEqual(1920);
    expect(t.x).toBeLessThanOrEqual(0);
    expect(t.x + 1280 * t.scale).toBeGreaterThanOrEqual(1080);
  });
  it('没有取景框时分屏按画面居中（不按头顶估计位置压到底边）', () => {
    // 1080×1920：视频高 1920、区域高 960，视频中心对齐区域中心 → y = 960 + (960 - 1920) / 2
    expect(personTransform('split', null, 1080, 1920).y).toBe(480);
    // 1280×720：铺满区域后高 960，居中即贴合区域，y 恰为分界线
    expect(personTransform('split', null, 1280, 720).y).toBe(960);
  });
  it('没有取景框时分屏的视频始终盖住下半屏（上不超分界线、下不露底）', () => {
    for (const [w, h] of [[1080, 1920], [720, 1280], [1280, 720], [1080, 1350]] as const) {
      const t = personTransform('split', null, w, h);
      expect(t.y).toBeLessThanOrEqual(960);
      expect(t.y + h * t.scale).toBeGreaterThanOrEqual(1920);
    }
  });
});

describe('blendTransform / captionAt / shotAt', () => {
  it('线性插值', () => {
    expect(blendTransform({ scale: 1, x: 0, y: 0 }, { scale: 3, x: 10, y: 100 }, 0.5)).toEqual({ scale: 2, x: 5, y: 50 });
  });
  it('按时间找当前字幕与镜头；不在任何区间返回 null', () => {
    const caps = [{ start: 0, end: 1, text: 'a' }, { start: 1.5, end: 2, text: 'b' }];
    expect(captionAt(caps, 0.5)?.text).toBe('a');
    expect(captionAt(caps, 1.2)).toBeNull();
    const shots = [{ start: 0, end: 2, layout: 'full' as const }, { start: 2, end: 4, layout: 'split' as const }];
    expect(shotAt(shots, 2)).toEqual({ shot: shots[1], index: 1 });
    expect(shotAt(shots, 9)).toBeNull();
  });
});

// ---------- P7：新版式（broll / pip / overlay）、J-cut、Ken Burns ----------

const BROLL: Broll = { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const inside = (r: Rect): boolean => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9;
const center = (r: Rect): { x: number; y: number } => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const dist = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

describe('分镜模式：新版式与 broll 字段', () => {
  it('旧数据（无 broll、split/full）照常通过且不多出字段', () => {
    const p = ShotSchema.safeParse({ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: '标题' } } });
    expect(p.success && !('broll' in p.data)).toBe(true);
  });
  it('broll/pip/overlay 与 broll 字段（含 Ken Burns 裁框）可通过', () => {
    for (const layout of ['broll', 'pip', 'overlay'] as const) {
      expect(ShotSchema.safeParse({ start: 0, end: 2, layout, broll: { ...BROLL, kenBurns: { from: { x: 0, y: 0, w: 1, h: 1 }, to: { x: 0.05, y: 0.05, w: 0.9, h: 0.9 } } } }).success).toBe(true);
    }
  });
  it('焦点越界、裁框越界或与画面不同比例时拒绝', () => {
    const bad = (broll: unknown): boolean => ShotSchema.safeParse({ start: 0, end: 2, layout: 'broll', broll }).success;
    expect(bad({ ...BROLL, focal: { x: 1.2, y: 0.5 } })).toBe(false);
    expect(bad({ ...BROLL, kenBurns: { from: { x: 0.2, y: 0, w: 0.9, h: 0.9 }, to: { x: 0, y: 0, w: 1, h: 1 } } })).toBe(false);
    expect(bad({ ...BROLL, kenBurns: { from: { x: 0, y: 0, w: 0.9, h: 0.6 }, to: { x: 0, y: 0, w: 1, h: 1 } } })).toBe(false);
    expect(bad({ ...BROLL, kind: 'gif' })).toBe(false);
  });
});

describe('visualLayout：缺素材或缺内容时退回全屏', () => {
  it('broll / pip 没有素材、overlay 既无卡片也无素材时按 full；其余原样', () => {
    expect(visualLayout({ start: 0, end: 1, layout: 'broll' })).toBe('full');
    expect(visualLayout({ start: 0, end: 1, layout: 'pip' })).toBe('full');
    expect(visualLayout({ start: 0, end: 1, layout: 'overlay' })).toBe('full');
    expect(visualLayout({ start: 0, end: 1, layout: 'broll', broll: BROLL })).toBe('broll');
    expect(visualLayout({ start: 0, end: 1, layout: 'pip', broll: BROLL })).toBe('pip');
    expect(visualLayout({ start: 0, end: 1, layout: 'overlay', broll: BROLL })).toBe('overlay');
    expect(visualLayout({ start: 0, end: 1, layout: 'overlay', card: { template: 'title', props: { title: 't' } } })).toBe('overlay');
    expect(visualLayout({ start: 0, end: 1, layout: 'split' })).toBe('split');
  });
});

describe('字幕中心 y', () => {
  it('分屏压在分界线上；全屏、全屏插入、画中画、浮层都在 y≈1400', () => {
    expect(captionCenterY('split')).toBe(CANVAS.seam);
    for (const l of ['full', 'broll', 'pip', 'overlay'] as const) expect(captionCenterY(l)).toBe(FULL_CAPTION_Y);
    expect(FULL_CAPTION_Y).toBe(1400);
  });
});

describe('J-cut：全屏插入的画面比声音晚 2 帧切入', () => {
  const f = J_CUT_FRAMES / CANVAS.fps;
  it('broll 镜头起点推后 2 帧，前一个镜头的画面延长 2 帧；其他镜头不变', () => {
    const shots: Shot[] = [{ start: 0, end: 2, layout: 'full' }, { start: 2, end: 4, layout: 'broll', broll: BROLL }, { start: 4, end: 6, layout: 'pip', broll: BROLL }];
    const vis = visualShots(shots);
    expect(J_CUT_FRAMES).toBe(2);
    expect(vis[0]).toEqual({ ...shots[0], end: 2 + f });
    expect(vis[1]).toEqual({ ...shots[1], start: 2 + f });
    expect(vis[2]).toEqual(shots[2]);
  });
  it('首个镜头、没有素材的 broll、不足 3 帧的镜头不做 J-cut；不改动入参', () => {
    const first: Shot[] = [{ start: 0, end: 2, layout: 'broll', broll: BROLL }];
    expect(visualShots(first)).toEqual(first);
    const bare: Shot[] = [{ start: 0, end: 2, layout: 'full' }, { start: 2, end: 4, layout: 'broll' }];
    expect(visualShots(bare)).toEqual(bare);
    const tiny: Shot[] = [{ start: 0, end: 2, layout: 'full' }, { start: 2, end: 2 + f, layout: 'broll', broll: BROLL }];
    expect(visualShots(tiny)).toEqual(tiny);
    const frozen = Object.freeze([Object.freeze({ start: 0, end: 2, layout: 'full' as const }), Object.freeze({ start: 2, end: 4, layout: 'broll' as const, broll: BROLL })]);
    expect(() => visualShots(frozen as Shot[])).not.toThrow();
  });
});

describe('画中画人像', () => {
  it('窗口 360×480，右缘对齐字幕安全线（x=960），底边在 2 行字幕上方', () => {
    expect([PIP.w, PIP.h]).toEqual([360, 480]);
    expect(PIP.x + PIP.w).toBe(960);
    expect(PIP.y + PIP.h).toBeLessThanOrEqual(FULL_CAPTION_Y - 72 - 24);
    expect(PIP.y).toBeGreaterThan(CANVAS.seam - 200);
  });
  it('竖屏原片：铺满窗口不露底，头顶落在窗口上方约 10% 处，窗口带圆角', () => {
    const t = personTransform('pip', { top: 0.12, bottom: 1, left: 0.3, right: 0.7 }, 1080, 1920);
    expect(t.clip).toEqual({ x: PIP.x, y: PIP.y, w: PIP.w, h: PIP.h, radius: PIP.radius });
    const w = 1080 * t.scale;
    const h = 1920 * t.scale;
    expect(t.x).toBeLessThanOrEqual(PIP.x);
    expect(t.x + w).toBeGreaterThanOrEqual(PIP.x + PIP.w);
    expect(t.y).toBeLessThanOrEqual(PIP.y);
    expect(t.y + h).toBeGreaterThanOrEqual(PIP.y + PIP.h);
    expect(t.y + 0.12 * h - PIP.y).toBeCloseTo(PIP.h * 0.1, 0);
  });
  it('横屏原片、人物在最左：仍铺满窗口（x 夹住不露底）', () => {
    const t = personTransform('pip', { top: 0.1, bottom: 1, left: 0, right: 0.1 }, 1280, 720);
    expect(t.x).toBe(PIP.x);
    expect(t.x + 1280 * t.scale).toBeGreaterThanOrEqual(PIP.x + PIP.w);
    expect(t.y + 720 * t.scale).toBeGreaterThanOrEqual(PIP.y + PIP.h);
  });
  it('全屏、浮层、全屏插入的人像与 full 相同；全屏/分屏不带窗口字段（旧行为不变）', () => {
    const full = personTransform('full', null, 1080, 1920);
    expect(personTransform('overlay', null, 1080, 1920)).toEqual(full);
    expect(personTransform('broll', null, 1080, 1920)).toEqual(full);
    expect('clip' in full).toBe(false);
    expect('clip' in personTransform('split', null, 1080, 1920)).toBe(false);
  });
  it('过渡插值：全屏 → 画中画的窗口从整张画布连续收拢到小窗', () => {
    const a = personTransform('full', null, 1080, 1920);
    const b = personTransform('pip', null, 1080, 1920);
    const mid = blendTransform(a, b, 0.5);
    expect(mid.clip).toEqual({ x: PIP.x / 2, y: PIP.y / 2, w: (1080 + PIP.w) / 2, h: (1920 + PIP.h) / 2, radius: PIP.radius / 2 });
    expect(blendTransform(a, b, 1)).toEqual(b);
    expect(blendTransform(a, a, 0.3)).toEqual(a);
  });
});

describe('Ken Burns 起止裁框', () => {
  it('焦点居中：同比例裁框、都在画面内，推近 8–12%', () => {
    const kb = kenBurnsRects({ x: 0.5, y: 0.5 });
    for (const r of [kb.from, kb.to]) {
      expect(inside(r)).toBe(true);
      expect(r.w).toBeCloseTo(r.h, 9);
    }
    const push = kb.from.w / kb.to.w - 1;
    expect(push).toBeGreaterThanOrEqual(0.08);
    expect(push).toBeLessThanOrEqual(0.12);
    expect(KB_PUSH).toBeCloseTo(push, 9);
  });
  it('焦点在角落：推向主体（终点中心比起点更靠近焦点），裁框仍不出画', () => {
    for (const focal of [{ x: 0.9, y: 0.15 }, { x: 0.05, y: 0.95 }, { x: 0.3, y: 0.6 }]) {
      const kb = kenBurnsRects(focal);
      expect(inside(kb.from) && inside(kb.to)).toBe(true);
      expect(dist(center(kb.to), focal)).toBeLessThan(dist(center(kb.from), focal));
    }
  });
  it('kenBurnsAt：两端等于起止裁框，中间 inOut 缓动（开头慢）', () => {
    const kb = kenBurnsRects({ x: 0.7, y: 0.4 });
    expect(kenBurnsAt(kb, 0)).toEqual(kb.from);
    expect(kenBurnsAt(kb, 1)).toEqual(kb.to);
    const early = kenBurnsAt(kb, 0.1);
    expect(Math.abs(early.w - kb.from.w)).toBeLessThan(Math.abs(kb.to.w - kb.from.w) * 0.1);
    const mid = kenBurnsAt(kb, 0.5);
    expect(mid.w).toBeCloseTo((kb.from.w + kb.to.w) / 2, 6);
    expect(kenBurnsAt(kb, -1)).toEqual(kb.from);
    expect(kenBurnsAt(kb, 2)).toEqual(kb.to);
  });
});

describe('修复轮 1：素材路径、画中画退出垫底、字幕时钟、颗粒开关', () => {
  const ok = (broll: unknown): boolean => ShotSchema.safeParse({ start: 0, end: 2, layout: 'broll', broll }).success;
  it('素材路径：只收项目内相对路径与白名单扩展名，类型与扩展名一致；可选时长为正数', () => {
    expect(ok({ ...BROLL, file: 'broll/a.webp' })).toBe(true);
    expect(ok({ ...BROLL, file: 'broll/a.mp4', kind: 'video', durationSec: 2.5 })).toBe(true);
    for (const file of ['../a.jpg', 'broll/../../a.jpg', '/etc/a.jpg', 'C:/a.jpg', 'broll\\a.jpg', 'broll/a.txt', 'broll/a', 'https://x.com/a.jpg']) expect(ok({ ...BROLL, file }), file).toBe(false);
    expect(ok({ ...BROLL, file: 'broll/a.mp4' })).toBe(false);
    expect(ok({ ...BROLL, file: 'broll/a.jpg', kind: 'video' })).toBe(false);
    expect(ok({ ...BROLL, file: 'broll/a.mp4', kind: 'video', durationSec: 0 })).toBe(false);
  });
  it('画中画退出：后一个镜头的前 0.4 秒仍用画中画的素材垫底（镜头内时间接着走），之后不画', () => {
    const V: Broll = { file: 'broll/v.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } };
    const shots: Shot[] = [{ start: 0, end: 2, layout: 'full' }, { start: 2, end: 4, layout: 'pip', broll: V }, { start: 4, end: 6, layout: 'full' }, { start: 6, end: 8, layout: 'pip', broll: V }];
    expect(LAYOUT_TRANSITION_SEC).toBe(0.4);
    expect(underlayAt(shots, 1)).toBeNull();
    expect(underlayAt(shots, 3)).toMatchObject({ index: 1, local: 1, dur: 2 });
    expect(underlayAt(shots, 4.1)).toMatchObject({ index: 1, dur: 2 });
    expect(underlayAt(shots, 4.1)?.local).toBeCloseTo(2.1, 9);
    expect(underlayAt(shots, 4.4)).toBeNull();
    expect(underlayAt(shots, 6.1)).toMatchObject({ index: 3 });
    // 后一个是全屏插入：素材层自己盖住，不需要垫底
    const toBroll: Shot[] = [{ start: 0, end: 2, layout: 'pip', broll: V }, { start: 2, end: 4, layout: 'broll', broll: BROLL }];
    expect(underlayAt(toBroll, 2.1)).toBeNull();
  });
  it('字幕时钟：J-cut 的前 2 帧仍显示切点前的字幕（文字与位置都跟画面一起切），其余时刻不变', () => {
    const shots: Shot[] = [{ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: 't' } } }, { start: 2, end: 4, layout: 'broll', broll: BROLL }];
    expect(captionSec(shots, 1)).toBe(1);
    expect(captionSec(shots, 2)).toBeLessThan(2);
    expect(captionSec(shots, 2)).toBeGreaterThan(2 - 1e-6);
    expect(captionSec(shots, 2 + 1 / CANVAS.fps)).toBeLessThan(2);
    expect(captionSec(shots, 2 + J_CUT_FRAMES / CANVAS.fps)).toBe(2 + J_CUT_FRAMES / CANVAS.fps);
    const caps = [{ start: 0, end: 2, text: '旧句' }, { start: 2, end: 4, text: '新句' }];
    expect(captionAt(caps, captionSec(shots, 2))?.text).toBe('旧句');
    expect(captionAt(caps, captionSec(shots, 2 + 2 / 30))?.text).toBe('新句');
  });
  it('颗粒：显式设置优先；未设置时只有用到 B-roll 的分镜才开（旧项目不变）', () => {
    const old: Shot[] = [{ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: 't' } } }];
    const fresh: Shot[] = [...old, { start: 2, end: 4, layout: 'broll', broll: BROLL }];
    expect(grainOn({ shots: old })).toBe(false);
    expect(grainOn({ shots: fresh })).toBe(true);
    expect(grainOn({ shots: old, grain: true })).toBe(true);
    expect(grainOn({ shots: fresh, grain: false })).toBe(false);
  });
});
