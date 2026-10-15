import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import type { Transcript } from '../asr/types.js';
import type { Cut } from '../cut/llm-cuts.js';
import type { Rgb, SubjectBox } from '../matting/composite.js';
import type { MediaInfo } from '../media/probe.js';
import type { Storyboard } from '../storyboard/schema.js';

/** 版本目录里的成片文件名（工作台播放与导出都用它） */
export const FINAL_FILE = 'final.mp4';
/** 版本目录里的版本状态；最后才写，存在即表示这个版本已完整产出 */
export const STATE_FILE = 'state.json';
/** base/ 里与版本无关的分析结果（探测、识别、剪口误），修改版本重建剪辑方案时读它 */
export const ANALYSIS_FILE = 'analysis.json';
/** base/ 里整条原片的抠像图层：RVM 去溢色前景与灰度遮罩（30fps，与原片逐帧对应） */
export const LAYER_FILES = ['fgr.mp4', 'matte.mp4'] as const;
/** 与抠像图层配套的信息：取景框与人物平均色（换背景合成时重算调色增益）；最后写，存在即图层完整 */
export const MATTE_META = 'matte.json';
export const COVER_FILES = ['cover-3x4.png', 'cover-4x3.png'] as const;

export interface BaseAnalysis { media: MediaInfo; transcript: Transcript; cuts: Cut[] }
export interface MatteMeta { subject: SubjectBox | null; fgMean: Rgb | null; frames: number }

/** 先写临时文件再改名，读到的永远是完整 JSON */
export function writeJsonAtomic(path: string, data: unknown): void {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
}

export function readJson<T>(path: string, what: string): T {
  if (!existsSync(path)) throw new Error(`缺少${what}：${path}`);
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    throw new Error(`${what}已损坏：${path}`);
  }
}

/**
 * 把 src 引用到 dest：优先硬链接（不占空间），不支持时复制。
 * 安全前提：流程里改写已有文件都是「临时文件 + 改名」，从不原地改写，所以链接出去的文件不会被后来的版本改掉；
 * dest 已存在时先删掉这个目录项（只删链接，不截断它指向的文件），避免复制时写穿到别的版本。
 */
export function linkFile(src: string, dest: string): void {
  if (!existsSync(src)) throw new Error(`缺少上一版本的文件：${src}`);
  mkdirSync(dirname(dest), { recursive: true });
  rmSync(dest, { force: true });
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

/** src 存在才引用；返回是否引用了 */
export function linkIfExists(src: string, dest: string): boolean {
  if (!existsSync(src)) return false;
  linkFile(src, dest);
  return true;
}

/** 分镜里卡片引用的素材文件（相对路径） */
function mediaFiles(storyboard: Storyboard): string[] {
  return storyboard.shots.flatMap((s) => {
    const p = (s.card?.props ?? {}) as { image?: unknown; video?: unknown };
    return [p.image, p.video].filter((f): f is string => typeof f === 'string');
  });
}

/** 素材缓存在 base/broll（各版本共用、按需求内容命中）；渲染以版本目录为根，所以把用到的文件引用进版本目录。越出 base 的路径一律跳过 */
export function linkBroll(storyboard: Storyboard, base: string, dir: string): void {
  for (const rel of new Set(mediaFiles(storyboard))) {
    const clean = normalize(rel);
    if (!isInside(base, join(base, clean))) continue;
    const dest = join(dir, clean);
    if (!existsSync(dest)) linkIfExists(join(base, clean), dest);
  }
}

/** p 在 dir 之内（含子目录） */
export const isInside = (dir: string, p: string): boolean => {
  const rel = relative(dir, p);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};
