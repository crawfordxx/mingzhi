// 新版式真实渲染抽帧：全屏插入铺满无黑边、J-cut 帧号、字幕位置、画中画位置与尺寸（素材全部由 ffmpeg 程序生成）
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { renderTalk } from '../src/compose/render.js';
import { renderSegmented } from '../src/compose/segments.js';
import { PIP } from '../src/compose/layout.js';
import type { Broll, Shot } from '../src/storyboard/schema.js';

type Px = [number, number, number];
const cfg = loadConfig({});
const workDir = mkdtempSync(join(tmpdir(), 'mz-layouts-'));
const output = join(workDir, 'final.mp4');

/** 人像：纯蓝（便于和素材区分）；静图素材：横幅纯红（检验 cover 铺满）；视频素材：1 秒纯绿（短于镜头，检验播完停在末帧不黑屏） */
const PHOTO: Broll = { file: 'broll/red.png', kind: 'photo', focal: { x: 0.7, y: 0.4 } };
const VIDEO: Broll = { file: 'broll/green.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 } };
/** 1 秒色相转一整圈的视频，标明时长：镜头 2 秒时循环 */
const CYCLE: Broll = { file: 'broll/cycle.mp4', kind: 'video', focal: { x: 0.5, y: 0.5 }, durationSec: 1 };
const SHOTS: Shot[] = [
  { start: 0, end: 1, layout: 'full' },
  { start: 1, end: 2.5, layout: 'broll', broll: PHOTO },
  { start: 2.5, end: 4.5, layout: 'pip', broll: VIDEO },
  { start: 4.5, end: 6, layout: 'split', broll: PHOTO, card: { template: 'title', props: { title: '素材铺满上半屏' } } },
  { start: 6, end: 7, layout: 'overlay', card: { template: 'title', props: { title: '浮层卡' } } },
  { start: 7, end: 9, layout: 'broll', broll: CYCLE },
];
const PROPS = {
  person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 9, shots: SHOTS,
  captions: [{ start: 0, end: 7, text: '字幕位置测试' }],
};

/** 第 n 帧里一块区域的 RGB 像素 */
async function pixels(n: number, x: number, y: number, w: number, h: number, file = output): Promise<Px[]> {
  const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),format=rgb24,crop=${w}:${h}:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return Array.from({ length: buf.length / 3 }, (_, i) => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]] as Px);
}
const isRed = ([r, g, b]: Px): boolean => r > 60 && r > 1.6 * Math.max(g, b);
const isBlue = ([r, g, b]: Px): boolean => b > 120 && b > r + 60 && b > g + 30;
const isWhite = ([r, g, b]: Px): boolean => Math.min(r, g, b) > 215;
/** 画中画的底（绿色素材，含投影压暗的部分） */
const isGreen = ([r, g, b]: Px): boolean => g > r + 40 && g > b + 20;
/** 画中画窗口里的像素：不是绿底的就是人像或描边 */
const inWindow = (p: Px): boolean => !isGreen(p);
/** 一行/一列像素里满足条件的最长连续段 [起点, 终点] */
function longestRun(px: Px[], ok: (p: Px) => boolean): [number, number] {
  const best = px.reduce<{ s: number; e: number; cur: number }>((acc, p, i) => {
    if (!ok(p)) return { ...acc, cur: -1 };
    const cur = acc.cur < 0 ? i : acc.cur;
    return i - cur > acc.e - acc.s ? { s: cur, e: i, cur } : { ...acc, cur };
  }, { s: 0, e: -1, cur: -1 });
  return [best.s, best.e];
}

describe('新版式真实渲染（1080×1920）', () => {
  beforeAll(async () => {
    mkdirSync(join(workDir, 'broll'));
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=red:s=640x360:r=30:d=1,hue=H=2*PI*t', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, CYCLE.file)]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1E50DC:s=360x640:r=30:d=9', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=9',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workDir, 'person.mp4')]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xD23C28:s=1600x1000', '-frames:v', '1', join(workDir, PHOTO.file)]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x28B450:s=1280x720:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, VIDEO.file)]);
    await renderTalk({ workDir, output, props: PROPS });
  }, 600_000);

  it('J-cut：全屏插入镜头从第 30 帧开始，第 30、31 帧仍是人像，第 32 帧切到素材', async () => {
    const center = async (n: number): Promise<Px> => (await pixels(n, 540, 700, 1, 1))[0];
    expect(isBlue(await center(29))).toBe(true);
    expect(isBlue(await center(30))).toBe(true);
    expect(isBlue(await center(31))).toBe(true);
    expect(isRed(await center(32))).toBe(true);
  });

  it('全屏插入：横幅静图铺满 1080×1920，四条边都是素材（无黑边、不露人像）', async () => {
    const edges = await Promise.all([pixels(45, 0, 0, 1080, 1), pixels(45, 0, 1919, 1080, 1), pixels(45, 0, 0, 1, 1920), pixels(45, 1079, 0, 1, 1920)]);
    for (const edge of edges) expect(edge.filter((p) => !isRed(p)).length).toBe(0);
  });

  it('字幕位置：全屏插入与画中画在 y≈1400，分屏压在分界线 960 上', async () => {
    const hasText = async (n: number, cy: number): Promise<boolean> => (await pixels(n, 120, cy - 30, 840, 60)).some(isWhite);
    expect(await hasText(45, 1400)).toBe(true);
    expect(await hasText(45, 960)).toBe(false);
    expect(await hasText(105, 1400)).toBe(true);
    expect(await hasText(165, 960)).toBe(true);
    expect(await hasText(165, 1400)).toBe(false);
  });

  it('画中画：过渡结束后人像窗口 360×480，左上角 (600, 810)，窗外是素材', async () => {
    const row = await pixels(105, 0, PIP.y + 240, 1080, 1);
    const col = await pixels(105, PIP.x + 180, 0, 1, 1400);
    const [x0, x1] = longestRun(row, inWindow);
    const [y0, y1] = longestRun(col, inWindow);
    expect(Math.abs(x0 - 600)).toBeLessThanOrEqual(3);
    expect(Math.abs(x1 - x0 + 1 - 360)).toBeLessThanOrEqual(4);
    expect(Math.abs(y0 - 810)).toBeLessThanOrEqual(3);
    expect(Math.abs(y1 - y0 + 1 - 480)).toBeLessThanOrEqual(4);
    expect(isGreen(row[300]) && isGreen(row[1000])).toBe(true);
    expect(isBlue(row[PIP.x + 180])).toBe(true);
  });

  it('画中画的视频素材短于镜头：播完后停在末帧，不黑屏', async () => {
    const [px] = await pixels(130, 200, 400, 1, 1);
    expect(isGreen(px) && px[1] > 100).toBe(true);
  });

  it('分屏升级：上半屏是素材（不是米色底），下半屏是人像', async () => {
    expect(isRed((await pixels(165, 540, 120, 1, 1))[0])).toBe(true);
    expect(isBlue((await pixels(165, 540, 1700, 1, 1))[0])).toBe(true);
  });

  it('画中画退出：人像从小窗放大回去的 0.4 秒里仍以画中画素材垫底，下半屏不露米色底', async () => {
    // 米色底 #EFEBE5（叠颗粒暗角后略暗）：暖中性浅色；白描边是纯中性，不算
    const beige = ([r, g, b]: Px): boolean => r > 175 && g > 170 && b > 160 && r - b >= 3 && r - b <= 25 && g - b >= 0;
    for (let n = 135; n <= 147; n++) {
      const rows = [...await pixels(n, 0, 1000, 1080, 1), ...await pixels(n, 0, 1500, 1080, 1), ...await pixels(n, 0, 1880, 1080, 1)];
      expect(rows.filter(beige).length, `第 ${n} 帧`).toBeLessThan(30);
    }
  });

  it('视频素材标了时长且短于镜头：循环播放（与卡片视频底同一策略）', async () => {
    const avg = async (n: number): Promise<number[]> => {
      const px = await pixels(n, 520, 280, 8, 8);
      return [0, 1, 2].map((c) => px.reduce((sum, p) => sum + p[c], 0) / px.length);
    };
    const gap = (a: number[], b: number[]): number => Math.max(...a.map((v, i) => Math.abs(v - b[i])));
    // 第 9 镜头画面从第 212 帧（7 秒 + J-cut 2 帧）开始：第 215 与 245 帧都在素材 0.1 秒处，第 230 帧在 0.6 秒处
    const [a, mid, b] = [await avg(215), await avg(230), await avg(245)];
    expect(gap(a, b)).toBeLessThanOrEqual(14);
    expect(gap(a, mid)).toBeGreaterThan(60);
  });

  it('分段渲染与整条渲染在 J-cut、画中画退出与镜头边界上逐帧一致', async () => {
    const seg = join(workDir, 'segmented.mp4');
    await renderSegmented({ workDir, cacheDir: join(workDir, 'seg-cache'), output: seg, ffmpeg: cfg.ffmpeg, props: PROPS });
    const small = (file: string, n: number): Promise<Buffer> => runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=54:96`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
    const meanDiff = (x: Buffer, y: Buffer): number => x.reduce((sum, v, i) => sum + Math.abs(v - y[i]), 0) / x.length;
    for (const n of [29, 30, 31, 32, 33, 74, 75, 134, 135, 136, 137, 179, 180, 209, 210, 211, 212, 213]) {
      expect(meanDiff(await small(seg, n), await small(output, n)), `第 ${n} 帧`).toBeLessThan(0.6);
    }
  }, 600_000);
});
