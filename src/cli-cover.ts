import type { AppConfig } from './config.js';
import { confirmRun } from './cost/confirm.js';
import type { CostMeter } from './cost/meter.js';
import type { LlmClient } from './llm/kexiang.js';
import type { TaskClient } from './llm/kexiang-task.js';
import { exitCodeOf, doneReport } from './cli-report.js';
import { coverOnlyEstimate, runCoverOnly } from './pipeline/cover-only.js';
import type { CoverOptions } from './pipeline/finish-step.js';
import type { ProgressEvent } from './pipeline/run.js';

export interface CoverCommand {
  workDir: string; output: string; cfg: AppConfig; llm: LlmClient; task?: TaskClient; meter: CostMeter; budgetYuan: number;
  cover: CoverOptions; yes: boolean; isTTY: boolean;
}

/** `--cover-only`：只补封面，成片不动。返回退出码（补成功 0，没补成 1） */
export async function coverOnlyCommand(c: CoverCommand): Promise<number> {
  if (!c.cover) throw new Error('--cover-only 与 --no-cover 不能一起用');
  if (!(await confirmRun({ estimate: coverOnlyEstimate(), budgetYuan: c.budgetYuan, yes: c.yes, isTTY: c.isTTY }))) {
    console.log('已取消，未花费任何费用');
    return 0;
  }
  const onProgress = (e: ProgressEvent): void => {
    if (e.detail?.kind !== 'cost') console.log(`[${e.step}] ${e.message}`);
  };
  const res = await runCoverOnly({ workDir: c.workDir, output: c.output, cfg: c.cfg, llm: c.llm, task: c.task, meter: c.meter, cover: c.cover, onProgress });
  console.log(`封面本次花费 ¥${c.meter.total.toFixed(2)}`);
  const report = doneReport({ cuts: 0, finalSec: 0, shots: 0, secs: 0, spent: c.meter.total, budget: c.budgetYuan, output: c.output, workDir: c.workDir, ...(res.missing ? { coverMissing: res.missing } : {}) });
  if (report.warning) console.error(report.warning);
  else console.log(`封面已补好，成片没有改动：${c.output}`);
  return exitCodeOf(report, { coverOnly: true });
}
