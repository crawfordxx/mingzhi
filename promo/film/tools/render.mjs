// 渲染：node tools/render.mjs stills <Launch169|Launch916> <帧号,...> <输出目录>
//       node tools/render.mjs video  <Launch169|Launch916> <输出 mp4> [起始帧-结束帧]
// 视频只出画面（无声），音轨由 tools/audio.py 合成后用 ffmpeg 封装
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { bundle } from '@remotion/bundler';
import { renderMedia, renderStill, selectComposition } from '@remotion/renderer';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
const [mode, id, arg, out] = process.argv.slice(2);
const serveUrl = await bundle({ entryPoint: path.join(root, 'src/index.ts'), publicDir: path.join(root, 'public'), webpackOverride: (c) => c });
const chromiumOptions = { gl: 'angle' };
const composition = await selectComposition({ serveUrl, id, chromiumOptions });
if (mode === 'stills') {
  fs.mkdirSync(out, { recursive: true });
  for (const fr of arg.split(',').map(Number)) {
    const file = path.join(out, `${id}-f${String(fr).padStart(4, '0')}.png`);
    await renderStill({ serveUrl, composition, frame: fr, output: file, chromiumOptions });
    process.stdout.write(`${file}\n`);
  }
} else {
  const range = out ? out.split('-').map(Number) : undefined;
  let last = -1;
  await renderMedia({
    serveUrl, composition, codec: 'h264', crf: 16, pixelFormat: 'yuv420p', outputLocation: arg, muted: true,
    chromiumOptions, concurrency: 6, frameRange: range ? [range[0], range[1]] : undefined,
    onProgress: ({ progress }) => { const p = Math.floor(progress * 20); if (p !== last) { last = p; process.stdout.write(`${p * 5}% `); } },
  });
  process.stdout.write(`\n${arg}\n`);
}
