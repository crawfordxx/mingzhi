import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Storyboard } from '../storyboard/schema.js';
import { writeCredits, type CreditEntry } from './credits.js';

/**
 * 每个加工好的素材旁边放一份记录（同名 .json）：授权信息、主体位置、来源候选 id 与画面哈希。
 * 素材按内容命中缓存、被多个版本共用，授权记录跟着文件走；credits.json 由分镜里实际用到的文件汇总而来
 */
export interface AssetMeta {
  credit: CreditEntry;
  /** 候选 id（来源:原始 id），全片去重用 */
  candidateId: string;
  kind: 'video' | 'photo';
  /** 加工后画面里的主体位置（0–1） */
  focal: { x: number; y: number };
  durationSec?: number;
  downgrade?: 'split' | 'pip';
  /** 去重哈希（十六进制）；纯色等无法判重的画面没有 */
  hash?: string;
}

const metaPath = (workDir: string, file: string): string => join(workDir, `${file}.json`);

export function writeAssetMeta(workDir: string, file: string, meta: AssetMeta): void {
  const path = metaPath(workDir, file);
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(meta, null, 2)}\n`);
  renameSync(tmp, path);
}

/** 读素材记录；没有或损坏时返回 undefined（旧项目的素材没有记录） */
export function readAssetMeta(workDir: string, file: string): AssetMeta | undefined {
  const path = metaPath(workDir, file);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as AssetMeta;
  } catch {
    return undefined;
  }
}

/** 分镜里用到的全部素材文件：卡片的 image / video 与镜头的 B-roll，去重保序 */
export function storyboardFiles(storyboard: Storyboard): string[] {
  const files = storyboard.shots.flatMap((s) => {
    const p = (s.card?.props ?? {}) as { image?: unknown; video?: unknown };
    return [p.image, p.video, s.broll?.file].filter((f): f is string => typeof f === 'string');
  });
  return [...new Set(files)];
}

/** 分镜里用到的素材的授权记录（没有记录的文件跳过） */
export function creditsOf(storyboard: Storyboard, workDir: string): CreditEntry[] {
  return storyboardFiles(storyboard).flatMap((f) => {
    const meta = readAssetMeta(workDir, f);
    return meta ? [{ ...meta.credit, file: f }] : [];
  });
}

/** 把分镜用到的素材授权记录写成 outDir/credits.json（素材记录在 workDir 里） */
export function writeStoryboardCredits(storyboard: Storyboard, workDir: string, outDir: string): string {
  return writeCredits(outDir, creditsOf(storyboard, workDir));
}

/** 全片已用的候选 id 与哈希（重做单个镜头时排除它们，保证不复用） */
export function usedOf(storyboard: Storyboard, workDir: string): { ids: string[]; hashes: bigint[] } {
  const metas = storyboardFiles(storyboard).flatMap((f) => { const m = readAssetMeta(workDir, f); return m ? [m] : []; });
  return { ids: metas.map((m) => m.candidateId), hashes: metas.flatMap((m) => (m.hash ? [BigInt(`0x${m.hash}`)] : [])) };
}
