import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';
import type { CardSpec, TalkProps } from '../storyboard/schema.js';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'render', 'index.ts');
const DEFAULT_CONCURRENCY = 8;

/** 打包 render/ 入口；publicDir 指向工作目录，模板里用 staticFile() 取人像与 B-roll。webpack 把 .js 导入解析到 .ts/.tsx，与仓库的 NodeNext 写法一致 */
function bundleFor(workDir: string): Promise<string> {
  return bundle({
    entryPoint: ENTRY,
    publicDir: workDir,
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } } }),
  });
}

export interface RenderOptions { workDir: string; props: TalkProps; output: string; concurrency?: number; onProgress?: (ratio: number) => void }

export async function renderTalk(opts: RenderOptions): Promise<void> {
  const serveUrl = await bundleFor(opts.workDir);
  const inputProps = opts.props as unknown as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: 'Talk', inputProps });
  await renderMedia({
    composition, serveUrl, inputProps, codec: 'h264', crf: 18, outputLocation: opts.output,
    concurrency: opts.concurrency ?? DEFAULT_CONCURRENCY,
    onProgress: ({ progress }) => opts.onProgress?.(progress),
  });
  opts.onProgress?.(1);
}

/** 单张卡片在 0.8 秒（进场动画结束后）的静帧，1080×960 */
export async function renderCardStill(opts: { workDir: string; card: CardSpec; output: string }): Promise<void> {
  const serveUrl = await bundleFor(opts.workDir);
  const inputProps = { card: opts.card } as Record<string, unknown>;
  const composition = await selectComposition({ serveUrl, id: 'CardStill', inputProps });
  await renderStill({ composition, serveUrl, inputProps, output: opts.output, frame: 24 });
}
