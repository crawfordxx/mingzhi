import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { GRAIN_STRENGTH } from '../render/layers/grain-field.js';
import { renderGrainStills } from './fixtures/grain/render.js';

const cfg = loadConfig({});
const W = 1080;
const H = 1920;
/** 肤色平底（R,G,B 差得最多的一类颜色：旧颗粒在这里最容易出彩色麻点） */
const SKIN = '0xc89878';

let dir: string;
let pub: string;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'mz-grain-'));
  pub = join(dir, 'pub');
  mkdirSync(pub);
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=${SKIN}:s=${W}x${H}`, '-frames:v', '1', join(pub, 'skin.png')]);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const rgb = (file: string): Promise<Buffer> => runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);

/** 矩形内某通道的均值与标准差 */
function stat(buf: Buffer, rect: { x: number; y: number; w: number; h: number }, pick: (r: number, g: number, b: number) => number): { mean: number; std: number } {
  let sum = 0, sq = 0, n = 0;
  for (let y = rect.y; y < rect.y + rect.h; y += 1) {
    for (let x = rect.x; x < rect.x + rect.w; x += 1) {
      const i = (y * W + x) * 3;
      const v = pick(buf[i], buf[i + 1], buf[i + 2]);
      sum += v; sq += v * v; n += 1;
    }
  }
  const mean = sum / n;
  return { mean, std: Math.sqrt(Math.max(0, sq / n - mean * mean)) };
}
const Y = (r: number, g: number, b: number): number => 0.299 * r + 0.587 * g + 0.114 * b;
const CB = (r: number, g: number, b: number): number => -0.1687 * r - 0.3313 * g + 0.5 * b;
const CR = (r: number, g: number, b: number): number => 0.5 * r - 0.4187 * g - 0.0813 * b;
const CENTER = { x: 440, y: 860, w: 200, h: 200 };

describe('颗粒层独立渲染（Remotion + Chromium）', () => {
  it('肤色平底上：尺寸不变、渲染可复现、颗粒只改亮度（三通道同步起伏、色度几乎不动）、强度约 1%、平均亮度不变', async () => {
    const stills = await renderGrainStills(dir, [5, 5, 6], { publicDir: pub, file: 'skin.png' });
    const [a, b, c] = stills.map((f) => readFileSync(f));
    expect(a.equals(b)).toBe(true);
    expect(a.equals(c)).toBe(false);
    const px = await rgb(stills[0]);
    expect(px.length).toBe(W * H * 3);
    const chans = [(r: number) => r, (_r: number, g: number) => g, (_r: number, _g: number, b: number) => b].map((f) => stat(px, CENTER, f));
    // 三个通道的波动一样大（加的是同一个数）
    expect(chans[0].std / chans[2].std).toBeGreaterThan(0.9);
    expect(chans[0].std / chans[2].std).toBeLessThan(1.1);
    const y = stat(px, CENTER, Y);
    const cb = stat(px, CENTER, CB);
    const cr = stat(px, CENTER, CR);
    expect(y.std / 255).toBeGreaterThan(GRAIN_STRENGTH * 0.7);
    expect(y.std / 255).toBeLessThan(GRAIN_STRENGTH * 1.3);
    expect(cb.std).toBeLessThan(y.std * 0.25);
    expect(cr.std).toBeLessThan(y.std * 0.25);
    // 对照：同一底图不加颗粒（strength 0，只剩暗角）；中心平均亮度差 ≤ 2.5 灰阶（亮部略压 1–2 灰阶是把噪声平均抬升抵消到中灰的代价）
    const [plainFile] = await renderGrainStills(dir, [5], { publicDir: pub, file: 'skin.png' }, { strength: 0 });
    const plain = stat(await rgb(plainFile), CENTER, Y);
    expect(plain.std).toBeLessThan(0.5);
    expect(Math.abs(y.mean - plain.mean)).toBeLessThan(2.5);
  }, 300_000);

  it('人物区域：区域内颗粒降到约 1/3，区域外不变', async () => {
    const region = { x: 340, y: 760, w: 400, h: 400 };
    const [file] = await renderGrainStills(dir, [8], { publicDir: pub, file: 'skin.png' }, { region });
    const px = await rgb(file);
    const inside = stat(px, { x: 480, y: 900, w: 120, h: 120 }, Y);
    const outside = stat(px, { x: 100, y: 300, w: 200, h: 200 }, Y);
    expect(inside.std / outside.std).toBeGreaterThan(0.22);
    expect(inside.std / outside.std).toBeLessThan(0.5);
  }, 300_000);

  it('暗角：四角比中心暗', async () => {
    const [file] = await renderGrainStills(dir, [3], { publicDir: pub, file: 'skin.png' });
    const px = await rgb(file);
    const corner = stat(px, { x: 0, y: 0, w: 40, h: 40 }, Y).mean;
    expect(corner).toBeLessThan(stat(px, CENTER, Y).mean * 0.92);
  }, 300_000);
});
