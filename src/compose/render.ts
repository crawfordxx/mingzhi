import { rmSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { CardSpec, TalkProps } from '../storyboard/schema.js';

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
