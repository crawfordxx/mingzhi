// 卡片转场与片色的真实渲染抽帧：对比条 → 流程图（结构不同）擦除中段，边缘两侧分别只有新卡、只有旧卡（文字不叠加）；夜景片色卡片区是深色、客厅片色是暖白
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStill, selectComposition } from '@remotion/renderer';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { withBundle } from '../src/compose/render.js';
import { WIPE_LEAD_SEC, WIPE_SEC, carryStyle, wipeAt } from '../src/compose/card-carry.js';
import { paletteFor } from '../src/compose/palette.js';
import { rgbOfHex } from '../src/compose/color.js';
import type { CardSpec, Shot, TalkProps } from '../src/storyboard/schema.js';

const cfg = loadConfig({});
const workDir = mkdtempSync(join(tmpdir(), 'mz-wipe-render-'));
const W = 1080;
const ZONE_H = 840;

const BARS: CardSpec = { template: 'compareBars', props: { crumb: '剪辑耗时对比', items: [
  { name: '传统剪辑', note: '逐帧剪切', value: 0.9, tone: 'bad', annotation: '2–3 小时' }, { name: 'AI 剪辑', note: '一键处理', value: 0.08, tone: 'good' },
] } };
const FLOW: CardSpec = { template: 'flow', props: { crumb: 'AI 剪辑流程', title: '全自动极速出片', steps: [{ label: '导入原片', note: '一键拖入' }, { label: '自动识别', note: '口误与气口' }, { label: '智能剪切', note: '秒级导出' }] } };
const NIGHT = paletteFor(Array.from({ length: 576 }, (_, i) => rgbOfHex(i % 12 === 0 ? '#E08A3C' : '#1B1D22')));
const LIVING = paletteFor(Array.from({ length: 576 }, (_, i) => rgbOfHex(i % 6 === 0 ? '#E2B27A' : '#8C7A68')));

const base = (shots: Shot[], palette = NIGHT): TalkProps => ({
  person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 4, shots, captions: [], palette,
});
const SHOTS: Shot[] = [{ start: 0, end: 2, layout: 'split', card: BARS }, { start: 2, end: 4, layout: 'split', card: FLOW }];
/** 擦除中段：交界（第 60 帧）后第 5 帧 */
const MID = 65;
const T = (MID / 30 - 2) / WIPE_SEC;

type Img = Uint8Array;
const stills = new Map<string, Img>();

async function zone(file: string): Promise<Img> {
  const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `crop=${W}:${ZONE_H}:0:0,format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** 两张图在列区间 [x0, x1) 里的平均绝对差；b 整体向右平移 dx 像素后再比（a[x] 对 b[x − dx]） */
function diff(a: Img, b: Img, x0: number, x1: number, dx: number): number {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < ZONE_H; y += 2) {
    for (let x = Math.max(x0, dx); x < Math.min(x1, W + dx); x += 2) {
      const i = (y * W + x) * 3;
      const j = (y * W + x - dx) * 3;
      sum += Math.abs(a[i] - b[j]) + Math.abs(a[i + 1] - b[j + 1]) + Math.abs(a[i + 2] - b[j + 2]);
      n += 3;
    }
  }
  return sum / n;
}
const meanLuma = (a: Img): number => {
  let s = 0;
  for (let i = 0; i < a.length; i += 3) s += 0.2126 * a[i] + 0.7152 * a[i + 1] + 0.0722 * a[i + 2];
  return s / (a.length / 3);
};

describe('卡片擦除与片色（真实渲染 1080×1920）', () => {
  beforeAll(async () => {
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x30343A:s=360x640:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, 'person.mp4')]);
    const jobs: [string, TalkProps, number][] = [
      ['mid', base(SHOTS), MID],
      // 只有旧卡：对比条单独占满 0–4 秒，同一时刻
      ['old', base([{ start: 0, end: 4, layout: 'split', card: BARS }]), MID],
      // 只有新卡：流程图单独从 0 秒开始、带同样的时钟提前量，取擦除开始后的同一相对时刻
      ['new', base([{ start: 0, end: 2, layout: 'split', card: FLOW, lead: WIPE_LEAD_SEC }]), MID - 60],
      ['night', base(SHOTS), 45],
      ['living', base(SHOTS, LIVING), 45],
    ];
    await withBundle(workDir, async (serveUrl) => {
      for (const [name, props, frame] of jobs) {
        const composition = await selectComposition({ serveUrl, id: 'Talk', inputProps: props });
        const file = join(workDir, `${name}.png`);
        await renderStill({ composition, serveUrl, inputProps: props, output: file, frame, imageFormat: 'png' });
        stills.set(name, await zone(file));
      }
    });
  }, 600_000);
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it('这一对卡片走擦除，横向', () => {
    expect(carryStyle(SHOTS, 1)).toEqual({ kind: 'wipe', axis: 'x' });
  });

  it('擦除中段：边缘左边只有新卡（与单独渲染的流程图一致），右边只有旧卡（与单独渲染的对比条一致），两张卡的文字不叠加', () => {
    const p = wipeAt(T);
    expect(p).toBeGreaterThan(0.3);
    expect(p).toBeLessThan(0.9);
    const edge = Math.round(p * W);
    const [mid, old, neu] = [stills.get('mid')!, stills.get('old')!, stills.get('new')!];
    // 新卡从左滑入（落后 (1−p)×160px），旧卡被向右推（p×90px）；边缘 ±48px 有强调色细条与光晕，不比
    const newSide = diff(mid, neu, 0, edge - 48, -Math.round((1 - p) * 160));
    const oldSide = diff(mid, old, edge + 48, W, Math.round(p * 90));
    expect(newSide).toBeLessThan(4);
    expect(oldSide).toBeLessThan(4);
    // 对照：同一区域与另一张卡比差得很远（说明上面的一致不是因为两边都是空底）
    expect(diff(mid, old, 0, edge - 48, 0)).toBeGreaterThan(newSide * 3);
    expect(diff(mid, neu, edge + 48, W, 0)).toBeGreaterThan(oldSide * 3);
  });

  it('片色：夜景是深色卡片区、客厅是暖白卡片区', () => {
    expect(meanLuma(stills.get('night')!)).toBeLessThan(60);
    expect(meanLuma(stills.get('living')!)).toBeGreaterThan(190);
  });
});
