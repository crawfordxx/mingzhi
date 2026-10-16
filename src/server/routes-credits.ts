import { attributionText } from '../broll/credits.js';
import type { AppCtx } from './context.js';
import { creditFilePath, findEntry, isCreditAction, publicEntry, readCredits, readMarks, shotIndexOf, writeMark } from './credits.js';
import { serveFile } from './files.js';
import { HttpError, sendJson } from './http.js';
import { doneVersion, loadSpace, parseVersionNumber } from './lookup.js';
import { route, type Route, type RouteCtx } from './router.js';

function target(app: AppCtx, c: RouteCtx): { id: string; n: number; dir: string } {
  const space = loadSpace(app, c.params.id);
  const n = doneVersion(space, parseVersionNumber(c.params.n)).n;
  return { id: space.id, n, dir: app.store.versionDir(space.id, n) };
}

/** GET .../credits：逐条列出本版用到的素材（来源、作者、许可、是否 AI 生成、加工项）与署名文本 */
function list(app: AppCtx, c: RouteCtx): void {
  const { id, n, dir } = target(app, c);
  const entries = readCredits(dir);
  const marks = readMarks(dir);
  const base = `/api/spaces/${id}/versions/${n}/credits`;
  sendJson(c.res, 200, {
    entries: entries.map((e) => publicEntry(e, base, marks[e.file], shotIndexOf(app, id, n, e))),
    attribution: attributionText(entries),
  });
}

/** GET .../credits/:file/thumb：素材文件本身（图片直接显示，视频浏览器取首帧） */
function thumb(app: AppCtx, c: RouteCtx): void {
  const { id, n, dir } = target(app, c);
  const entry = findEntry(readCredits(dir), c.params.file);
  const path = entry && creditFilePath(app, id, n, entry);
  if (!path) throw new HttpError(404, '素材文件不存在');
  serveFile(c.req, c.res, path, { cacheControl: 'no-cache' });
}

/**
 * POST .../credits/:file/replace|remove：标记这条素材要换掉或去掉。
 * 标记写进版本目录（credits-marks.json），下一版跑 broll 阶段时读取并处理；这里不直接出新版本，
 * 由前端随后提交 replaceBroll 修改（apply，过 validateOps）。pending: true 表示标记已记下、尚未执行
 */
function mark(app: AppCtx, c: RouteCtx): void {
  const { dir } = target(app, c);
  const action = c.params.action;
  if (!isCreditAction(action)) throw new HttpError(400, '操作只能是 replace（替换）或 remove（删除）');
  const entry = findEntry(readCredits(dir), c.params.file);
  if (!entry) throw new HttpError(404, '这个版本没有用到这条素材');
  writeMark(dir, entry.file, action);
  sendJson(c.res, 200, { file: c.params.file, action, pending: true });
}

export function creditRoutes(app: AppCtx): Route[] {
  return [
    route('GET', 'api/spaces/:id/versions/:n/credits', (c) => list(app, c)),
    route('GET', 'api/spaces/:id/versions/:n/credits/:file/thumb', (c) => thumb(app, c)),
    route('POST', 'api/spaces/:id/versions/:n/credits/:file/:action', (c) => mark(app, c)),
  ];
}
