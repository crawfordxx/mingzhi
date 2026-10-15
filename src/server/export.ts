import { copyFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { COVER_FILES, FINAL_FILE } from '../workspace/runner-files.js';

const MAX_TITLE_CHARS = 60;

/** 文件名里不能出现的字符换成下划线，去掉首尾的点与空白 */
export function safeTitle(title: string): string {
  const cleaned = title.replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_').replace(/^[.\s]+|[.\s]+$/g, '');
  return [...cleaned].slice(0, MAX_TITLE_CHARS).join('') || '成片';
}

const COVER_SUFFIX: Record<(typeof COVER_FILES)[number], string> = { 'cover-3x4.png': '封面3x4.png', 'cover-4x3.png': '封面4x3.png' };

async function copyAtomic(from: string, to: string): Promise<void> {
  const tmp = `${to}.tmp`;
  try {
    await copyFile(from, tmp);
    await rename(tmp, to);
  } finally {
    await rm(tmp, { force: true });
  }
}

/** 把成片与封面复制到 <exportDir>/<标题>-v<n>.mp4 等；封面不存在就跳过。返回写出的文件 */
export async function exportVersion(exportDir: string, title: string, n: number, versionDir: string): Promise<string[]> {
  const final = join(versionDir, FINAL_FILE);
  if (!existsSync(final)) throw new Error(`v${n} 的成片文件不存在`);
  await mkdir(exportDir, { recursive: true });
  const stem = `${safeTitle(title)}-v${n}`;
  const pairs: [string, string][] = [
    [final, join(exportDir, `${stem}.mp4`)],
    ...COVER_FILES.filter((c) => existsSync(join(versionDir, c))).map((c): [string, string] => [join(versionDir, c), join(exportDir, `${stem}-${COVER_SUFFIX[c]}`)]),
  ];
  for (const [from, to] of pairs) await copyAtomic(from, to);
  return pairs.map(([, to]) => to);
}
