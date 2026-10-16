import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { COVER_HIGH_FACTOR, COVER_YUAN, type Estimate } from '../cost/estimate.js';
import { CostMeter, roundYuan } from '../cost/meter.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { runCover, type CoverDeps, type CoverOptions, type CoverResult } from './finish-step.js';
import { projectRecorder, type ProjectFile } from './project.js';
import { costsOf, makeComplete, type ProgressEvent } from './run.js';

export interface CoverOnlyArgs {
  /** 出过片的工作目录（里面要有 project.json、成片与分镜） */
  workDir: string;
  /** 成片路径；在工作目录之外时，封面会再复制一份到成片旁边（和完整流程一致） */
  output: string;
  cfg: AppConfig; llm: LlmClient; task?: TaskClient; meter: CostMeter;
  cover: Exclude<CoverOptions, false>;
  /** 仅供测试注入的封面实现 */
  coverDeps?: CoverDeps;
  onProgress?: (e: ProgressEvent) => void;
}

/** 只补封面的预估：只有封面一项 */
export function coverOnlyEstimate(): Estimate {
  const item = { label: '封面', low: COVER_YUAN, yuan: Math.round(COVER_YUAN * COVER_HIGH_FACTOR * 100) / 100 };
  return { low: item.low, high: item.yuan, items: [item] };
}

function readProject(workDir: string): ProjectFile {
  const path = join(workDir, 'project.json');
  if (!existsSync(path)) throw new Error(`工作目录 ${workDir} 里没有 project.json，请先完整跑一遍（pnpm mingzhi edit <口播视频> --work ${workDir}）`);
  return JSON.parse(readFileSync(path, 'utf8')) as ProjectFile;
}

/** 之前已花的账目并上这次封面的花费（项目的累计花费不因补封面而丢） */
const mergeCosts = (prev: ProjectFile['costs'], now: NonNullable<ProjectFile['costs']>): NonNullable<ProjectFile['costs']> =>
  prev ? { total: roundYuan(prev.total + now.total), budget: now.budget, entries: [...prev.entries, ...now.entries] } : now;

/**
 * 只补封面（`--cover-only`）：复用工作目录里的成片、分镜、字幕与人像视频，不重新识别、渲染或做任何其他付费步骤。
 * 成片文件一个字节都不动；封面生成后接着记进 project.json（保留原有的自检、账目等全部字段），失败时返回原因由调用方提示
 */
export async function runCoverOnly(args: CoverOnlyArgs): Promise<CoverResult> {
  const project = readProject(args.workDir);
  if (!project.storyboard) throw new Error('project.json 里没有分镜，无法生成封面，请先完整跑一遍');
  const film = project.artifacts.final ?? project.artifacts.output;
  if (!film || !existsSync(film)) throw new Error(`成片 ${film ?? '（project.json 没有记录）'} 不存在，请先完整跑一遍`);
  const person = project.artifacts.person ?? project.artifacts.cut;
  if (!person || !existsSync(person)) throw new Error('工作目录里没有人像视频（person.mp4 或 cut.mp4），无法生成封面，请先完整跑一遍');
  const rec = projectRecorder(join(args.workDir, 'project.json'), project.input, project);
  const record: typeof rec = (patch) => rec(patch.costs ? { ...patch, costs: mergeCosts(project.costs, patch.costs) } : patch);
  const complete = makeComplete({ record, meter: args.meter, onProgress: args.onProgress });
  const ctx = { workDir: args.workDir, output: args.output, cfg: args.cfg, llm: args.llm, task: args.task, coverDeps: args.coverDeps, meter: args.meter };
  const result = await runCover(ctx, args.cover, project.storyboard, project.captions ?? [], person, complete);
  rec({ costs: mergeCosts(project.costs, costsOf(args.meter)) });
  return result;
}
