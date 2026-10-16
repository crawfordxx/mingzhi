// 分镜呈现真实渲染抽帧：钩子第 0 帧完整、第 0/15/45/90 帧非空、相邻卡交叉过渡无空白帧、reveal 逐条出现、卡片撑满后空白率 ≤ 35%
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStill, selectComposition } from '@remotion/renderer';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { withBundle } from '../src/compose/render.js';
import { THEME } from '../render/theme.js';
import type { Shot, TalkProps } from '../src/storyboard/schema.js';

type Px = [number, number, number];
const cfg = loadConfig({});
const workDir = mkdtempSync(join(tmpdir(), 'mz-sb-render-'));
/** 卡片区：分界线上方、字幕带以上（审片报告的度量也只看 y < 840） */
const ZONE_H = 840;

const SHOTS: Shot[] = [
  { start: 0, end: 2.5, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: 'FDE 这个岗位现在看来基本定性了', highlight: ['基本定性'], source: '一线落地团队观察' } } },
  { start: 2.5, end: 5.5, layout: 'split', card: { template: 'evidenceList', props: { title: '传统驻场的三个特征', rows: [
    { badge: '成本', text: '需求清单写进合同' }, { badge: '收益', text: '目标明确好验收' }, { badge: '证据', text: '改动只允许 3 到 5 次' },
  ], reveal: [0, 1.2, 2.2] } } },
  { start: 5.5, end: 8, layout: 'split', card: { template: 'title', props: { crumb: '工作方式', title: 'FDE 和客户一起定义问题' } } },
  { start: 8, end: 9.5, layout: 'full' },
  { start: 9.5, end: 12, layout: 'split', card: { template: 'title', props: { crumb: '从人物全屏切进来', title: '内容第一帧就在' } } },
];
const PROPS: TalkProps = {
  person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 12, shots: SHOTS,
  captions: [{ start: 0, end: 12, text: '抽帧测试' }],
};
/** 要抽的帧：第 0/15/45/90 帧；两处镜头交界前后各帧；reveal 三个时刻 */
const BOUNDARIES = [75, 165];
/** 交界后检查多少帧：固定 0.4 秒（覆盖 0.3 秒交叉过渡；与过渡时长常量无关，过渡被关掉时测试要能失败） */
const CHECK_FRAMES = 12;
/** 人物全屏 → 分屏的交界（9.5 秒 = 第 285 帧）后 0.1 秒 */
const FRESH = 288;
const FRAMES = [...new Set([0, 15, 45, 90, 130, 160, 200, FRESH, ...BOUNDARIES.flatMap((b) => Array.from({ length: CHECK_FRAMES + 3 }, (_, k) => b - 2 + k))])];
const zones = new Map<number, Px[]>();

/** 一张 PNG 的卡片区像素（rgb24） */
async function zonePixels(file: string): Promise<Px[]> {
  const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `crop=1080:${ZONE_H}:0:0,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return Array.from({ length: buf.length / 3 }, (_, i) => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]] as Px);
}
const hex = (h: string): Px => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as Px;
const near = (c: Px, tol: number) => (p: Px): boolean => Math.abs(p[0] - c[0]) <= tol && Math.abs(p[1] - c[1]) <= tol && Math.abs(p[2] - c[2]) <= tol;
const STAGE = hex(THEME.stage);
const frac = (px: Px[], ok: (p: Px) => boolean): number => px.filter(ok).length / px.length;
/** 空白率：卡片区里露出米色底的比例 */
const blank = (n: number): number => frac(zones.get(n) ?? [], near(STAGE, 6));
const count = (n: number, color: string): number => (zones.get(n) ?? []).filter(near(hex(color), 10)).length;

describe('分镜呈现真实渲染（1080×1920 抽帧）', () => {
  beforeAll(async () => {
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x1E50DC:s=360x640:r=30:d=12', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, 'person.mp4')]);
    await withBundle(workDir, async (serveUrl) => {
      const composition = await selectComposition({ serveUrl, id: 'Talk', inputProps: PROPS });
      for (const frame of FRAMES) {
        const file = join(workDir, `f${frame}.png`);
        await renderStill({ composition, serveUrl, inputProps: PROPS, output: file, frame, imageFormat: 'png' });
        zones.set(frame, await zonePixels(file));
      }
    });
  }, 600_000);
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it('钩子第 0 帧：没有素材也有图形主体（荧光几何），标题与来源标签已完整显示（白字够多），不是纯黑', () => {
    const px = zones.get(0) ?? [];
    const white = frac(px, (p) => Math.min(...p) > 225);
    const lime = frac(px, (p) => p[1] > 150 && p[0] > 120 && p[2] < 110);
    expect(white).toBeGreaterThan(0.02);
    expect(lime).toBeGreaterThan(0.002);
    expect(frac(px, (p) => Math.max(...p) < 24)).toBeLessThan(0.9);
    // 第 0 帧与第 15 帧的白字量接近：入场从已有内容开始，不是从空白长出来
    const white15 = frac(zones.get(15) ?? [], (p) => Math.min(...p) > 225);
    expect(white).toBeGreaterThan(white15 * 0.8);
  });

  it('第 0、15、45、90 帧都不是空白：米色底 ≤ 35%', () => {
    for (const n of [0, 15, 45, 90]) expect(blank(n)).toBeLessThanOrEqual(0.35);
  });

  it('相邻卡片交叉过渡：交界前后每一帧上半屏都不空（米色底 ≤ 50%），过渡结束后卡片撑满（≤ 35%）', () => {
    for (const b of BOUNDARIES) {
      for (let k = -2; k <= CHECK_FRAMES; k++) expect(blank(b + k)).toBeLessThanOrEqual(0.5);
      expect(blank(b + CHECK_FRAMES)).toBeLessThanOrEqual(0.35);
    }
    expect(blank(200)).toBeLessThanOrEqual(0.35);
  });

  it('交叉过渡确实重叠：交界后第 2 帧仍有上一张钩子的荧光色，第 4 帧新白卡已大片进场（亮区）', () => {
    const lime = (p: Px): boolean => p[1] > 150 && p[0] > 120 && p[2] < 110;
    expect(frac(zones.get(BOUNDARIES[0] + 2) ?? [], lime)).toBeGreaterThan(0.0005);
    expect(frac(zones.get(BOUNDARIES[0] + 4) ?? [], (p) => (p[0] + p[1] + p[2]) / 3 > 150)).toBeGreaterThan(0.2);
  });

  it('人物全屏切进分屏：交界后 0.1 秒卡片区已有标题文字（不是只有一张空白卡），也没有大片米色', () => {
    const ink = frac(zones.get(FRESH) ?? [], (p) => Math.max(...p) < 80);
    expect(ink).toBeGreaterThan(0.01);
    expect(blank(FRESH)).toBeLessThanOrEqual(0.5);
  });

  it('reveal：证据清单按秒点逐条出现（镜头内 0.5 秒只有第 1 行，1.8 秒有第 2 行，2.8 秒三行都在）', () => {
    const [cost, gain, proof] = [THEME.badge['成本'], THEME.badge['收益'], THEME.badge['证据']];
    const MIN = 400;
    expect(count(90, cost)).toBeGreaterThan(MIN);
    expect(count(90, gain)).toBeLessThan(MIN / 4);
    expect(count(90, proof)).toBeLessThan(MIN / 4);
    expect(count(130, gain)).toBeGreaterThan(MIN);
    expect(count(130, proof)).toBeLessThan(MIN / 4);
    expect(count(160, proof)).toBeGreaterThan(MIN);
  });
});
