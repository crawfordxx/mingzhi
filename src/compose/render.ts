import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { CardSpec, TalkProps } from '../storyboard/schema.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { CoverProps } from '../cover/styles.js';
import { loadConfig } from '../config.js';
import { run } from '../media/exec.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'render', 'index.ts');
const DEFAULT_CONCURRENCY = 8;

/** renderMedia 的并发不能超过 CPU 核数，否则直接抛错 */
export function defaultConcurrency(): number {
  return Math.min(DEFAULT_CONCURRENCY, availableParallelism());
}

/** 打包 render/ 入口；publicDir 指向工作目录（软链，不复制人像与 B-roll），模板里用 staticFile() 取。webpack 把 .js 导入解析到 .ts/.tsx，与仓库的 NodeNext 写法一致 */
function bundleFor(workDir: string): Promise<string> {
  return bundle({
    entryPoint: ENTRY,
    publicDir: workDir,
    symlinkPublicDir: true,
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } } }),
  });
}

/** 打包、执行、无论成败都删掉打包目录（serveUrl 是本地目录） */
export async function withBundle<T>(workDir: string, fn: (serveUrl: string) => Promise<T>): Promise<T> {
  const serveUrl = await bundleFor(workDir);
  try {
    return await fn(serveUrl);
  } finally {
    rmSync(serveUrl, { recursive: true, force: true });
  }
}

export interface RenderOptions { workDir: string; props: TalkProps; output: string; concurrency?: number; onProgress?: (ratio: number) => void }

export async function renderTalk(opts: RenderOptions): Promise<void> {
  await withBundle(opts.workDir, async (serveUrl) => {
    const inputProps = opts.props;
    const composition = await selectComposition({ serveUrl, id: 'Talk', inputProps });
    await renderMedia({
      composition, serveUrl, inputProps, codec: 'h264', crf: 18, outputLocation: opts.output,
      concurrency: opts.concurrency ?? defaultConcurrency(),
      onProgress: ({ progress }) => opts.onProgress?.(progress),
    });
  });
  opts.onProgress?.(1);
}

/** 单张卡片在 0.8 秒（进场动画结束后）的静帧，1080×960 */
export async function renderCardStill(opts: { workDir: string; card: CardSpec; output: string }): Promise<void> {
  await withBundle(opts.workDir, async (serveUrl) => {
    const inputProps = { card: opts.card };
    const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
    await renderStill({ composition, serveUrl, inputProps, output: opts.output, frame: 24 });
  });
}

const STRIP_EDGE_SEC = 0.3;
const CARD_FPS = 30;

/** 自检取样时刻：镜头开头后 0.3 秒、中点、镜头结束前 0.3 秒（镜头不足 0.6 秒时三点收拢到中点附近），换算成帧并夹在合成范围内 */
export function cardSampleFrames(durationSec: number): number[] {
  const last = Math.max(0, Math.round(durationSec * CARD_FPS) - 1);
  const edge = Math.min(STRIP_EDGE_SEC, durationSec / 2);
  return [edge, durationSec / 2, durationSec - edge].map((t) => Math.min(last, Math.max(0, Math.round(t * CARD_FPS))));
}

/** 在已有打包上渲染三个取样帧到 files */
async function renderSamples(serveUrl: string, card: CardSpec, durationSec: number, stills: { frame: number; file: string }[]): Promise<void> {
  const inputProps = { card, dur: durationSec };
  const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
  for (const s of stills) await renderStill({ composition, serveUrl, inputProps, output: s.file, frame: s.frame, imageFormat: 'png' });
}

/** 视觉自检用的三联图：卡片在镜头开头后 0.3 秒、中点、结束前 0.3 秒的静帧，ffmpeg 横向拼成 3240×960 再缩到 1620×480，返回 workDir/qa 下的 PNG 路径（调用方用完自行删除）。传入 serveUrl 时复用已有打包（批量检查时只打一次包），否则自己打包 */
export async function renderCardFrames(workDir: string, card: CardSpec, durationSec: number, serveUrl?: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'mz-strip-'));
  const outDir = join(workDir, 'qa');
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, `card-${randomUUID()}.png`);
  try {
    const stills = cardSampleFrames(durationSec).map((frame, i) => ({ frame, file: join(tmp, `f${i}.png`) }));
    if (serveUrl) await renderSamples(serveUrl, card, durationSec, stills);
    else await withBundle(workDir, (url) => renderSamples(url, card, durationSec, stills));
    const inputs = stills.flatMap((s) => ['-i', s.file]);
    await run(loadConfig().ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', 'hstack=inputs=3,scale=1620:480', '-frames:v', '1', output]);
    return output;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 字幕样式预览静帧（1080×600，一行示例字幕；bg 为相对 workDir 的底图，可省略） */
export async function renderCaptionStill(opts: { workDir: string; captionStyle: CaptionStyleId; captionFontFile: string; text: string; bg?: string; output: string }): Promise<void> {
  await withBundle(opts.workDir, async (serveUrl) => {
    const inputProps = { text: opts.text, captionStyle: opts.captionStyle, captionFontFile: opts.captionFontFile, ...(opts.bg ? { bg: opts.bg } : {}) };
    const composition = await selectComposition({ serveUrl, id: 'CaptionStill', inputProps });
    await renderStill({ composition, serveUrl, inputProps, output: opts.output, frame: 0 });
  });
}

/** 封面静帧（Cover34 1080×1440、Cover43 1440×1080）：一次打包，逐张出 PNG */
export async function renderCoverStills(workDir: string, stills: { id: 'Cover34' | 'Cover43'; props: CoverProps; output: string }[]): Promise<void> {
  await withBundle(workDir, async (serveUrl) => {
    for (const still of stills) {
      const composition = await selectComposition({ serveUrl, id: still.id, inputProps: still.props });
      await renderStill({ composition, serveUrl, inputProps: still.props, output: still.output, frame: 0, imageFormat: 'png' });
    }
  });
}
