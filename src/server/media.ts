import { existsSync, mkdirSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { isPresetId, presetPath } from '../background/presets.js';
import { CAPTION_STYLES, type CaptionStyleId } from '../captions/styles.js';
import { COVER_FILES, FINAL_FILE, isInside } from '../workspace/runner-files.js';
import type { AppCtx } from './context.js';
import { serveFile } from './files.js';
import { HttpError } from './http.js';
import { loadSpace, parseVersionNumber } from './lookup.js';
import type { RouteCtx } from './router.js';

/** 媒体路由只认这三个文件名，其余（含 ../、编码后的 %2e%2e、绝对路径）一律 404 */
export const MEDIA_WHITELIST: readonly string[] = [FINAL_FILE, ...COVER_FILES];

export function handleMedia(app: AppCtx, c: RouteCtx): void {
  const { id, n, file } = c.params;
  if (!MEDIA_WHITELIST.includes(file)) throw new HttpError(404, '文件不存在');
  loadSpace(app, id); // 校验 id 格式并确认项目存在
  const dir = app.store.versionDir(id, parseVersionNumber(n));
  const path = resolve(join(dir, file));
  if (!isInside(dir, path)) throw new HttpError(404, '文件不存在');
  serveFile(c.req, c.res, path, { cacheControl: 'no-cache' });
}

/** 同一个缓存文件同时被多次请求时只生成一次 */
const inflight = new Map<string, Promise<void>>();
function generateOnce(dest: string, make: () => Promise<void>): Promise<void> {
  const running = inflight.get(dest);
  if (running) return running;
  mkdirSync(dirname(dest), { recursive: true });
  const p = make().finally(() => inflight.delete(dest));
  inflight.set(dest, p);
  return p;
}

/** Chrome 渲染一次只开一个，6 张预览同时请求时排队 */
let renderChain: Promise<unknown> = Promise.resolve();
const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
  const run = renderChain.then(fn, fn);
  renderChain = run.catch(() => undefined);
  return run;
};

const IMMUTABLE = 'public, max-age=86400';

/** GET /thumbs/backgrounds/<id>.jpg：预设背景缩到 320 宽并缓存到 <dataDir>/thumbs/backgrounds/ */
export async function handleBackgroundThumb(app: AppCtx, c: RouteCtx): Promise<void> {
  const id = /^([a-z0-9-]+)\.jpg$/.exec(c.params.file)?.[1];
  if (!id || !isPresetId(id)) throw new HttpError(404, '没有这个预设背景');
  const dest = join(app.cfg.dataDir, 'thumbs', 'backgrounds', `${id}.jpg`);
  if (!existsSync(dest)) await generateOnce(dest, () => app.deps.makeThumb(presetPath(id), dest));
  serveFile(c.req, c.res, dest, { type: 'image/jpeg', cacheControl: IMMUTABLE });
}

/** GET /previews/captions/<id>.png：首次请求时渲染并缓存到 <dataDir>/previews/captions/ */
export async function handleCaptionPreview(app: AppCtx, c: RouteCtx): Promise<void> {
  const id = /^([a-z0-9-]+)\.png$/.exec(c.params.file)?.[1];
  if (!id || !Object.hasOwn(CAPTION_STYLES, id)) throw new HttpError(404, '没有这个字幕样式');
  const dest = join(app.cfg.dataDir, 'previews', 'captions', `${id}.png`);
  if (!existsSync(dest)) await generateOnce(dest, () => serialized(() => app.deps.renderCaptionPreview(id as CaptionStyleId, dest)));
  serveFile(c.req, c.res, dest, { type: 'image/png', cacheControl: IMMUTABLE });
}

/** 静态托管 web/dist：带扩展名的缺失文件 404，其余路径回退到 index.html（单页应用） */
export function serveStatic(app: Pick<AppCtx, 'webDir'>, req: IncomingMessage, res: ServerResponse, segments: string[]): void {
  if (segments.some((s) => s === '..' || s === '.')) throw new HttpError(404, '文件不存在');
  const index = join(app.webDir, 'index.html');
  if (!existsSync(index)) throw new HttpError(404, '前端还没有构建，请先运行 pnpm build:web');
  const rel = segments.filter((s) => s !== '').join('/');
  const path = resolve(app.webDir, rel);
  if (!isInside(app.webDir, path) && path !== resolve(app.webDir)) throw new HttpError(404, '文件不存在');
  const last = segments[segments.length - 1] ?? '';
  const hasExt = /\.[A-Za-z0-9]+$/.test(last);
  const target = rel !== '' && existsSync(path) ? path : hasExt ? null : index;
  if (!target) throw new HttpError(404, '文件不存在');
  const hashed = segments[0] === 'assets';
  serveFile(req, res, target, { cacheControl: hashed ? 'public, max-age=31536000, immutable' : 'no-cache' });
}
