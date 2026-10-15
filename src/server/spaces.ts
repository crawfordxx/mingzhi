import { existsSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { z } from 'zod';
import { isPresetId } from '../background/presets.js';
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE } from '../captions/styles.js';
import { COVER_STYLES } from '../cover/styles.js';
import { isInside } from '../workspace/runner-files.js';
import type { Space, SpaceSettings } from '../workspace/store.js';
import type { AppCtx } from './context.js';
import { HttpError } from './http.js';
import type { RunState } from './runs.js';

export const DEFAULT_BUDGET_YUAN = 10;
export const DEFAULT_SETTINGS: SpaceSettings = { captionStyle: DEFAULT_CAPTION_STYLE, budgetYuan: DEFAULT_BUDGET_YUAN, broll: true, maxVideos: 1 };
export const DEFAULT_TITLE = '未命名项目';

const ids = <T extends object>(o: T): [keyof T & string, ...(keyof T & string)[]] => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];

const Background = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), id: z.string().refine(isPresetId, '没有这个预设背景') }),
  z.object({ kind: z.literal('prompt'), prompt: z.string().trim().min(2).max(300) }),
  z.object({ kind: z.literal('file'), path: z.string().min(1).max(1024) }),
]);

const SettingsPatch = z.object({
  background: Background.nullable().optional(),
  captionStyle: z.enum(ids(CAPTION_STYLES)).optional(),
  coverStyle: z.enum(ids(COVER_STYLES)).optional(),
  budgetYuan: z.number().finite().min(0).max(1000).optional(),
  broll: z.boolean().optional(),
  maxVideos: z.number().int().min(0).max(10).optional(),
}).strict();
export type SettingsPatchInput = z.infer<typeof SettingsPatch>;

export const Title = z.string().trim().min(1, '标题不能为空').max(60, '标题最长 60 个字');

export function parseSettingsPatch(raw: unknown): SettingsPatchInput {
  const parsed = SettingsPatch.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new HttpError(400, `设置不合法（${issue.path.join('.') || '整体'}）：${issue.message}`);
  }
  return parsed.data;
}

export function parseTitle(raw: unknown): string {
  const parsed = Title.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, parsed.error.issues[0].message);
  return parsed.data;
}

/** 合并设置；background 为 null 表示不要背景。返回新对象，不改入参 */
export function mergeSettings(current: SpaceSettings, patch: SettingsPatchInput): SpaceSettings {
  const { background, ...rest } = patch;
  const defined = Object.fromEntries(Object.entries(rest).filter(([, v]) => v !== undefined));
  const merged: SpaceSettings = { ...current, ...defined };
  if (background === null) {
    const { background: _drop, ...without } = merged;
    return without;
  }
  return background ? { ...merged, background } : merged;
}

export const spaceDir = (app: Pick<AppCtx, 'spacesRoot'>, id: string): string => join(app.spacesRoot, id);

/** 自定义背景图必须落在本项目目录内且真实存在，否则能让页面把本机任意图片读进成片 */
export function checkBackgroundFile(app: Pick<AppCtx, 'spacesRoot'>, id: string, path: string): void {
  if (!isInside(spaceDir(app, id), path) || !existsSync(path)) throw new HttpError(400, '自定义背景图必须是本项目里上传的图片');
}

/** 与 SpaceStore 相同的保存方式（先写临时文件再改名）。SpaceStore 没有改输入与设置的接口，且不在本任务范围内 */
export function saveSpace(app: Pick<AppCtx, 'spacesRoot'>, space: Space): void {
  const file = join(spaceDir(app, space.id), 'space.json');
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(space, null, 2)}\n`);
  renameSync(tmp, file);
}

/** 返回给前端的项目：输入只给文件名（不泄露本机路径），附当前任务状态与累计花费 */
export function toDto(space: Space, job: RunState | null): Omit<Space, 'inputs'> & { inputs: string[]; job: RunState | null; totalCostYuan: number } {
  const totalCostYuan = Math.round(space.versions.reduce((s, v) => s + v.costYuan, 0) * 10_000) / 10_000;
  return { ...space, inputs: space.inputs.map((p) => basename(p)), job, totalCostYuan };
}
