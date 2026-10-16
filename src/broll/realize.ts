import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { BrollBudget } from './budget.js';
import { EST_YUAN } from './budget.js';
import { readAssetMeta, writeAssetMeta, type AssetMeta } from './credit-store.js';
import { planCrop, type Cover, type Point, type Size } from './crop.js';
import { fetchOriginal } from './fetch-original.js';
import { coverFor, TARGETS } from './gather.js';
import type { Beat } from './plan.js';
import { processAsset, UnusableAssetError, type ProcessContext, type ProcessInput, type ProcessResult } from './process.js';
import { chooseUnique, locateFocal, stillHasher, type CandidateScore, type PickedState } from './select.js';
import type { Candidate } from './sources/types.js';
import { stillOf } from './still-fetch.js';

/** 一个 beat 处理时的环境（测试可替换 process 与 hashOf） */
export interface BeatEnv {
  workDir: string;
  ffmpeg: string;
  lut: string;
  llm: LlmClient;
  budget: BrollBudget;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  whiteBalance?: { r: number; g: number; b: number };
  process?: (input: ProcessInput, out: string, ctx: ProcessContext) => Promise<ProcessResult>;
  hashOf?: (c: Candidate) => Promise<bigint | null>;
}

/** 加工好、可以放进镜头的素材 */
export interface RealizedAsset { file: string; meta: AssetMeta }

/** 一个候选最多换几次（下载失败、选段不可用都换下一个） */
const MAX_TRIES = 3;
const BROLL_DIR = 'broll';
const SRC_DIR = join(BROLL_DIR, 'src');
const STILLS_DIR = join(BROLL_DIR, 'stills');
const CENTER: Point = { x: 0.5, y: 0.5 };

const short = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);
export const stillsDirOf = (workDir: string): string => join(workDir, STILLS_DIR);
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function extOf(c: Candidate): string {
  const m = /\.(jpe?g|png|webp|mp4|webm|mov|ogv|m4v)(\?|$)/i.exec(c.url);
  if (m) return m[1].toLowerCase();
  return c.kind === 'video' ? 'mp4' : 'jpg';
}

/** 加工产物的相对路径：同一候选、同一呈现方式得到同一文件（缓存命中、各版本共用） */
export const assetFileOf = (c: Candidate, present: Beat['present']): string =>
  `${BROLL_DIR}/b${short(`${c.id}|${present}`)}.${c.kind === 'video' ? 'mp4' : 'jpg'}`;

/** 原文件：截图与生图已在本地，图库素材下载到 broll/src */
async function rawFile(env: BeatEnv, c: Candidate): Promise<{ file: string; size: Size }> {
  if (c.source === 'screenshot' || c.source === 'generated') return { file: c.url, size: { width: c.width, height: c.height } };
  const file = join(env.workDir, SRC_DIR, `${short(c.id)}.${extOf(c)}`);
  mkdirSync(join(env.workDir, SRC_DIR), { recursive: true });
  return { file, size: await fetchOriginal(c, file, env.fetchImpl, env.signal) };
}

/** 截图的取景：页面上部的标题区 */
const PAGE_TOP: Point = { x: 0.5, y: 0.25 };

/** 主体位置：生图按提示词构图（居中），截图取标题区，其余对单张图问一次模型；预算不够也用中心 */
async function focalOf(env: BeatEnv, c: Candidate, file: string): Promise<Point> {
  if (c.source === 'screenshot') return PAGE_TOP;
  if (c.source === 'generated' || !env.budget.canAfford(EST_YUAN.focal)) return CENTER;
  const image = c.kind === 'video' ? await stillOf(c, stillsDirOf(env.workDir), env.ffmpeg, env.fetchImpl, env.signal) : file;
  return (await locateFocal(env.llm, image)).focal;
}

/** 源画面里的主体位置换算到加工后画面里（裁切后主体不一定在原比例位置） */
export function mapFocal(src: Size, focal: Point, target: Size, cover?: Cover): Point {
  const { crop } = planCrop(src, focal, target, cover);
  const clamp = (v: number): number => Math.round(Math.min(1, Math.max(0, v)) * 1000) / 1000;
  return { x: clamp((focal.x * src.width - crop.x) / crop.width), y: clamp((focal.y * src.height - crop.y) / crop.height) };
}

function creditOf(c: Candidate, beat: Beat, file: string, modified: string[]): AssetMeta['credit'] {
  return {
    file, source: c.source, page: c.page, ...(c.author ? { author: c.author } : {}), ...(c.authorUrl ? { authorUrl: c.authorUrl } : {}),
    license: c.license, ...(c.licenseUrl ? { licenseUrl: c.licenseUrl } : {}), attributionRequired: c.attributionRequired, aiGenerated: c.aiGenerated,
    modified, query: beat.queryEn[0] ?? beat.subject, fetchedAt: new Date().toISOString(),
  };
}

const hex = (h: bigint | null): Pick<AssetMeta, 'hash'> => (h === null ? {} : { hash: h.toString(16).padStart(16, '0') });

/** 下载、定位主体、加工一个候选；已加工过（文件与记录都在）直接复用 */
export async function realizeCandidate(env: BeatEnv, beat: Beat, c: Candidate, hash: bigint | null): Promise<RealizedAsset> {
  const file = assetFileOf(c, beat.present);
  const cached = readAssetMeta(env.workDir, file);
  if (cached && existsSync(join(env.workDir, file))) return { file, meta: cached };
  const raw = await rawFile(env, c);
  const focal = await focalOf(env, c, raw.file);
  const target = TARGETS[beat.present];
  const wantSec = Math.min(4, Math.max(2, beat.end - beat.start));
  const cover = coverFor(beat.present, raw.size);
  const input: ProcessInput = { file: raw.file, kind: c.kind, focal, target, wantSec, cover, ...(c.fps ? { fps: c.fps } : {}), ...(c.durationSec ? { durationSec: c.durationSec } : {}) };
  const ctx: ProcessContext = { ffmpeg: env.ffmpeg, lut: env.lut, ...(env.whiteBalance ? { whiteBalance: env.whiteBalance } : {}) };
  const done = await (env.process ?? processAsset)(input, join(env.workDir, file), ctx);
  const outTarget = done.downgrade === 'split' ? { width: target.width, height: target.height / 2 } : target;
  const meta: AssetMeta = {
    credit: creditOf(c, beat, file, done.modified), candidateId: c.id, kind: c.kind,
    focal: done.downgrade === 'pip' ? focal : mapFocal(raw.size, focal, outTarget, done.downgrade === 'split' ? { full: cover.split, split: cover.split } : cover),
    ...(done.durationSec ? { durationSec: done.durationSec } : {}), ...(done.downgrade ? { downgrade: done.downgrade } : {}), ...hex(hash),
  };
  writeAssetMeta(env.workDir, file, meta);
  return { file, meta };
}

export interface Realized { asset?: RealizedAsset; state: PickedState; failures: string[] }

/** 新选中的哈希：chooseUnique 选中后把它追加在 hashes 末尾（纯色画面不追加） */
const newHash = (before: PickedState, after: PickedState): bigint | null => (after.hashes.length > before.hashes.length ? after.hashes[after.hashes.length - 1] : null);

/**
 * 按分数从高到低挑「没用过、不重复」的候选并加工；下载失败或选段不可用（UnusableAssetError）换下一个，最多 3 个。
 * 返回新的全片已选状态（失败的候选不算用过）。余额不足与取消原样抛出
 */
export async function realizeBest(env: BeatEnv, beat: Beat, candidates: readonly Candidate[], scores: readonly CandidateScore[], state: PickedState): Promise<Realized> {
  const hashOf = env.hashOf ?? stillHasher(stillsDirOf(env.workDir), env.ffmpeg, env.fetchImpl, env.signal);
  const failed: string[] = [];
  const failures: string[] = [];
  for (let i = 0; i < MAX_TRIES; i += 1) {
    throwIfCancelled(env.signal);
    const trial: PickedState = { usedIds: [...state.usedIds, ...failed], hashes: state.hashes };
    const choice = await chooseUnique({ candidates, scores, state: trial, hashOf });
    if (!choice.pick) break;
    const c = choice.pick.candidate;
    try {
      const asset = await realizeCandidate(env, beat, c, newHash(trial, choice.state));
      return { asset, state: { usedIds: choice.state.usedIds.filter((id) => !failed.includes(id)), hashes: choice.state.hashes }, failures };
    } catch (err) {
      rethrowIfBalance(err);
      rethrowIfCancelled(err);
      if (env.signal?.aborted) throw err;
      failed.push(c.id);
      failures.push(`${c.id}：${err instanceof UnusableAssetError ? '素材不可用' : '加工失败'}（${reason(err).slice(0, 120)}）`);
    }
  }
  return { state, failures };
}
