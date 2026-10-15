import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { EditOp } from '../edit/plan.js';
import { JobQueue, type Job } from '../workspace/jobs.js';
import { FINAL_FILE } from '../workspace/runner.js';
import { defaultRunnerCtx, type AppCtx } from './context.js';
import { HttpError } from './http.js';
import { requireKey } from './keys.js';

export type RunAction = { kind: 'first' } | { kind: 'next'; parent: number; ops: EditOp[]; summary: string };
export interface RunState { state: 'queued' | 'running'; version: number }

/**
 * 把「开始出片 / 修改 / 回退」交给 JobQueue 串行执行。
 * Job 本身只携带项目与版本号（JobQueue 的 args 在这里用不上，填占位）；真正要做的事记在 pending 里。
 */
export class RunManager {
  private pending = new Map<string, { version: number; action: RunAction }>();
  private queue: JobQueue;
  private app!: AppCtx;

  constructor(bus: AppCtx['bus']) {
    this.queue = new JobQueue((job, signal) => this.execute(job, signal), bus);
  }

  attach(app: AppCtx): void {
    this.app = app;
  }

  /** 入队；返回新版本号（运行器按 max(n)+1 创建）与排队位置 */
  async submit(spaceId: string, action: RunAction): Promise<{ version: number; ahead: number }> {
    await requireKey(this.app);
    if (this.pending.has(spaceId)) throw new HttpError(409, '这个项目已有任务在排队或运行，请等它结束或先取消');
    const space = this.app.store.get(spaceId);
    const version = space.versions.reduce((max, v) => Math.max(max, v.n), 0) + 1;
    const job: Job = { spaceId, version, args: placeholderArgs(this.app, spaceId, version, space.inputs[0] ?? '') };
    this.pending.set(spaceId, { version, action });
    try {
      return { version, ahead: this.queue.enqueue(job) };
    } catch (err) {
      this.pending.delete(spaceId);
      throw err;
    }
  }

  state(spaceId: string): RunState | null {
    const p = this.pending.get(spaceId);
    if (!p) return null;
    return { state: this.queue.current()?.spaceId === spaceId ? 'running' : 'queued', version: p.version };
  }

  /**
   * 取消项目的任务。运行中的：运行器收到信号后把版本置 failed（已取消）。
   * 排队中的：还没建版本目录，只需清掉入队时写下的 queued/failed 事件，别污染以后同号的新版本。
   */
  cancel(spaceId: string): boolean {
    const p = this.pending.get(spaceId);
    const running = this.queue.current()?.spaceId === spaceId;
    if (!p || !this.queue.cancel(spaceId)) return false;
    if (!running) {
      this.pending.delete(spaceId);
      this.dropQueuedTrace(spaceId, p.version);
    }
    return true;
  }

  private dropQueuedTrace(spaceId: string, version: number): void {
    const exists = this.app.store.get(spaceId).versions.some((v) => v.n === version);
    if (!exists) rmSync(this.app.store.versionDir(spaceId, version), { recursive: true, force: true });
  }

  private async execute(job: Job, signal: AbortSignal): Promise<void> {
    const entry = this.pending.get(job.spaceId);
    try {
      if (!entry) throw new Error('任务已不存在');
      const key = await requireKey(this.app);
      const ctx = await defaultRunnerCtx(this.app, key, signal);
      const { deps } = this.app;
      if (entry.action.kind === 'first') await deps.runFirst(ctx, job.spaceId);
      else await deps.runNext(ctx, job.spaceId, entry.action.parent, entry.action.ops, entry.action.summary);
    } finally {
      this.pending.delete(job.spaceId);
    }
  }
}

/** JobQueue 要求的 args 占位：路径只是示意，真正的参数由运行器按项目自己组装 */
function placeholderArgs(app: AppCtx, spaceId: string, version: number, input: string): Job['args'] {
  const workDir = app.store.versionDir(spaceId, version);
  return { input, workDir, output: join(workDir, FINAL_FILE), cfg: app.cfg, llm: { chatJson: () => Promise.reject(new Error('占位客户端不应被调用')) } };
}
