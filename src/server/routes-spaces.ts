import { rmSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { BackgroundSpec } from '../background/resolve.js';
import { INPUT_DEPENDENTS, isInside } from '../workspace/runner-files.js';
import type { Space } from '../workspace/store.js';
import type { AppCtx } from './context.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { loadSpace } from './lookup.js';
import { route, type Route, type RouteCtx } from './router.js';
import {
  BACKGROUNDS_DIR, checkBackgroundFile, DEFAULT_SETTINGS, DEFAULT_TITLE, mergeSettings, parseSettingsPatch, parseTitle, spaceDir, toDto,
  type SettingsPatchInput,
} from './spaces.js';
import { IMAGE_EXTS, looksLikeImage, MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, receiveFile, VIDEO_EXTS } from './upload.js';

const dto = (app: AppCtx, space: Space) => toDto(space, app.runs.state(space.id));

/**
 * 出过片（有 done 版本）后不能再改口播与首个版本的设置，改动走对话；有任务在排队或运行时也不行。
 * 首版失败或取消（没有 done 版本）时允许修改，改完再点「开始出片」。
 */
function requirePristine(app: AppCtx, space: Space, what: string): void {
  if (space.versions.some((v) => v.status === 'done')) throw new HttpError(409, `已经出过片，不能再${what}；请在对话里提出修改`);
  if (app.runs.state(space.id)) throw new HttpError(409, `这个项目正在排队或出片，不能${what}`);
}

/** 首版失败后改了口播：base/ 里按旧口播做的分析、剪切与抠像图层都作废 */
function dropInputDependents(app: AppCtx, space: Space): void {
  if (space.versions.length === 0) return;
  const base = app.store.baseDir(space.id);
  for (const name of INPUT_DEPENDENTS) rmSync(join(base, name), { force: true });
}

const FIRST_VERSION_KEYS = ['background', 'captionStyle', 'coverStyle'] as const;

/** 设置能不能改：首个版本的设置按 requirePristine；预算上限任何时候都能调；其余开关出片中不能改 */
function checkSettingsPatch(app: AppCtx, space: Space, patch: SettingsPatchInput): void {
  if (FIRST_VERSION_KEYS.some((k) => k in patch)) requirePristine(app, space, '改背景、字幕样式和封面风格');
  const budgetOnly = Object.keys(patch).every((k) => k === 'budgetYuan');
  if (!budgetOnly && app.runs.state(space.id)) throw new HttpError(409, '这个项目正在排队或出片，不能改设置');
  if (patch.background?.kind === 'file') checkBackgroundFile(app, space.id, patch.background.path);
}

async function createSpace(app: AppCtx, c: RouteCtx): Promise<void> {
  const body = await readJsonBody(c.req, true);
  const title = body.title === undefined ? DEFAULT_TITLE : parseTitle(body.title);
  const settings = mergeSettings(DEFAULT_SETTINGS, parseSettingsPatch(body.settings ?? {}));
  if (settings.background?.kind === 'file') throw new HttpError(400, '自定义背景图请用上传接口');
  sendJson(c.res, 201, dto(app, app.store.create(title, [], settings)));
}

/** 先读完请求体，再在同一个同步块里取最新快照、检查、写回（读请求体期间运行器可能刚把版本置 done） */
async function patchSpace(app: AppCtx, c: RouteCtx): Promise<void> {
  const id = loadSpace(app, c.params.id).id;
  const body = await readJsonBody(c.req);
  const unknown = Object.keys(body).filter((k) => k !== 'title' && k !== 'settings');
  if (unknown.length > 0) throw new HttpError(400, `不支持修改：${unknown.join('、')}`);
  const patch = body.settings === undefined ? undefined : parseSettingsPatch(body.settings);
  const title = body.title === undefined ? undefined : parseTitle(body.title);
  const saved = app.store.update(id, (space) => {
    if (patch) checkSettingsPatch(app, space, patch);
    return {
      ...space,
      ...(patch ? { settings: mergeSettings(space.settings, patch) } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  });
  sendJson(c.res, 200, dto(app, saved));
}

async function uploadInput(app: AppCtx, c: RouteCtx): Promise<void> {
  const before = loadSpace(app, c.params.id);
  requirePristine(app, before, '追加口播');
  const file = await receiveFile(c.req, { parent: join(spaceDir(app, before.id), 'inputs'), allowed: VIDEO_EXTS, maxBytes: MAX_VIDEO_BYTES, kind: '视频' });
  try {
    const info = await app.deps.probe(file.path).catch(() => {
      throw new HttpError(400, '这不是可识别的视频文件（或文件已损坏）');
    });
    // 上传期间状态可能变了：在同一个同步块里重新读、检查、写回
    const saved = app.store.update(before.id, (space) => {
      requirePristine(app, space, '追加口播');
      dropInputDependents(app, space);
      return { ...space, inputs: [...space.inputs, file.path] };
    });
    const uploaded = { name: file.name, bytes: file.bytes, durationSec: info.durationSec, width: info.width, height: info.height };
    sendJson(c.res, 201, { ...dto(app, saved), uploaded });
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
  dropInputDependents(app, space);
  app.store.update(space.id, (s) => ({ ...s, inputs: s.inputs.filter((p) => p !== path) }));
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
    const background: BackgroundSpec = { kind: 'file', path: file.path };
    const saved = app.store.update(before.id, (space) => {
      requirePristine(app, space, '换自定义背景');
      return { ...space, settings: { ...space.settings, background } };
    });
    sendJson(c.res, 201, { ...dto(app, saved), background: { kind: 'file', path: basename(file.path) } });
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
