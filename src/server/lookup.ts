import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionState } from '../edit/apply.js';
import { STATE_FILE } from '../workspace/runner-files.js';
import type { Space, VersionMeta } from '../workspace/store.js';
import type { AppCtx } from './context.js';
import { HttpError } from './http.js';

const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const VERSION_RE = /^[1-9]\d{0,5}$/;

export function loadSpace(app: Pick<AppCtx, 'store'>, id: string): Space {
  if (!ID_RE.test(id)) throw new HttpError(404, '项目不存在');
  try {
    return app.store.get(id);
  } catch {
    throw new HttpError(404, '项目不存在');
  }
}

export function parseVersionNumber(raw: string): number {
  if (!VERSION_RE.test(raw)) throw new HttpError(404, '版本不存在');
  return Number(raw);
}

export function findVersion(space: Space, n: number): VersionMeta {
  const v = space.versions.find((x) => x.n === n);
  if (!v) throw new HttpError(404, `版本不存在：v${n}`);
  return v;
}

/** 已完成（有 state.json）的版本；没做完不能在它上面修改、导出 */
export function doneVersion(space: Space, n: number): VersionMeta {
  const v = findVersion(space, n);
  if (v.status !== 'done') throw new HttpError(409, `v${n} 还没有成功完成，不能使用`);
  return v;
}

export function latestDone(space: Space): VersionMeta | undefined {
  return [...space.versions].reverse().find((v) => v.status === 'done');
}

/** 请求里的 version（数字）→ 版本号；缺省取最新完成的版本 */
export function pickParent(space: Space, raw: unknown): number {
  if (raw === undefined) {
    const latest = latestDone(space);
    if (!latest) throw new HttpError(409, '还没有完成的版本，请先出片');
    return latest.n;
  }
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) throw new HttpError(400, 'version 必须是正整数');
  return doneVersion(space, raw).n;
}

export function readState(app: Pick<AppCtx, 'store'>, id: string, n: number): VersionState {
  const file = join(app.store.versionDir(id, n), STATE_FILE);
  if (!existsSync(file)) throw new HttpError(404, `v${n} 还没有完成`);
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as VersionState;
  } catch {
    throw new HttpError(500, `v${n} 的状态文件已损坏`);
  }
}
