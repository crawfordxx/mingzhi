import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderStill, selectComposition } from '@remotion/renderer';

const ENTRY = join(dirname(fileURLToPath(import.meta.url)), 'index.tsx');

/** 打包颗粒层测试入口，逐帧出 PNG（同一帧可出多次，用来验证可复现），返回文件路径；bg 为 publicDir 下的底图 */
export async function renderGrainStills(outDir: string, frames: number[], bg?: { publicDir: string; file: string }): Promise<string[]> {
  const serveUrl = await bundle({
    entryPoint: ENTRY,
    ...(bg ? { publicDir: bg.publicDir } : {}),
    webpackOverride: (c) => ({ ...c, resolve: { ...c.resolve, extensionAlias: { '.js': ['.ts', '.tsx', '.js'] } } }),
  });
  try {
    const inputProps = bg ? { bg: bg.file } : {};
    const composition = await selectComposition({ serveUrl, id: 'GrainTest', inputProps });
    const files: string[] = [];
    for (const [i, frame] of frames.entries()) {
      const output = join(outDir, `grain-${i}-${frame}.png`);
      await renderStill({ composition, serveUrl, inputProps, output, frame, imageFormat: 'png' });
      files.push(output);
    }
    return files;
  } finally {
    rmSync(serveUrl, { recursive: true, force: true });
  }
}
