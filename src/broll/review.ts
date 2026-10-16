import { join } from 'node:path';
import { EST_YUAN } from './budget.js';
import { buildContactSheet } from './contact-sheet.js';
import type { Beat } from './plan.js';
import { stillsDirOf, type BeatEnv } from './realize.js';
import { scoreCandidates, type CandidateScore } from './select.js';
import type { Candidate } from './sources/types.js';

export interface Reviewed { candidates: Candidate[]; scores: CandidateScore[] }

/**
 * 审片：候选拼成联系表，一次视觉调用打分（取图失败的空格剔除）。没有候选返回空分数；预算不够时抛错（调用方按「跳过」处理）
 */
export async function reviewCandidates(env: BeatEnv, beat: Beat, candidates: readonly Candidate[], sheetName: string): Promise<Reviewed> {
  if (candidates.length === 0) return { candidates: [], scores: [] };
  if (!env.budget.canAfford(EST_YUAN.score)) throw new Error('B-roll 预算不足，跳过审片');
  const sheet = await buildContactSheet(candidates, join(env.workDir, 'broll', 'sheets', `${sheetName}.jpg`), env.ffmpeg, { fetchImpl: env.fetchImpl, stillsDir: stillsDirOf(env.workDir), ...(env.signal ? { signal: env.signal } : {}) });
  const placed = candidates.slice(0, sheet.count);
  const scores = await scoreCandidates(env.llm, beat, sheet.file, sheet.count, sheet.blanks.map((b) => b.index));
  return { candidates: placed, scores };
}
