/**
 * 命令行收尾：完成提示、封面缺失警告与退出码。
 *
 * 退出码约定：
 * - 0：成片已生成。即使封面没生成（余额不足、预算不足、生图失败）也是 0——封面是可选产物，成片可以直接用；
 *   用非 0 会让脚本（`... && 上传`）把完整的成片当失败，用户也会像验收里那样以为整条白跑。封面缺失在 stderr 打警告并写明补救命令
 * - 1：没有交付成片（任何一步出错、被取消）；`--cover-only` 补封面又失败也是 1（补封面是那次运行唯一要做的事）
 */

/** 成片成功但封面没生成时的退出码 */
export const EXIT_COVER_MISSING = 0;

export interface DoneInput {
  cuts: number; finalSec: number; shots: number; secs: number; spent: number; budget: number;
  output: string; workDir: string;
  /** 自检摘要（多行）；跳过自检时缺省 */
  qaText?: string;
  /** 封面没生成的原因 */
  coverMissing?: string;
}
export interface DoneReport { text: string; warning?: string }

/** 补封面的命令提示：余额不足时先充值，其余原因先排除再补 */
function coverWarning(reason: string, workDir: string): string {
  const when = reason.includes('余额不足') ? '充值后' : '排除原因后';
  return `封面未生成：${reason}；${when}可用 \`pnpm mingzhi edit <口播视频> --cover-only --work ${workDir}\` 只补封面`;
}

/** 完成提示（stdout，最后一行是成片路径）与封面缺失警告（stderr） */
export function doneReport(i: DoneInput): DoneReport {
  const head = `完成：删除 ${i.cuts} 处 · 成片 ${i.finalSec.toFixed(1)} 秒 · ${i.shots} 个镜头 · 用时 ${i.secs} 秒 · 花费 ¥${i.spent.toFixed(2)}（上限 ¥${i.budget.toFixed(2)}）`;
  const text = `\n${[head, ...(i.qaText ? [i.qaText] : []), i.output].join('\n')}`;
  return { text, ...(i.coverMissing ? { warning: coverWarning(i.coverMissing, i.workDir) } : {}) };
}

/** 退出码：见文件头约定 */
export function exitCodeOf(r: DoneReport, o: { coverOnly?: boolean } = {}): number {
  if (!r.warning) return 0;
  return o.coverOnly ? 1 : EXIT_COVER_MISSING;
}
