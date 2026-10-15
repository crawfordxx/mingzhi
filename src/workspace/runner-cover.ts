import { copyFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { TimedCaption } from '../captions/lines.js';
import type { CoverStyleId } from '../cover/styles.js';
import { runCover } from '../pipeline/finish-step.js';
import type { ProjectArtifacts, ProjectPatch } from '../pipeline/project.js';
import type { PipelineArgs } from '../pipeline/run.js';
import type { Complete } from '../pipeline/stages.js';
import type { Storyboard } from '../storyboard/schema.js';
import type { VersionEnv } from './runner.js';
import { COVER_FILES } from './runner-files.js';

/**
 * 封面：在 base/covers/<风格>/ 里生成（已付费的底图按风格与标题缓存，换回用过的风格不再付费），
 * 成功后把两张封面复制进版本目录。用复制而不是硬链接：缓存目录里的封面下次会被原地重画。
 */
export async function makeCover(env: VersionEnv, args: PipelineArgs, style: CoverStyleId, storyboard: Storyboard, captions: TimedCaption[], person: string): Promise<void> {
  const workDir = join(env.base, 'covers', style);
  mkdirSync(workDir, { recursive: true });
  let made: ProjectArtifacts | undefined;
  const complete: Complete = (step, message, patch?: ProjectPatch) => {
    if (patch?.artifacts?.cover34) made = patch.artifacts;
    return env.complete(step, message, patch);
  };
  const ctx = { workDir, cfg: args.cfg, llm: args.llm, task: args.task, coverDeps: args.coverDeps, meter: env.meter };
  await runCover(ctx, { style }, storyboard, captions, person, complete);
  if (!made?.cover34 || !made.cover43) return;
  const [cover34, cover43] = COVER_FILES.map((f) => join(env.dir, f));
  copyFileSync(made.cover34, cover34);
  copyFileSync(made.cover43, cover43);
  env.record({ artifacts: { cover34, cover43 } });
}
