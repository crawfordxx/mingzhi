import type { Track } from '../assets/catalog.js';
import { loadTracks } from '../assets/catalog.js';
import { applyOp, type VersionState } from './apply.js';
import { checkOp } from './check.js';
import { buildEditContext } from './context.js';
import { EditOpSchema, type EditOp } from './ops.js';

export interface ValidatedOps { ops: EditOp[]; dropped: string[] }

const opName = (item: unknown): string => String((item as { type?: unknown } | null)?.type ?? '未知');

/**
 * 校验一批来自模型或 HTTP 请求体的操作：逐条过 zod、对照当前版本、再在运行中的状态上试应用（版式规则等在这里拦截），
 * 不合格的丢弃并记下中文原因，合格的按原顺序返回。后一条看到的是前面已通过操作的结果。
 */
export function validateOps(raw: unknown, state: VersionState, tracks: Track[] = loadTracks()): ValidatedOps {
  if (!Array.isArray(raw)) return { ops: [], dropped: ['操作列表格式不对'] };
  const init = { ops: [] as EditOp[], dropped: [] as string[], running: state };
  const { ops, dropped } = raw.reduce((acc, item) => {
    const drop = (why: string) => ({ ...acc, dropped: [...acc.dropped, `「${opName(item)}」${why}`] });
    const parsed = EditOpSchema.safeParse(item);
    if (!parsed.success) return drop(`参数不合法（${parsed.error.issues[0].path.join('.') || 'type'}）`);
    const problem = checkOp(parsed.data, buildEditContext(acc.running, '', tracks));
    if (problem) return drop(problem);
    try {
      return { ...acc, ops: [...acc.ops, parsed.data], running: applyOp(acc.running, parsed.data) };
    } catch (err) {
      return drop(err instanceof Error ? err.message : String(err));
    }
  }, init);
  return { ops, dropped };
}
