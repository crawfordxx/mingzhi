import { mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { makeCancelSignal, renderMedia, renderStill, selectComposition, type CancelSignal } from '@remotion/renderer';
import { CancelledError, throwIfCancelled } from '../cancel.js';
import { CANVAS, type CardSpec, type TalkProps } from '../storyboard/schema.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { CoverProps } from '../cover/styles.js';
import { run } from '../media/exec.js';
import { loadConfig } from '../config.js';
import { browserOptions } from './browser.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'render', 'index.ts');
const DEFAULT_CONCURRENCY = 8;

/** renderMedia 的并发不能超过 CPU 核数，否则直接抛错 */
export function defaultConcurrency(): number {
  return Math.min(DEFAULT_CONCURRENCY, availableParallelism());
}

/** webpack 持久化缓存目录：放数据目录，不写进应用安装目录（约 170 MB；应用目录升级时整体替换，Windows 上还可能被杀毒软件占用） */
export function remotionCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(loadConfig(env).dataDir, 'cache', 'remotion');
}

const CACHE_HASH = /^[0-9a-f]{32}$/;
const CACHE_ENV_DIR = /^remotion-production-[\d.]+$/;

/**
 * 清掉数据目录里过期的 webpack 缓存：缓存名是整份打包配置的 md5（含应用目录的绝对路径），
 * 每个应用版本一份、约 170 MB，不清理会随升级一直长。`name` 是 bundler 给的 `remotion-production-<版本>/<hash>`。
 * 只删 cacheDir 之下、名称符合模式的目录：同一环境目录下 hash 不同的兄弟，以及别的 Remotion 版本的环境目录。
 */
export function pruneStaleRemotionCaches(cacheDir: string, name: string): void {
  const [envDir, hash] = name.split(/[\\/]/);
  if (!envDir || !hash || !CACHE_ENV_DIR.test(envDir) || !CACHE_HASH.test(hash)) return; // 认不出就什么都不删
  const remove = (path: string): void => {
    try { rmSync(path, { recursive: true, force: true }); } catch { /* 删不掉下次再试，不影响打包 */ }
  };
  const list = (dir: string): string[] => {
    try { return readdirSync(dir); } catch { return []; }
  };
  for (const entry of list(cacheDir)) {
    if (entry !== envDir && CACHE_ENV_DIR.test(entry)) remove(join(cacheDir, entry));
  }
  for (const entry of list(join(cacheDir, envDir))) {
    if (entry !== hash && CACHE_HASH.test(entry)) remove(join(cacheDir, envDir, entry));
  }
}

/**
 * 把 webpack 缓存目录指到 cacheDirectory，并清掉过期缓存。bundler 在 webpackOverride 之后才写入 cache 配置，
 * 所以不能直接在 override 里改；插件的 apply 发生在 webpack 补默认值（含默认缓存目录）之前，在这里设置最稳妥。
 */
function cacheDirPlugin(cacheDirectory: string): { apply: (compiler: { options: { cache?: unknown } }) => void } {
  return {
    apply(compiler) {
      const cache = compiler.options.cache;
      if (!cache || typeof cache !== 'object') return;
      const c = cache as { cacheDirectory?: string; name?: string };
      c.cacheDirectory = cacheDirectory;
      if (c.name) pruneStaleRemotionCaches(cacheDirectory, c.name);
    },
  };
}

/** 打包 render/ 入口；publicDir 指向工作目录（软链，不复制人像与 B-roll），模板里用 staticFile() 取。webpack 把 .js 导入解析到 .ts/.tsx，与仓库的 NodeNext 写法一致 */
function bundleFor(workDir: string): Promise<string> {
  return bundle({
    entryPoint: ENTRY,
    publicDir: workDir,
    symlinkPublicDir: true,
    webpackOverride: (c) => ({
      ...c,
      resolve: { ...c.resolve, extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } },
      plugins: [...(c.plugins ?? []), cacheDirPlugin(remotionCacheDir())],
    }),
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

/**
 * 把 AbortSignal 接到 Remotion 的 cancelSignal：取消时渲染进程被终止，这里统一抛 CancelledError。
 * 没有 signal 时不做任何事（cancelSignal 为 undefined）。
 */
export async function withCancelSignal<T>(signal: AbortSignal | undefined, fn: (cancelSignal: CancelSignal | undefined) => Promise<T>): Promise<T> {
  throwIfCancelled(signal);
  if (!signal) return fn(undefined);
  const { cancelSignal, cancel } = makeCancelSignal();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    return await fn(cancelSignal);
  } catch (err) {
    if (signal.aborted) throw new CancelledError();
    throw err;
  } finally {
    signal.removeEventListener('abort', cancel);
  }
}

export interface RenderOptions {
  workDir: string;
  props: TalkProps;
  output: string;
  concurrency?: number;
  onProgress?: (ratio: number) => void;
  signal?: AbortSignal;
}

/** 整条渲染先写带随机后缀的临时文件，成功后改名；取消或失败时不覆盖已有的好文件 */
export async function renderTalk(opts: RenderOptions): Promise<void> {
  throwIfCancelled(opts.signal);
  const tmp = `${opts.output}.${randomUUID().slice(0, 8)}.tmp.mp4`;
  try {
    await withBundle(opts.workDir, (serveUrl) => withCancelSignal(opts.signal, async (cancelSignal) => {
      const inputProps = opts.props;
      const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'Talk', inputProps });
      await renderMedia({
        ...browserOptions(), composition, serveUrl, inputProps, codec: 'h264', crf: 18, outputLocation: tmp,
        concurrency: opts.concurrency ?? defaultConcurrency(), cancelSignal,
        onProgress: ({ progress }) => opts.onProgress?.(progress),
      });
    }));
    renameSync(tmp, opts.output);
  } finally {
    rmSync(tmp, { force: true });
  }
  opts.onProgress?.(1);
}

/** 单张卡片在 0.8 秒（进场动画结束后）的静帧，1080×960 */
export async function renderCardStill(opts: { workDir: string; card: CardSpec; output: string }): Promise<void> {
  await withBundle(opts.workDir, async (serveUrl) => {
    const inputProps = { card: opts.card };
    const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'CardStill', inputProps });
    await renderStill({ ...browserOptions(), composition, serveUrl, inputProps, output: opts.output, frame: 24 });
  });
}

const STRIP_EDGE_SEC = 0.3;

/** 自检取样时刻：镜头开头后 0.3 秒、中点、镜头结束前 0.3 秒（镜头不足 0.6 秒时三点收拢到中点附近），换算成帧并夹在合成范围内 */
export function cardSampleFrames(durationSec: number): number[] {
  const last = Math.max(0, Math.round(durationSec * CANVAS.fps) - 1);
  const edge = Math.min(STRIP_EDGE_SEC, durationSec / 2);
  return [edge, durationSec / 2, durationSec - edge].map((t) => Math.min(last, Math.max(0, Math.round(t * CANVAS.fps))));
}

/** 在已有打包上渲染三个取样帧到 files */
async function renderSamples(serveUrl: string, card: CardSpec, durationSec: number, stills: { frame: number; file: string }[]): Promise<void> {
  const inputProps = { card, dur: durationSec };
  const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'CardStill', inputProps });
  for (const s of stills) await renderStill({ ...browserOptions(), composition, serveUrl, inputProps, output: s.file, frame: s.frame, imageFormat: 'png' });
}

/** 视觉自检用的三联图：卡片在镜头开头后 0.3 秒、中点、结束前 0.3 秒的静帧，ffmpeg 横向拼成 3240×960 再缩到 1620×480，返回 workDir/qa 下的 PNG 路径（调用方用完自行删除）。ffmpeg 由调用方传入（不在渲染层读配置）。传入 serveUrl 时复用已有打包（批量检查时只打一次包），否则自己打包 */
export async function renderCardFrames(workDir: string, card: CardSpec, durationSec: number, ffmpeg: string, serveUrl?: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), 'mz-strip-'));
  const outDir = join(workDir, 'qa');
  mkdirSync(outDir, { recursive: true });
  const output = join(outDir, `card-${randomUUID()}.png`);
  try {
    const stills = cardSampleFrames(durationSec).map((frame, i) => ({ frame, file: join(tmp, `f${i}.png`) }));
    if (serveUrl) await renderSamples(serveUrl, card, durationSec, stills);
    else await withBundle(workDir, (url) => renderSamples(url, card, durationSec, stills));
    const inputs = stills.flatMap((s) => ['-i', s.file]);
    await run(ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', 'hstack=inputs=3,scale=1620:480', '-frames:v', '1', output]);
    return output;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 字幕样式预览静帧（1080×600，一行示例字幕；bg 为相对 workDir 的底图，可省略） */
export async function renderCaptionStill(opts: { workDir: string; captionStyle: CaptionStyleId; captionFontFile: string; text: string; bg?: string; output: string }): Promise<void> {
  await withBundle(opts.workDir, async (serveUrl) => {
    const inputProps = { text: opts.text, captionStyle: opts.captionStyle, captionFontFile: opts.captionFontFile, ...(opts.bg ? { bg: opts.bg } : {}) };
    const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'CaptionStill', inputProps });
    await renderStill({ ...browserOptions(), composition, serveUrl, inputProps, output: opts.output, frame: 0 });
  });
}

/** 封面静帧（Cover34 1080×1440、Cover43 1440×1080）：一次打包，逐张出 PNG */
export async function renderCoverStills(workDir: string, stills: { id: 'Cover34' | 'Cover43'; props: CoverProps; output: string }[]): Promise<void> {
  await withBundle(workDir, async (serveUrl) => {
    for (const still of stills) {
      const composition = await selectComposition({ ...browserOptions(), serveUrl, id: still.id, inputProps: still.props });
      await renderStill({ ...browserOptions(), composition, serveUrl, inputProps: still.props, output: still.output, frame: 0, imageFormat: 'png' });
    }
  });
}

export interface SegmentRenderOptions { serveUrl: string; props: TalkProps; output: string; concurrency?: number; signal?: AbortSignal }

/** 渲染一段无声画面（含首尾帧，frameRange 为闭区间）；复用外部打包，供分段缓存使用 */
export async function renderVideoSegment(opts: SegmentRenderOptions & { startFrame: number; endFrame: number }): Promise<void> {
  const { serveUrl, props: inputProps } = opts;
  await withCancelSignal(opts.signal, async (cancelSignal) => {
    const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'Talk', inputProps });
    await renderMedia({
      ...browserOptions(), composition, serveUrl, inputProps, codec: 'h264', crf: 18, muted: true, outputLocation: opts.output,
      frameRange: [opts.startFrame, opts.endFrame - 1], concurrency: opts.concurrency ?? defaultConcurrency(), cancelSignal,
    });
  });
}

/** 整条音轨单独渲染成 aac（m4a），与画面分开，拼接处不会爆音 */
export async function renderAudioTrack(opts: SegmentRenderOptions): Promise<void> {
  const { serveUrl, props: inputProps } = opts;
  await withCancelSignal(opts.signal, async (cancelSignal) => {
    const composition = await selectComposition({ ...browserOptions(), serveUrl, id: 'Talk', inputProps });
    await renderMedia({
      ...browserOptions(), composition, serveUrl, inputProps, codec: 'aac', outputLocation: opts.output, concurrency: opts.concurrency ?? defaultConcurrency(), cancelSignal,
    });
  });
}
