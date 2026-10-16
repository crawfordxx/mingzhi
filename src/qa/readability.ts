/**
 * 铺图卡片的文字可读性：分屏里素材做底、卡片排在图上时，文字压在照片（或透出照片的玻璃卡）上，对比度可能不够。
 * 做法：同一个镜头、同一时刻渲染两张静帧（一张正常，一张把所有文字设成透明），逐像素比较——两张不同的像素就是文字，
 * 正常帧里是文字颜色，隐去文字那张里是它背后的底色；按 WCAG 相对亮度算对比度
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderStill, selectComposition } from '@remotion/renderer';
import { throwIfCancelled } from '../cancel.js';
import { browserOptions } from '../compose/browser.js';
import { withBundle } from '../compose/render.js';
import { runBuffer } from '../media/exec.js';
import { CANVAS, type Broll, type Shot, type Storyboard } from '../storyboard/schema.js';
import type { Palette } from '../compose/palette.js';

export const MIN_CONTRAST = 4.5;
/** 对底图的一次处理：铺图变体、整体压暗量、文字挪到上方（都只加不减，逐级叠加） */
export type BrollTweak = Pick<Broll, 'legible' | 'shade' | 'textTop'>;
/** 台阶：先铺图变体，再整体压暗加深（由浅到深），再换文字位置（挪到上方，同时压暗）；都不够才撤图（局部重做的最后一步） */
export const LEGIBLE_LADDER: readonly BrollTweak[] = [
  { legible: true },
  { legible: true, shade: 0.25 },
  { legible: true, shade: 0.45 },
  { legible: true, shade: 0.45, textTop: true },
  { legible: true, shade: 0.65, textTop: true },
];

/** 当前镜头还没用过的台阶：已经在用的变体、已经压到这个程度的不重复试 */
export function ladderSteps(broll: Broll): BrollTweak[] {
  return LEGIBLE_LADDER.filter((t) => (t.shade ?? 0) > (broll.shade ?? 0) || (t.textTop === true && broll.textTop !== true) || (t.legible === true && broll.legible !== true));
}

/**
 * polarity：文字比底亮（light）还是比底暗（dark）；legible：不达标时换成铺图变体后量到的对比度；
 * fix：台阶里第一个达标的处理（连同它的对比度）；ladderBest：整个台阶试完都不达标时量到的最高对比度
 */
export interface ShotContrast { shotIndex: number; contrast: number; polarity: 'light' | 'dark'; legible?: number; fix?: { tweak: BrollTweak; contrast: number }; ladderBest?: number }

/** 两张图同一像素三个通道的差之和超过它才算文字像素（排除编码噪声） */
const TEXT_DIFF = 40;
const TILE = 24;
/** 一个小块里文字像素少于它不计（零星抗锯齿边） */
const MIN_TEXT_PX = 8;
/** 小块对比度取块内第 90 百分位（字芯；抗锯齿的边缘对比度偏低） */
const TILE_PCT = 0.9;
/** 整张取小块对比度的第 2 低值：小字（如钩子的序号胶囊）也会跨 2 个以上小块，单个异常块不至于误判 */
const WORST_RANK = 1;
/** 取样时刻：镜头结束前这么多秒（演进条目都已出现，卡片还没开始退场） */
const SAMPLE_BEFORE_END_SEC = 0.4;

const lin = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const LIN = Array.from({ length: 256 }, (_, c) => lin(c));
const lum = (px: Uint8Array, i: number): number => 0.2126 * LIN[px[i]] + 0.7152 * LIN[px[i + 1]] + 0.0722 * LIN[px[i + 2]];
const pctOf = (xs: number[], p: number): number => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(p * xs.length))];

/** 一个小块里文字像素的对比度（块内第 90 百分位）与极性；文字像素太少返回 undefined */
function tileContrast(withText: Uint8Array, noText: Uint8Array, width: number, height: number, tx: number, ty: number): { c: number; light: boolean } | undefined {
  const cs: number[] = [];
  let lighter = 0;
  for (let y = ty; y < Math.min(height, ty + TILE); y++) {
    for (let x = tx; x < Math.min(width, tx + TILE); x++) {
      const i = (y * width + x) * 3;
      const d = Math.abs(withText[i] - noText[i]) + Math.abs(withText[i + 1] - noText[i + 1]) + Math.abs(withText[i + 2] - noText[i + 2]);
      if (d <= TEXT_DIFF) continue;
      const [la, lb] = [lum(withText, i), lum(noText, i)];
      cs.push((Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05));
      if (la > lb) lighter += 1;
    }
  }
  return cs.length < MIN_TEXT_PX ? undefined : { c: pctOf(cs, TILE_PCT), light: lighter * 2 > cs.length };
}

/** 两张同尺寸 RGB 图（显示文字 / 隐去文字）→ 文字对比度与极性；两张没有差别（没有文字）返回 null */
export function textContrast(withText: Uint8Array, noText: Uint8Array, width: number, height: number): { contrast: number; polarity: 'light' | 'dark' } | null {
  const tiles: { c: number; light: boolean }[] = [];
  for (let ty = 0; ty < height; ty += TILE) for (let tx = 0; tx < width; tx += TILE) {
    const t = tileContrast(withText, noText, width, height, tx, ty);
    if (t) tiles.push(t);
  }
  if (tiles.length === 0) return null;
  const sorted = tiles.map((t) => t.c).sort((a, b) => a - b);
  const contrast = sorted[Math.min(sorted.length - 1, WORST_RANK)];
  // 极性按最难读的那一批块投票
  const worst = tiles.filter((t) => t.c <= contrast + 1e-9);
  const light = worst.filter((t) => t.light).length * 2 > worst.length;
  return { contrast: Math.round(contrast * 100) / 100, polarity: light ? 'light' : 'dark' };
}

/** 要查的镜头：分屏、带卡片、素材铺在卡片底下 */
export const backedCards = (storyboard: Storyboard): number[] =>
  storyboard.shots.flatMap((s, i) => (s.layout === 'split' && s.card && s.broll ? [i] : []));

async function stillRgb(ffmpeg: string, png: string): Promise<Uint8Array> {
  const buf = await runBuffer(ffmpeg, ['-v', 'error', '-i', png, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
}

/** 渲染一个镜头的卡片区（1080×960）在 sec 时刻的静帧；hideText 时所有文字透明；按这条片的片色画（暗色片是深色玻璃卡） */
async function renderShot(serveUrl: string, shot: Shot, hideText: boolean, output: string, palette?: Palette): Promise<void> {
  const dur = shot.end - shot.start;
  const inputProps = { card: shot.card, dur, shot, hideText, ...(palette ? { palette } : {}) };
  const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'CardStill', inputProps });
  const frame = Math.max(0, Math.min(Math.round(dur * CANVAS.fps) - 1, Math.round((dur - SAMPLE_BEFORE_END_SEC) * CANVAS.fps)));
  await renderStill({ ...browserOptions(), composition, serveUrl, inputProps, output, frame, imageFormat: 'png' });
}

interface Env { serveUrl: string; tmp: string; ffmpeg: string; palette?: Palette }

/** 一个镜头的文字对比度（两张静帧相减）；没有文字返回 null */
async function contrastOf(env: Env, shot: Shot, name: string): Promise<{ contrast: number; polarity: 'light' | 'dark' } | null> {
  const [a, b] = [join(env.tmp, `${name}-a.png`), join(env.tmp, `${name}-b.png`)];
  await renderShot(env.serveUrl, shot, false, a, env.palette);
  await renderShot(env.serveUrl, shot, true, b, env.palette);
  return textContrast(await stillRgb(env.ffmpeg, a), await stillRgb(env.ffmpeg, b), CANVAS.width, CANVAS.seam);
}

/**
 * 一个铺图卡片：量对比度；不达标时沿台阶逐级试（铺图变体 → 压暗加深 → 换文字位置），第一个达标的台阶写进 fix。
 * 深色字压在不透明玻璃卡上时压暗与换位置都没有用，量到深色极性就不再往下试
 */
async function measureShot(env: Env, shot: Shot, i: number): Promise<ShotContrast | null> {
  const r = await contrastOf(env, shot, `${i}`);
  if (!r) return null;
  const base: ShotContrast = { shotIndex: i, ...r };
  if (r.contrast >= MIN_CONTRAST || !shot.broll) return base;
  let best = 0;
  let first: number | undefined;
  for (const [k, tweak] of ladderSteps(shot.broll).entries()) {
    const v = await contrastOf(env, { ...shot, broll: { ...shot.broll, ...tweak } }, `${i}-${k}`);
    if (!v) break;
    if (k === 0 && tweak.legible && !shot.broll.legible) first = v.contrast;
    if (v.contrast >= MIN_CONTRAST) return { ...base, ...(first !== undefined ? { legible: first } : {}), fix: { tweak, contrast: v.contrast } };
    best = Math.max(best, v.contrast);
    if (v.polarity === 'dark') break;
  }
  return { ...base, ...(first !== undefined ? { legible: first } : {}), ladderBest: best };
}

/** 逐个铺图卡片渲染静帧并量对比度（一次打包）；workDir 是素材所在的工作目录（打包的 publicDir） */
export async function measureReadability(o: { workDir: string; storyboard: Storyboard; ffmpeg: string; signal?: AbortSignal }): Promise<ShotContrast[]> {
  const targets = backedCards(o.storyboard);
  if (targets.length === 0) return [];
  const tmp = mkdtempSync(join(tmpdir(), 'mz-read-'));
  try {
    return await withBundle(o.workDir, async (serveUrl) => {
      const out: ShotContrast[] = [];
      for (const i of targets) {
        throwIfCancelled(o.signal);
        const r = await measureShot({ serveUrl, tmp, ffmpeg: o.ffmpeg, palette: o.storyboard.palette }, o.storyboard.shots[i], i);
        if (r) out.push(r);
      }
      return out;
    });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
