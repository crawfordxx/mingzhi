/** 工作台的全局偏好（不属于某个项目）：目前只有「检查更新」开关，存在数据目录的 prefs.json */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { HttpError } from './http.js';

export const PREFS_FILE = 'prefs.json';

const Prefs = z.object({ checkUpdates: z.boolean() });
export type Prefs = z.infer<typeof Prefs>;
const PrefsPatch = Prefs.partial().strict();

export const DEFAULT_PREFS: Prefs = { checkUpdates: true };

/** 读不到或内容不对时用默认值（默认开着检查更新） */
export function readPrefs(dataDir: string): Prefs {
  try {
    const parsed = Prefs.partial().safeParse(JSON.parse(readFileSync(join(dataDir, PREFS_FILE), 'utf8')));
    return parsed.success ? { ...DEFAULT_PREFS, ...parsed.data } : DEFAULT_PREFS;
  } catch {
    return DEFAULT_PREFS;
  }
}

export function writePrefs(dataDir: string, raw: unknown): Prefs {
  const parsed = PrefsPatch.safeParse(raw);
  if (!parsed.success) throw new HttpError(400, '设置参数不对');
  const next = { ...readPrefs(dataDir), ...parsed.data };
  writeFileSync(join(dataDir, PREFS_FILE), JSON.stringify(next));
  return next;
}
