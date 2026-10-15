import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { BackgroundSpec } from '../background/resolve.js';
import { isInside } from '../workspace/runner-files.js';
import type { Space } from '../workspace/store.js';
import type { AppCtx } from './context.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { loadSpace } from './lookup.js';
import { route, type Route, type RouteCtx } from './router.js';
import {
  BACKGROUNDS_DIR, checkBackgroundFile, DEFAULT_SETTINGS, DEFAULT_TITLE, mergeSettings, parseSettingsPatch, parseTitle, saveSpace, spaceDir, toDto,
} from './spaces.js';
import { IMAGE_EXTS, looksLikeImage, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, receiveFile, VIDEO_EXTS } from './upload.js';

const dto = (app: AppCtx, space: Space) => toDto(space, app.runs.state(space.id));

/** 出片开始后不能再改口播与首个版本的设置；有任务在跑时也不行 */
function requirePristine(app: AppCtx, space: Space, what: string): void {
  if (space.versions.length > 0) throw new HttpError(409, `已经开始出片，不能再${what}；请在对话里提出修改`);
  if (app.runs.state(space.id)) throw new HttpError(409, `这个项目正在排队或出片，不能${what}`);
}

async function createSpace(app: AppCtx, c: RouteCtx): Promise<void> {
  const body = await readJsonBody(c.req, true);
  const title = body.title === undefined ? DEFAULT_TITLE : parseTitle(body.title);
  const settings = mergeSettings(DEFAULT_SETTINGS, parseSettingsPatch(body.settings ?? {}));
  if (settings.background?.kind === 'file') throw new HttpError(400, '自定义背景图请用上传接口');
  sendJson(c.res, 201, dto(app, app.store.create(title, [], settings)));
}

async function patchSpace(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const body = await readJsonBody(c.req);
  const unknown = Object.keys(body).filter((k) => k !== 'title' && k !== 'settings');
  if (unknown.length > 0) throw new HttpError(400, `不支持修改：${unknown.join('、')}`);
  const patch = body.settings === undefined ? undefined : parseSettingsPatch(body.settings);
  const title = body.title === undefined ? undefined : parseTitle(body.title);
  if (patch) {
    const firstVersionOnly = ['background', 'captionStyle', 'coverStyle'].some((k) => k in patch);
    if (firstVersionOnly) requirePristine(app, space, '改背景、字幕样式和封面风格');
    else if (app.runs.state(space.id)) throw new HttpError(409, '这个项目正在排队或出片，不能改设置');
    if (patch.background?.kind === 'file') checkBackgroundFile(app, space.id, patch.background.path);
    saveSpace(app, { ...space, settings: mergeSettings(space.settings, patch) });
  }
  if (title !== undefined) app.store.rename(space.id, title);
  sendJson(c.res, 200, dto(app, app.store.get(space.id)));
}

async function uploadInput(app: AppCtx, c: RouteCtx): Promise<void> {
  const before = loadSpace(app, c.params.id);
  requirePristine(app, before, '追加口播');
  const file = await receiveFile(c.req, { parent: join(spaceDir(app, before.id), 'inputs'), allowed: VIDEO_EXTS, maxBytes: MAX_VIDEO_BYTES, kind: '视频' });
  try {
    const info = await app.deps.probe(file.path).catch(() => {
      throw new HttpError(400, '这不是可识别的视频文件（或文件已损坏）');
    });
    const space = loadSpace(app, before.id); // 上传期间状态可能变了，重新读
    requirePristine(app, space, '追加口播');
    saveSpace(app, { ...space, inputs: [...space.inputs, file.path] });
    sendJson(c.res, 201, { ...dto(app, app.store.get(space.id)), uploaded: { name: file.name, bytes: file.bytes, durationSec: info.durationSec, width: info.width, height: info.height } });
  } catch (err) {
    rmSync(file.dir, { recursive: true, force: true });
    throw err;
  }
}

function deleteInput(app: AppCtx, c: RouteCtx): void {
  const space = loadSpace(app, c.params.id);
  requirePristine(app, space, '删除口播');
  const index = /^\d{1,4}$/.test(c.params.index) ? Number(c.params.index) : -1;
  const path = space.inputs[index];
  if (path === undefined) throw new HttpError(404, '没有这一段口播');
  saveSpace(app, { ...space, inputs: space.inputs.filter((_, i) => i !== index) });
  const dir = dirname(path);
  if (isInside(join(spaceDir(app, space.id), 'inputs'), dir)) rmSync(dir, { recursive: true, force: true });
  sendJson(c.res, 200, dto(app, app.store.get(space.id)));
}

async function uploadBackground(app: AppCtx, c: RouteCtx): Promise<void> {
  const before = loadSpace(app, c.params.id);
  requirePristine(app, before, '换自定义背景');
  const file = await receiveFile(c.req, { parent: join(spaceDir(app, before.id), BACKGROUNDS_DIR), allowed: IMAGE_EXTS, maxBytes: MAX_IMAGE_BYTES, kind: '图片' });
  try {
    if (!looksLikeImage(file.path)) throw new HttpError(400, '这不是有效的 jpg / png / webp 图片');
    const space = loadSpace(app, before.id);
    requirePristine(app, space, '换自定义背景');
    const background: BackgroundSpec = { kind: 'file', path: file.path };
    saveSpace(app, { ...space, settings: { ...space.settings, background } });
    sendJson(c.res, 201, { ...dto(app, app.store.get(space.id)), background });
  } catch (err) {
    rmSync(file.dir, { recursive: true, force: true });
    throw err;
  }
}

export function spaceRoutes(app: AppCtx): Route[] {
  return [
    route('GET', 'api/spaces', (c) => sendJson(c.res, 200, app.store.list().map((s) => dto(app, s)))),
    route('POST', 'api/spaces', (c) => createSpace(app, c)),
    route('GET', 'api/spaces/:id', (c) => sendJson(c.res, 200, dto(app, loadSpace(app, c.params.id)))),
    route('PATCH', 'api/spaces/:id', (c) => patchSpace(app, c)),
    route('POST', 'api/spaces/:id/inputs', (c) => uploadInput(app, c)),
    route('DELETE', 'api/spaces/:id/inputs/:index', (c) => deleteInput(app, c)),
    route('POST', 'api/spaces/:id/background', (c) => uploadBackground(app, c)),
  ];
}
