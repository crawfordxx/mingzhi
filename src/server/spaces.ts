import { statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { z } from 'zod';
import { isPresetId } from '../background/presets.js';
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE } from '../captions/styles.js';
import { OUTRO_TEXT_MAX } from '../compose/ending.js';
import { COVER_STYLES } from '../cover/styles.js';
import { isInside } from '../workspace/runner-files.js';
import { projectSpentYuan, type Space, type SpaceSettings, type VersionMeta } from '../workspace/store.js';
import type { AppCtx } from './context.js';
import { HttpError } from './http.js';
import type { RunState } from './runs.js';
import { IMAGE_EXTS, looksLikeImage } from './upload.js';

export const DEFAULT_BUDGET_YUAN = 10;
export const DEFAULT_SETTINGS: SpaceSettings = { captionStyle: DEFAULT_CAPTION_STYLE, budgetYuan: DEFAULT_BUDGET_YUAN, broll: true, maxVideos: 1, grain: true };
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
  outro: z.object({ enabled: z.boolean(), text: z.string().trim().refine((t) => [...t].length <= OUTRO_TEXT_MAX, `片尾文字最多 ${OUTRO_TEXT_MAX} 个字`) }).strict().optional(),
  grain: z.boolean().optional(),
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

export const BACKGROUNDS_DIR = 'backgrounds';

/** 自定义背景图只能是上传接口写进本项目 backgrounds/ 下的图片文件（扩展名与文件头都要对），否则能让页面把本机任意文件读进成片 */
export function checkBackgroundFile(app: Pick<AppCtx, 'spacesRoot'>, id: string, path: string): void {
  const dir = join(spaceDir(app, id), BACKGROUNDS_DIR);
  const ok = isInside(dir, path) && (IMAGE_EXTS as readonly string[]).includes(extname(path).toLowerCase()) && isFile(path) && looksLikeImage(path);
  if (!ok) throw new HttpError(400, '自定义背景图必须是本项目里上传的图片');
}

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** 给前端的设置：自定义背景只给文件名，不外露本机路径 */
export function publicSettings(settings: SpaceSettings): SpaceSettings {
  const bg = settings.background;
  return bg?.kind === 'file' ? { ...settings, background: { kind: 'file', path: basename(bg.path) } } : settings;
}

/** 给前端的版本：内容哈希只在服务端比较用，不下发 */
const publicVersion = ({ shotHashes: _h, ...v }: VersionMeta): Omit<VersionMeta, 'shotHashes'> => v;

export type SpaceDto = Omit<Space, 'inputs' | 'versions'> & {
  inputs: string[]; versions: Omit<VersionMeta, 'shotHashes'>[]; job: RunState | null; chatCostYuan: number; totalCostYuan: number;
};

/** 返回给前端的项目：输入与自定义背景只给文件名（不泄露本机路径），附当前任务状态与累计花费 */
export function toDto(space: Space, job: RunState | null): SpaceDto {
  return {
    ...space,
    inputs: space.inputs.map((p) => basename(p)),
    versions: space.versions.map(publicVersion),
    settings: publicSettings(space.settings),
    job,
    chatCostYuan: space.chatCostYuan ?? 0,
    totalCostYuan: projectSpentYuan(space),
  };
}
