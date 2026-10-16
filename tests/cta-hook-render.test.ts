// CTA 放到口播内容之后与开头钩子文字的真实渲染抽帧：钩子文字第 0 帧就在；CTA 在人像定格之后继续动（点击翻色）
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStill, selectComposition } from '@remotion/renderer';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { withBundle } from '../src/compose/render.js';
import type { Shot, TalkProps } from '../src/storyboard/schema.js';

type Px = [number, number, number];
const cfg = loadConfig({});
const workDir = mkdtempSync(join(tmpdir(), 'mz-cta-hook-'));
const CONTENT_SEC = 10;
const FPS = 30;
const broll = (hook?: string): Shot => ({ start: 0, end: 3, layout: 'broll', broll: { file: 'broll/a.jpg', kind: 'photo', focal: { x: 0.5, y: 0.5 }, ...(hook ? { hook } : {}) } });
const rest: Shot[] = [
  { start: 3, end: 9.5, layout: 'full' },
  { start: 9.5, end: 12, layout: 'full', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'], placed: true } } },
];
const base: Omit<TalkProps, 'shots'> = {
  person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 12.5, contentSec: CONTENT_SEC,
  captions: [{ start: 0, end: 9, text: '抽帧测试' }],
};
/** 取画布上某个矩形的像素 */
async function rect(file: string, y0: number, h: number): Promise<Px[]> {
  const buf = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `crop=1080:${h}:0:${y0},format=rgb24`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return Array.from({ length: buf.length / 3 }, (_, i) => [buf[i * 3], buf[i * 3 + 1], buf[i * 3 + 2]] as Px);
}
const count = (px: Px[], ok: (p: Px) => boolean): number => px.filter(ok).length;
const white = (p: Px): boolean => Math.min(...p) > 238;
const red = (p: Px): boolean => p[0] > 200 && p[1] < 90 && p[2] < 110;

async function still(serveUrl: string, props: TalkProps, frame: number, name: string): Promise<string> {
  const composition = await selectComposition({ serveUrl, id: 'Talk', inputProps: props });
  const output = join(workDir, `${name}.png`);
  await renderStill({ composition, serveUrl, inputProps: props, output, frame, imageFormat: 'png' });
  return output;
}

describe('开头钩子文字与 CTA 在口播内容之后（真实渲染）', () => {
  const out: Record<string, Px[]> = {};
  beforeAll(async () => {
    mkdirSync(join(workDir, 'broll'), { recursive: true });
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x20283A:s=1080x1920:r=1:d=1', '-frames:v', '1', join(workDir, 'broll', 'a.jpg')]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=0x1E50DC:s=360x640:r=30:d=${CONTENT_SEC}`, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', join(workDir, 'person.mp4')]);
    await withBundle(workDir, async (serveUrl) => {
      const withHook: TalkProps = { ...base, shots: [broll('怎么用 AI 剪口播'), ...rest] };
      const noHook: TalkProps = { ...base, shots: [broll(), ...rest] };
      out.hook0 = await rect(await still(serveUrl, withHook, 0, 'hook0'), 400, 400);
      out.hook60 = await rect(await still(serveUrl, withHook, 60, 'hook60'), 400, 400);
      out.none0 = await rect(await still(serveUrl, noHook, 0, 'none0'), 400, 400);
      // CTA：口播内容结束（10 秒）之后，镜头 9.5–12：10.3 秒时第一个胶囊刚点完，11.8 秒时三个都翻成彩色
      out.cta103 = await rect(await still(serveUrl, noHook, Math.round(10.3 * FPS), 'cta103'), 200, 160);
      out.cta118 = await rect(await still(serveUrl, noHook, Math.round(11.8 * FPS), 'cta118'), 200, 160);
      out.cta125 = await rect(await still(serveUrl, noHook, Math.round(12.4 * FPS), 'cta125'), 200, 160);
    });
  }, 600_000);
  afterAll(() => rmSync(workDir, { recursive: true, force: true }));

  it('开头全屏素材带钩子文字：第 0 帧文字就完整可见（白字像素远多于没有钩子文字时）；1 秒后仍在', () => {
    const withText = count(out.hook0, white);
    expect(withText).toBeGreaterThan(count(out.none0, white) + 4000);
    expect(count(out.hook60, white)).toBeGreaterThan(withText * 0.8);
  });
  it('CTA 在口播内容结束后继续动：10.3 秒只翻了前面的胶囊，11.8 秒三个都翻成彩色（红色最多）（人像此时已定格）', () => {
    expect(count(out.cta103, red)).toBeLessThan(count(out.cta118, red));
    expect(count(out.cta118, red)).toBeGreaterThan(1500);
  });
  it('镜头结束后（12.4 秒）画面定格在 CTA 末帧，不消失', () => {
    expect(count(out.cta125, red)).toBeGreaterThan(1500);
  });
});
