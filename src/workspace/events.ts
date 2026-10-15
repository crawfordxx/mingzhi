import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineStep, ProgressEvent } from '../pipeline/run.js';

/** 推给浏览器与落盘的事件；detail 的形状见 src/pipeline/detail.ts */
export interface WorkEvent {
  /** 毫秒时间戳 */
  t: number;
  spaceId: string;
  version: number;
  step: PipelineStep | 'queued' | 'failed';
  message: string;
  detail?: { kind: string; data: unknown };
}

const EVENTS_FILE = 'events.jsonl';

/** 流程进度事件 → 工作台事件（补项目、版本与时间；没有明细时不带 detail 字段） */
export function toWorkEvent(spaceId: string, version: number, e: ProgressEvent, t: number = Date.now()): WorkEvent {
  return { t, spaceId, version, step: e.step, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
}

/**
 * 事件总线：按项目广播给订阅者，并追加写到版本目录的 events.jsonl，供「剪辑直播」重播。
 * 版本目录由构造参数给出（一般是 SpaceStore.versionDir）。
 */
export class EventBus {
  private subscribers = new Map<string, readonly ((e: WorkEvent) => void)[]>();

  constructor(private readonly versionDir: (spaceId: string, version: number) => string) {}

  publish(e: WorkEvent): void {
    this.persist(e);
    for (const fn of this.subscribers.get(e.spaceId) ?? []) {
      try {
        fn(e);
      } catch (err) {
        console.warn(`事件订阅者出错（已忽略，不影响其他订阅者）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  /** 订阅某个项目的事件；返回退订函数 */
  subscribe(spaceId: string, fn: (e: WorkEvent) => void): () => void {
    this.subscribers = new Map(this.subscribers).set(spaceId, [...(this.subscribers.get(spaceId) ?? []), fn]);
    return () => {
      const rest = (this.subscribers.get(spaceId) ?? []).filter((f) => f !== fn);
      const next = new Map(this.subscribers);
      if (rest.length > 0) next.set(spaceId, rest);
      else next.delete(spaceId);
      this.subscribers = next;
    };
  }

  /** 读回某个版本已落盘的全部事件；没有文件返回空，写到一半的坏行跳过 */
  history(spaceId: string, version: number): WorkEvent[] {
    const file = join(this.versionDir(spaceId, version), EVENTS_FILE);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf8').split('\n').flatMap((line) => {
      if (!line.trim()) return [];
      try {
        return [JSON.parse(line) as WorkEvent];
      } catch {
        return [];
      }
    });
  }

  /** 落盘失败只告警：写不进磁盘不能把出片流程带崩，浏览器仍能实时收到 */
  private persist(e: WorkEvent): void {
    try {
      const dir = this.versionDir(e.spaceId, e.version);
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, EVENTS_FILE), `${JSON.stringify(e)}\n`);
    } catch (err) {
      console.warn(`事件写入 events.jsonl 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
