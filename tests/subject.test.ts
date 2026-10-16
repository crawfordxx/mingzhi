import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError } from '../src/cancel.js';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { personTransform } from '../src/compose/layout.js';
import { detectSubject, lowResSize, sampleCount, subjectFromAlphas } from '../src/matting/subject.js';
import { subjectStage } from '../src/pipeline/subject-step.js';
import type { SubjectBox } from '../src/matting/composite.js';
import { hasRvm } from './helpers/models.js';

/** 合成人形 alpha：头（圆近似为方块）+ 躯干，top 为头顶行占比 */
function humanAlpha(w: number, h: number, top: number, shift = 0): Float32Array {
  const pha = new Float32Array(w * h);
  const fill = (x0: number, x1: number, y0: number, y1: number): void => {
    for (let y = Math.floor(y0 * h); y < Math.ceil(y1 * h); y += 1) for (let x = Math.floor(x0 * w); x < Math.ceil(x1 * w); x += 1) pha[y * w + x] = 1;
  };
  fill(0.4 + shift, 0.6 + shift, top, top + 0.15); // 头
  fill(0.25 + shift, 0.75 + shift, top + 0.15, 1); // 肩与躯干，一直到画面底
  return pha;
}

describe('sampleCount / lowResSize', () => {
  it('抽样帧数在 6–10 之间，随时长增加', () => {
    expect(sampleCount(2)).toBe(6);
    expect(sampleCount(15)).toBeGreaterThanOrEqual(6);
    expect(sampleCount(15)).toBeLessThanOrEqual(10);
    expect(sampleCount(600)).toBe(10);
  });
  it('低分辨率：长边缩到 320，保持比例，取偶数；小视频不放大', () => {
    expect(lowResSize(720, 1280)).toEqual({ width: 180, height: 320 });
    expect(lowResSize(1280, 720)).toEqual({ width: 320, height: 180 });
    expect(lowResSize(160, 90)).toEqual({ width: 160, height: 90 });
  });
});

describe('subjectFromAlphas', () => {
  it('多帧 alpha 逐边取中位数，抗个别帧抖动', () => {
    const w = 100, h = 200;
    const box = subjectFromAlphas([humanAlpha(w, h, 0.2), humanAlpha(w, h, 0.2), humanAlpha(w, h, 0.5)], w, h);
    expect(box?.top).toBeCloseTo(0.2, 2);
    expect(box?.bottom).toBeCloseTo(1, 2);
    expect(box?.left).toBeCloseTo(0.25, 2);
    expect(box?.right).toBeCloseTo(0.75, 2);
  });
  it('画面里没人（alpha 全 0）返回 null', () => {
    expect(subjectFromAlphas([new Float32Array(100 * 200), new Float32Array(100 * 200)], 100, 200)).toBeNull();
    expect(subjectFromAlphas([], 100, 200)).toBeNull();
  });
  it('只有部分帧有人时用有人的帧', () => {
    const w = 100, h = 200;
    const box = subjectFromAlphas([new Float32Array(w * h), humanAlpha(w, h, 0.3)], w, h);
    expect(box?.top).toBeCloseTo(0.3, 2);
  });
  it('与 personTransform 集成：分屏头顶落在分界线下 60px；没人时居中而不是压到底边', () => {
    const w = 100, h = 200;
    const box = subjectFromAlphas([humanAlpha(w, h, 0.3)], w, h) as SubjectBox;
    const t = personTransform('split', box, 720, 1280);
    expect(t.y + 0.3 * 1280 * t.scale).toBeCloseTo(960 + 60, 0);
    const none = personTransform('split', subjectFromAlphas([new Float32Array(w * h)], w, h), 720, 1280);
    expect(none.y).toBe(480);
  });
});

describe('subjectStage', () => {
  const record = () => {
    const events: { step: string; message: string; patch: unknown }[] = [];
    const complete = ((step: string, message: string, patch: unknown) => { events.push({ step, message, patch }); return {}; }) as never;
    return { events, complete };
  };
  const box: SubjectBox = { top: 0.2, bottom: 1, left: 0.2, right: 0.8 };
  it('求到框：写进 subject 并在消息里带用时', async () => {
    const { events, complete } = record();
    const out = await subjectStage({ cfg: loadConfig({}), media: { subject: async () => box } as never }, 'cut.mp4', complete);
    expect(out).toEqual(box);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ step: 'matte', patch: { subject: box } });
    expect(events[0].message).toMatch(/人物取景完成.*秒/);
  });
  it('画面里没人：subject 为 null，消息写明分屏按居中', async () => {
    const { events, complete } = record();
    expect(await subjectStage({ cfg: loadConfig({}), media: { subject: async () => null } as never }, 'cut.mp4', complete)).toBeNull();
    expect(events[0].patch).toMatchObject({ subject: null });
    expect(events[0].message).toMatch(/居中/);
  });
  it('检测失败：不中断流程，subject 为 null，消息带原因', async () => {
    const { events, complete } = record();
    const media = { subject: async () => { throw new Error('缺少抠像模型'); } } as never;
    expect(await subjectStage({ cfg: loadConfig({}), media }, 'cut.mp4', complete)).toBeNull();
    expect(events[0].message).toMatch(/缺少抠像模型.*居中/);
  });
  it('已取消：取消错误继续抛出', async () => {
    const { complete } = record();
    const media = { subject: async () => { throw new CancelledError(); } } as never;
    await expect(subjectStage({ cfg: loadConfig({}), media }, 'cut.mp4', complete)).rejects.toThrow('已取消');
  });
});

const PORTRAIT = '/private/tmp/claude-501/-Users-crawford-workspace-mingzhi/33f03909-6312-4bc7-87c5-6cf211a66a30/scratchpad/mock/portrait.mp4';

describe.skipIf(!hasRvm())('detectSubject（需要 RVM 模型）', () => {
  it('纯灰画面：没有人，返回 null', async () => {
    const cfg = loadConfig({});
    const input = join(mkdtempSync(join(tmpdir(), 'mz-subj-')), 'gray.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=360x640:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    expect(await detectSubject(input, cfg)).toBeNull();
  });
  it('视频文件不存在：抛出带原因的错误', async () => {
    await expect(detectSubject('/nonexistent/x.mp4', loadConfig({}))).rejects.toThrow();
  });
  it.skipIf(!existsSync(PORTRAIT))('竖屏 mock（保留原背景）：求出人物框，头顶在画面上部、人物到画面底', async () => {
    const started = Date.now();
    const box = await detectSubject(PORTRAIT, loadConfig({}));
    const secs = (Date.now() - started) / 1000;
    console.log(`detectSubject portrait: ${secs.toFixed(2)}s`, JSON.stringify(box));
    expect(box).not.toBeNull();
    expect(box!.top).toBeGreaterThan(0.02);
    expect(box!.top).toBeLessThan(0.5);
    expect(box!.bottom).toBeGreaterThan(0.8);
    expect(secs).toBeLessThan(15);
  }, 60_000);
});
