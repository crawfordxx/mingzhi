// 字幕带守卫：每个模板按字段上限渲染静帧，卡片区底部的字幕带（y ≥ 875）里不能出现卡片内容。
// 需要本机已有 Remotion 的 Chrome Headless Shell（不会触发下载）；离线或想跳过时设 MINGZHI_SKIP_RENDER_TESTS=1
import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureBrowser, renderStill, selectComposition } from '@remotion/renderer';
import { withBundle } from '../src/compose/render.js';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { CANVAS, CardSpecSchema, type CardSpec } from '../src/storyboard/schema.js';
import { THEME } from '../render/theme.js';
import { hookKeyword } from '../render/templates/HookGraphic.js';

/** 已装好浏览器才跑：onBrowserDownload 直接抛错，没有浏览器时 ensureBrowser 失败而不是去下载 */
const chromeAvailable = process.env.MINGZHI_SKIP_RENDER_TESTS === '1' ? false : await ensureBrowser({
  logLevel: 'error',
  onBrowserDownload: () => { throw new Error('未安装 Chrome Headless Shell，跳过渲染测试'); },
}).then(() => true, () => false);

const BAND_TOP = 875;
const BAND_H = CANVAS.seam - BAND_TOP;
/** 比参照亮超过 8 视为卡片内容（白卡、浅色胶囊）；卡片投影只会变暗且不超过约 25，暗于参照超过 32 才视为内容（文字、深色块） */
const BRIGHTER_TOL = 8;
const DARKER_TOL = 32;

const c = (n: number) => '测'.repeat(n);
const W = (n: number) => 'WMWQ'.repeat(n).slice(0, n);
const MAX_CARDS: Record<string, CardSpec> = {
  hook: { template: 'hook', props: { index: 1, total: 3, kicker: c(60), headline: c(60), highlight: [c(12)], stat: { value: c(24), label: c(24) } } },
  hookLatin: { template: 'hook', props: { index: 1, total: 3, kicker: W(60), headline: 'WMWM WMWM WMWM WMWM WMWM WMWM WMWM WMWM WMWM WMWM WMWM WMWM', highlight: [], stat: { value: W(24), label: W(24) } } },
  title: { template: 'title', props: { title: c(60), subtitle: c(60), crumb: c(24) } },
  bigNumber: { template: 'bigNumber', props: { value: '1234567890', unit: c(24), label: c(60), chips: Array.from({ length: 18 }, () => c(12)), highlight: [c(12)] } },
  chips: { template: 'chips', props: { groups: [0, 1].map(() => ({ label: c(12), items: Array.from({ length: 5 }, () => ({ text: c(12), mark: 'yes' as const })) })) } },
  compareBars: { template: 'compareBars', props: { crumb: c(24), items: [0, 1, 2].map(() => ({ name: c(12), note: c(24), value: 0.9, annotation: c(12), tone: 'bad' as const })), verdict: c(12) } },
  compareLatin: { template: 'compareBars', props: { crumb: W(24), items: [0, 1, 2].map(() => ({ name: W(12), note: W(24), value: 0.9, annotation: W(12), tone: 'bad' as const })), verdict: W(12) } },
  evidenceList: { template: 'evidenceList', props: { crumb: c(24), title: c(60), rows: Array.from({ length: 5 }, () => ({ badge: '证据' as const, text: c(60) })), highlight: [0, 1, 2, 3, 4], tags: [c(12), c(12), c(12)] } },
  evidenceLatin: { template: 'evidenceList', props: { crumb: W(24), title: W(60), rows: Array.from({ length: 5 }, () => ({ badge: '证据' as const, text: W(60) })), tags: [W(12), W(12), W(12)] } },
  terminal: { template: 'terminal', props: { title: c(24), lines: Array.from({ length: 6 }, () => c(40)) } },
  toggles: { template: 'toggles', props: { title: c(24), rows: Array.from({ length: 4 }, (_, i) => ({ label: c(12), on: i % 2 === 0 })), footnote: c(60) } },
  strikeList: { template: 'strikeList', props: { title: c(24), items: Array.from({ length: 5 }, () => c(12)) } },
  strikeLatin: { template: 'strikeList', props: { title: W(24), items: Array.from({ length: 5 }, () => W(12)) } },
  browser: { template: 'browser', props: { url: 'x'.repeat(80), title: c(60) } },
  photo: { template: 'photo', props: { image: 'img.png', label: c(24), sublabel: c(60) } },
};
/** 带固定底的模板用「同样的底、几乎没有内容」的渲染作参照；其余模板的参照是卡片区米色底。钩子没有素材时底图里的大号关键词随卡片取，参照用同一个关键词 */
function backdropRef(card: CardSpec): CardSpec | null {
  if (card.template === 'hook') return { template: 'hook', props: { index: card.props.index, total: card.props.total, headline: '测', highlight: [hookKeyword(card.props)] } };
  if (card.template === 'photo') return { template: 'photo', props: { image: 'img.png' } };
  return null;
}

const hex = (h: string): number[] => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

/** 渲染第 5 秒（进场早已结束）的静帧，取出字幕带的 RGB 像素 */
async function bandPixels(serveUrl: string, dir: string, name: string, card: CardSpec): Promise<Buffer> {
  const inputProps = { card, dur: 6 };
  const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
  const output = join(dir, `${name}.png`);
  await renderStill({ composition, serveUrl, inputProps, output, frame: 150 });
  return runBuffer(loadConfig({}).ffmpeg, ['-v', 'error', '-i', output, '-vf', `crop=${CANVAS.width}:${BAND_H}:0:${BAND_TOP}`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
}

/** 字幕带里越界的像素：返回第一个越界点（y 为画布坐标），没有则 null */
function firstIntrusion(px: Buffer, ref: (i: number) => number): { x: number; y: number } | null {
  for (let i = 0; i < px.length; i++) {
    const d = px[i] - ref(i);
    if (d > BRIGHTER_TOL || d < -DARKER_TOL) {
      const p = Math.floor(i / 3);
      return { x: p % CANVAS.width, y: BAND_TOP + Math.floor(p / CANVAS.width) };
    }
  }
  return null;
}

describe.skipIf(!chromeAvailable)('字幕带守卫（需要本机 Chrome Headless Shell）', () => {
  it('字段上限的卡片都不进入 y ≥ 875 的字幕带', async () => {
    for (const [k, card] of Object.entries(MAX_CARDS)) expect(CardSpecSchema.safeParse(card).success, k).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), 'mz-band-'));
    await run(loadConfig({}).ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x1080', '-frames:v', '1', join(dir, 'img.png')]);
    const stage = hex(THEME.stage);
    const intrusions = await withBundle(dir, async (serveUrl) => {
      const found: Record<string, { x: number; y: number }> = {};
      for (const [name, card] of Object.entries(MAX_CARDS)) {
        const px = await bandPixels(serveUrl, dir, name, card);
        const ref = backdropRef(card);
        const refPx = ref ? await bandPixels(serveUrl, dir, `ref-${name}`, ref) : null;
        const hit = firstIntrusion(px, refPx ? (i) => refPx[i] : (i) => stage[i % 3]);
        if (hit) found[name] = hit;
      }
      return found;
    });
    expect(intrusions, JSON.stringify(intrusions)).toEqual({});
  }, 300_000);
});
