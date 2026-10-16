// 整片自检的真实渲染部分：铺图卡片文字对比度（显示 / 隐去文字两张静帧相减）、铺图变体复测；卡片自带生成图的「AI 生成」角标
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStill, selectComposition } from '@remotion/renderer';
import { loadConfig } from '../src/config.js';
import { withBundle } from '../src/compose/render.js';
import { run, runBuffer } from '../src/media/exec.js';
import { measureReadability } from '../src/qa/readability.js';
import { boostMotion, planRedo } from '../src/qa/film-redo.js';
import type { FilmReport } from '../src/qa/film.js';
import type { Broll, CardSpec, Shot, Storyboard } from '../src/storyboard/schema.js';

const cfg = loadConfig({});
const workDir = mkdtempSync(join(tmpdir(), 'mz-film-render-'));
const WHITE: Broll = { file: 'broll/white.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const GRAY: Broll = { file: 'broll/gray.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const CHECKER: Broll = { file: 'broll/checker.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const DETAIL: Broll = { file: 'broll/detail.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const DARK: Broll = { file: 'broll/dark.png', kind: 'photo', focal: { x: 0.5, y: 0.5 } };
const hook: CardSpec = { template: 'hook', props: { index: 1, total: 1, headline: '白字压在亮图上看不清', highlight: [] } };
const list: CardSpec = { template: 'evidenceList', props: { title: '玻璃卡上的深色字', rows: [{ badge: '要点', text: '第一条' }, { badge: '要点', text: '第二条' }] } };
const sb = (shots: Shot[]): Storyboard => ({ shots, bgm: 'chill' });

beforeAll(async () => {
  mkdirSync(join(workDir, 'broll'));
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0xF4F4F2:s=1080x960', '-frames:v', '1', join(workDir, WHITE.file)]);
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x8A8A8A:s=1080x960', '-frames:v', '1', join(workDir, GRAY.file)]);
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x2E5A3C:s=1080x960', '-frames:v', '1', join(workDir, 'broll/gen.png')]);
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=0x141312:s=1080x960', '-frames:v', '1', join(workDir, DARK.file)]);
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'mandelbrot=s=1080x960', '-frames:v', '1', join(workDir, DETAIL.file)]);
  // 白灰相间的亮图：配钩子的大标题与大数字，铺图变体都压不住
  await run(cfg.ffmpeg, ['-v', 'error', '-f', 'lavfi', '-i', 'nullsrc=s=1080x960,geq=lum=if(mod(floor(X/40)+floor(Y/40)\\,2)\\,255\\,200):cb=128:cr=128', '-frames:v', '1', join(workDir, CHECKER.file)]);
}, 60_000);

describe('铺图卡片可读性（真实渲染）', () => {
  it('不达标时先量铺图变体：亮图上的钩子、暗图上的对比条卡换成变体后都 ≥ 4.5，局部重做选变体（保留底图），复测达标', async () => {
    const bars: CardSpec = { template: 'compareBars', props: { crumb: '剪辑效率对比', items: [{ name: '传统剪辑', note: '要两三个小时', value: 0.9, annotation: '极慢', tone: 'bad' }, { name: 'AI 剪辑', note: '自动处理', value: 0.1, annotation: '极速', tone: 'good' }] } };
    const shots: Shot[] = [
      { start: 0, end: 3, layout: 'split', card: hook, broll: WHITE },
      { start: 3, end: 6, layout: 'full' },
      { start: 6, end: 10, layout: 'split', card: bars, broll: DARK },
      { start: 10, end: 14, layout: 'split', card: list, broll: GRAY },
    ];
    const before = await measureReadability({ workDir, storyboard: sb(shots), ffmpeg: cfg.ffmpeg });
    expect(before.map((c) => c.shotIndex)).toEqual([0, 2, 3]);
    for (const c of before.slice(0, 2)) {
      expect(c.contrast).toBeLessThan(4.5);
      expect(c.legible).toBeGreaterThanOrEqual(4.5);
    }
    expect(before[2].contrast).toBeGreaterThanOrEqual(4.5);
    expect(before[2].legible).toBeUndefined(); // 达标的不再量变体
    const report: FilmReport = { ok: false, durationSec: 14, metrics: [{ id: 'readability', label: '', value: before[0].contrast, limit: 4.5, ok: false, detail: '', shots: [0, 2] }], templates: [], skipped: [], contrasts: before };
    const plan = planRedo(sb(shots), report, [], 14);
    expect(plan.actions.map((a) => [a.shotIndex, a.kind])).toEqual([[0, 'legible'], [2, 'legible']]);
    expect(plan.storyboard.shots.filter((s) => s.broll)).toHaveLength(3); // 底图都保留
    expect(plan.storyboard.shots[1]).toEqual(shots[1]);
    expect(plan.storyboard.shots[3]).toEqual(shots[3]);
    const after = await measureReadability({ workDir, storyboard: plan.storyboard, ffmpeg: cfg.ffmpeg });
    for (const c of after) expect(c.contrast).toBeGreaterThanOrEqual(4.5);
  }, 240_000);
});

describe('铺图变体不够时继续压暗、换文字位置，最后才撤图（真实渲染）', () => {
  const stat: CardSpec = { template: 'hook', props: { index: 1, total: 1, headline: '三个提高效率的小习惯', highlight: ['提高效率'], kicker: '先做最难的事', stat: { value: '3 个', label: '小习惯' } } };

  it('带「AI 生成」角标的亮图：角标画在压暗层之上，不被一起压暗，压暗后更清楚', async () => {
    const labeled: Broll = { ...WHITE, label: { kind: 'ai', text: 'AI 生成' } };
    const shots: Shot[] = [{ start: 0, end: 3, layout: 'split', card: hook, broll: labeled }];
    const [c] = await measureReadability({ workDir, storyboard: sb(shots), ffmpeg: cfg.ffmpeg });
    expect(c.contrast).toBeLessThan(4.5);
    // 纯白图上角标的半透明底也是浅色，铺图变体不够；沿台阶压暗后达标（角标在压暗层之上，越压暗越清楚）
    expect(c.fix?.contrast).toBeGreaterThanOrEqual(4.5);
    // 压暗到 0.65：角标依然清楚（不会被压暗层盖掉而「消失」，也不是量不到）
    const dark = await measureReadability({ workDir, storyboard: sb([{ ...shots[0], broll: { ...labeled, legible: true, shade: 0.65 } }]), ffmpeg: cfg.ffmpeg });
    expect(dark[0]?.contrast ?? 21).toBeGreaterThanOrEqual(4.5);
  }, 240_000);

  it('亮图上的大钩子：铺图变体只有 2 左右，沿台阶找到达标的一级（文字挪到上方并压暗），底图保留，复测达标', async () => {
    const shots: Shot[] = [{ start: 0, end: 3, layout: 'split', card: stat, broll: CHECKER }, { start: 3, end: 6, layout: 'full' }];
    const before = await measureReadability({ workDir, storyboard: sb(shots), ffmpeg: cfg.ffmpeg });
    expect(before[0].contrast).toBeLessThan(4.5);
    expect(before[0].legible).toBeLessThan(4.5);
    expect(before[0].fix?.contrast).toBeGreaterThanOrEqual(4.5);
    expect(before[0].fix?.tweak).toMatchObject({ legible: true, textTop: true });
    const report: FilmReport = { ok: false, durationSec: 6, metrics: [{ id: 'readability', label: '', value: before[0].contrast, limit: 4.5, ok: false, detail: '', shots: [0] }], templates: [], skipped: [], contrasts: before };
    const plan = planRedo(sb(shots), report, [], 6);
    expect(plan.actions).toEqual([expect.objectContaining({ shotIndex: 0, kind: 'legible' })]);
    expect(plan.storyboard.shots[0].broll).toMatchObject({ file: CHECKER.file, legible: true, textTop: true });
    const after = await measureReadability({ workDir, storyboard: plan.storyboard, ffmpeg: cfg.ffmpeg });
    expect(after[0].contrast).toBeGreaterThanOrEqual(4.5);
  }, 240_000);
});

describe('压暗后上半屏仍在动（真实渲染）', () => {
  /** 同一镜头隔 0.2 秒两帧在 108×96 灰度上的平均绝对差（与整片自检的静止判定同口径，阈值 0.8） */
  async function motion(broll: Broll): Promise<number> {
    const shot: Shot = { start: 0, end: 4, layout: 'split', card: hook, broll };
    const inputProps = { card: hook, dur: 4, shot, hideText: false };
    const grays = await withBundle(workDir, async (serveUrl) => {
      const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
      const out: Uint8Array[] = [];
      for (const frame of [60, 66]) {
        const png = join(workDir, `motion-${frame}.png`);
        await renderStill({ composition, serveUrl, inputProps, output: png, frame, imageFormat: 'png' });
        out.push(new Uint8Array(await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', png, '-vf', 'scale=108:96:flags=area,format=gray', '-f', 'rawvideo', '-'])));
      }
      return out;
    });
    return grays[0].reduce((n, v, i) => n + Math.abs(v - grays[1][i]), 0) / grays[0].length;
  }

  it('压暗 45% 会把推近的帧差压低；同步加大推近后帧差回到不压暗时以上，不会被判静止', async () => {
    const plain = await motion({ ...DETAIL, legible: true });
    const shaded = await motion({ ...DETAIL, legible: true, shade: 0.45 });
    const boosted = await motion(boostMotion({ ...DETAIL, legible: true, shade: 0.45 }));
    expect(shaded).toBeLessThan(plain);
    expect(boosted).toBeGreaterThan(shaded);
    expect(boosted).toBeGreaterThanOrEqual(plain * 0.9);
    expect(boosted).toBeGreaterThan(0.8);
  }, 240_000);
});

describe('卡片自带生成图的「AI 生成」角标', () => {
  /** 钩子卡（自带图）右上角区域的 RGB */
  async function corner(card: CardSpec, serveUrl: string, out: string): Promise<Uint8Array> {
    const inputProps = { card, dur: 2 };
    const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
    await renderStill({ composition, serveUrl, inputProps, output: out, frame: 30, imageFormat: 'png' });
    const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', out, '-vf', 'crop=200:60:840:76', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    return new Uint8Array(buf);
  }
  it('带 mediaLabel 时右上角出现角标（与镜头 B-roll 角标同一位置与样式）；不带时没有', async () => {
    const base: CardSpec = { template: 'hook', props: { index: 1, total: 1, headline: '生成图做底的钩子', highlight: [], image: 'broll/gen.png' } };
    const labeled: CardSpec = { template: 'hook', props: { ...base.props, mediaLabel: { kind: 'ai', text: 'AI 生成' } } } as CardSpec;
    const [a, b] = await withBundle(workDir, async (url) => [await corner(base, url, join(workDir, 'a.png')), await corner(labeled, url, join(workDir, 'b.png'))]);
    const changed = a.reduce((n, v, i) => n + (Math.abs(v - b[i]) > 30 ? 1 : 0), 0);
    expect(changed).toBeGreaterThan(300);
    // 角标的字是浅色（白字压在半透明深底上）
    const bright = Array.from({ length: b.length / 3 }, (_, i) => Math.min(b[i * 3], b[i * 3 + 1], b[i * 3 + 2])).filter((v) => v > 200).length;
    expect(bright).toBeGreaterThan(50);
  }, 180_000);
});
