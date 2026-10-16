import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import { attributionText, type CreditEntry } from '../broll/credits.js';
import { isInside, readJson, STATE_FILE, writeJsonAtomic } from '../workspace/runner-files.js';
import type { AppCtx } from './context.js';
import { HttpError } from './http.js';

export const CREDITS_FILE = 'credits.json';
/** 用户对素材的处理标记（替换 / 删除），键是 credits.json 里的 file（相对路径 broll/<key>.<ext>），记在版本目录；下一版跑 broll 阶段时由运行器读取父版本的这个文件 */
export const MARKS_FILE = 'credits-marks.json';
export const CREDIT_ACTIONS = ['replace', 'remove'] as const;
export type CreditAction = (typeof CREDIT_ACTIONS)[number];
export const isCreditAction = (v: unknown): v is CreditAction => (CREDIT_ACTIONS as readonly unknown[]).includes(v);

const EntrySchema = z.object({
  file: z.string().min(1),
  source: z.enum(['pexels', 'pixabay', 'openverse', 'wikimedia', 'screenshot', 'generated']),
  page: z.string(),
  author: z.string().optional(),
  authorUrl: z.string().optional(),
  license: z.string(),
  licenseUrl: z.string().optional(),
  attributionRequired: z.boolean(),
  aiGenerated: z.boolean(),
  modified: z.array(z.string()),
  query: z.string(),
  fetchedAt: z.string(),
});

/** 版本目录里的素材授权记录；旧版本没有这个文件 → 空；损坏 → 500 */
export function readCredits(versionDir: string): CreditEntry[] {
  const file = join(versionDir, CREDITS_FILE);
  if (!existsSync(file)) return [];
  try {
    return z.array(EntrySchema).parse(readJson<unknown>(file, '素材来源记录'));
  } catch {
    throw new HttpError(500, '素材来源记录已损坏（credits.json 无法读取），请重新出片');
  }
}

export interface CreditMark { action: CreditAction; at: number }

const MarksSchema = z.record(z.object({ action: z.enum(CREDIT_ACTIONS), at: z.number() }));

/** 标记文件坏了当作没有（标记丢了可以重标，不为它挡住面板），但留一行告警 */
export function readMarks(versionDir: string): Record<string, CreditMark> {
  const file = join(versionDir, MARKS_FILE);
  if (!existsSync(file)) return {};
  try {
    return MarksSchema.parse(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    console.warn(`素材处理标记文件已损坏，按没有标记处理：${file}`);
    return {};
  }
}

export const writeMark = (versionDir: string, file: string, action: CreditAction, now: number = Date.now()): Record<string, CreditMark> => {
  const next = { ...readMarks(versionDir), [file]: { action, at: now } };
  writeJsonAtomic(join(versionDir, MARKS_FILE), next);
  return next;
};

const VIDEO_RE = /\.(mp4|mov|m4v|webm|ogv)$/i;

/** 面板用的一条：只给文件名与缩略图地址，不含本机路径 */
export function publicEntry(e: CreditEntry, thumbBase: string, mark?: CreditMark, shotIndex?: number) {
  const file = basename(e.file);
  return {
    file, kind: VIDEO_RE.test(file) ? 'video' : 'image', source: e.source, page: e.page,
    ...(e.author ? { author: e.author } : {}), ...(e.authorUrl ? { authorUrl: e.authorUrl } : {}),
    license: e.license, ...(e.licenseUrl ? { licenseUrl: e.licenseUrl } : {}),
    attributionRequired: e.attributionRequired, aiGenerated: e.aiGenerated, modified: e.modified, query: e.query,
    thumb: `${thumbBase}/${encodeURIComponent(file)}/thumb`,
    ...(mark ? { mark: mark.action } : {}),
    ...(shotIndex !== undefined ? { shotIndex } : {}),
  } as const;
}

type ShotMedia = { broll?: { file?: string }; card?: { props?: { image?: unknown; video?: unknown } } };

/** 版本状态里的镜头列表；读不到返回空 */
export function readShots(app: Pick<AppCtx, 'store'>, spaceId: string, n: number): ShotMedia[] {
  try {
    return readJson<{ storyboard?: { shots?: ShotMedia[] } }>(join(app.store.versionDir(spaceId, n), STATE_FILE), '版本状态').storyboard?.shots ?? [];
  } catch {
    return [];
  }
}

/** 这条素材用在第几个镜头（对照 shots[i].broll.file）；没用在镜头上返回 undefined */
export function shotIndexOf(shots: readonly ShotMedia[], entry: CreditEntry): number | undefined {
  const i = shots.findIndex((s) => s.broll?.file === entry.file);
  return i >= 0 ? i : undefined;
}

export const findEntry = (entries: readonly CreditEntry[], file: string): CreditEntry | undefined =>
  entries.find((e) => basename(e.file) === file);

/** 素材文件的实际位置：先版本目录，再项目 base 目录；记录里的路径越出这两处一律当作不存在 */
export function creditFilePath(app: Pick<AppCtx, 'store'>, spaceId: string, n: number, entry: CreditEntry): string | undefined {
  const roots = [app.store.versionDir(spaceId, n), app.store.baseDir(spaceId)];
  for (const root of roots) {
    const path = resolve(root, entry.file);
    if (isInside(root, path) && existsSync(path)) return path;
  }
  return undefined;
}

export const CREDITS_UNREADABLE = '素材来源记录读取失败，请在素材来源面板检查署名';

/** 成片里有没有外部素材：镜头带 B-roll 文件，或卡片引用了图片 / 视频 */
const usesMedia = (shots: readonly ShotMedia[]): boolean =>
  shots.some((s) => typeof s.broll?.file === 'string' || typeof s.card?.props?.image === 'string' || typeof s.card?.props?.video === 'string');

export interface ExportCredits { attribution?: string; attributionError?: string }

/**
 * 导出时的署名文本。没有素材记录且成片也没用外部素材 → 什么都没有；
 * 记录损坏，或缺失但成片里有外部素材 → attributionError（前端必须显示警告，不能静默发布无署名的成片）
 */
export function exportCredits(app: Pick<AppCtx, 'store'>, spaceId: string, n: number): ExportCredits {
  const dir = app.store.versionDir(spaceId, n);
  if (!existsSync(join(dir, CREDITS_FILE))) return usesMedia(readShots(app, spaceId, n)) ? { attributionError: CREDITS_UNREADABLE } : {};
  try {
    const text = attributionText(readCredits(dir));
    return text ? { attribution: text } : {};
  } catch (err) {
    console.warn(`导出 v${n} 时读取素材来源记录失败：${err instanceof Error ? err.message : String(err)}`);
    return { attributionError: CREDITS_UNREADABLE };
  }
}
