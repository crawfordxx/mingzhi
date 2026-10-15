import type { PipelineArgs } from '../pipeline/run.js';
import type { EventBus } from './events.js';

/** 一次出片任务：哪个项目的哪个版本，以及 runPipeline 所需参数（进度回调与取消信号由执行者补上） */
export interface Job {
  spaceId: string;
  version: number;
  args: Omit<PipelineArgs, 'onProgress' | 'signal'>;
}

const CANCELLED = '已取消';

interface Running { job: Job; controller: AbortController }

/**
 * 出片任务队列：同一时间只跑一个任务，其余按序排队；一个任务失败不影响后续任务。
 * 一个项目同时只允许一个任务（排队或运行中），所以取消用 spaceId 定位。
 * 传入 bus 时，排队会发布 queued 事件、失败（含取消）会发布 failed 事件。
 */
export class JobQueue {
  private waiting: readonly Job[] = [];
  private running: Running | null = null;

  constructor(
    private readonly run: (job: Job, signal: AbortSignal) => Promise<void>,
    private readonly bus?: EventBus,
  ) {}

  /** 入队；返回排队位置：0 表示马上开始，n 表示前面还有 n 个任务 */
  enqueue(job: Job): number {
    if (this.has(job.spaceId)) throw new Error(`项目 ${job.spaceId} 已有任务在排队或运行`);
    const ahead = this.waiting.length + (this.running ? 1 : 0);
    this.waiting = [...this.waiting, job];
    if (ahead > 0) this.emit(job, 'queued', `排队中，前面还有 ${ahead} 个任务`);
    void this.pump();
    return ahead;
  }

  current(): Job | null {
    return this.running?.job ?? null;
  }

  /** 取消某个项目的任务：运行中的触发 AbortSignal，排队中的直接移出；没有该项目的任务返回 false */
  cancel(spaceId: string): boolean {
    if (this.running?.job.spaceId === spaceId) {
      this.running.controller.abort();
      return true;
    }
    const queued = this.waiting.find((j) => j.spaceId === spaceId);
    if (!queued) return false;
    this.waiting = this.waiting.filter((j) => j !== queued);
    this.emit(queued, 'failed', CANCELLED);
    return true;
  }

  private has(spaceId: string): boolean {
    return this.running?.job.spaceId === spaceId || this.waiting.some((j) => j.spaceId === spaceId);
  }

  private async pump(): Promise<void> {
    if (this.running || this.waiting.length === 0) return;
    const [job, ...rest] = this.waiting;
    this.waiting = rest;
    const controller = new AbortController();
    this.running = { job, controller };
    try {
      await this.run(job, controller.signal);
    } catch (err) {
      const message = controller.signal.aborted ? CANCELLED : err instanceof Error ? err.message : String(err);
      this.emit(job, 'failed', message);
    } finally {
      this.running = null;
      void this.pump();
    }
  }

  private emit(job: Job, step: 'queued' | 'failed', message: string): void {
    this.bus?.publish({ t: Date.now(), spaceId: job.spaceId, version: job.version, step, message });
  }
}
