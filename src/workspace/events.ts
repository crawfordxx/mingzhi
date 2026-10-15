import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { PipelineStep, ProgressEvent } from '../pipeline/run.js';

/** 推给浏览器与落盘的事件；detail 的形状见 src/pipeline/detail.ts */
export interface WorkEvent {
  /** 序号：每个项目+版本内从 1 起单调递增（落盘与回放都带），SSE 先补历史再推实时时按它去重 */
  seq: number;
  /** 毫秒时间戳 */
  t: number;
  spaceId: string;
  version: number;
  step: PipelineStep | 'queued' | 'failed';
  message: string;
  detail?: { kind: string; data: unknown };
}

/** 发布时的事件：seq 由 EventBus 分配 */
export type WorkEventInput = Omit<WorkEvent, 'seq'>;

const EVENTS_FILE = 'events.jsonl';

/** 流程进度事件 → 工作台事件（补项目、版本与时间；没有明细时不带 detail 字段） */
export function toWorkEvent(spaceId: string, version: number, e: ProgressEvent, t: number = Date.now()): WorkEventInput {
  return { t, spaceId, version, step: e.step, message: e.message, ...(e.detail ? { detail: e.detail } : {}) };
}

/** 一行 JSON → 事件；不是对象或缺少必要字段（step、message 为字符串）时返回 undefined */
function parseLine(line: string): WorkEvent | undefined {
  try {
    const v = JSON.parse(line) as Partial<WorkEvent> | null;
    return v && typeof v === 'object' && typeof v.step === 'string' && typeof v.message === 'string' ? (v as WorkEvent) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 事件总线：按项目广播给订阅者，并追加写到版本目录的 events.jsonl，供「剪辑直播」重播。
 * 版本目录由构造参数给出（一般是 SpaceStore.versionDir）。
 */
export class EventBus {
  private subscribers = new Map<string, readonly ((e: WorkEvent) => void)[]>();
  /** 各「项目+版本」最近一次的序号；第一次发布时从已落盘的事件续上，服务重启后序号不回头 */
  private lastSeq = new Map<string, number>();
  /** 已检查过末尾换行的事件文件（每个文件每个进程只检查一次） */
  private tailChecked: ReadonlySet<string> = new Set();

  constructor(private readonly versionDir: (spaceId: string, version: number) => string) {}

  /** 分配序号、落盘并广播；返回带序号的事件 */
  publish(input: WorkEventInput): WorkEvent {
    const e: WorkEvent = { ...input, seq: this.nextSeq(input.spaceId, input.version) };
    this.persist(e);
    for (const fn of this.subscribers.get(e.spaceId) ?? []) {
      try {
        fn(e);
      } catch (err) {
        console.warn(`事件订阅者出错（已忽略，不影响其他订阅者）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return e;
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

  /** 读回某个版本已落盘的全部事件（都带 seq）；没有文件返回空，写到一半或格式不对的行跳过并告警 */
  history(spaceId: string, version: number): WorkEvent[] {
    const file = join(this.versionDir(spaceId, version), EVENTS_FILE);
    if (!existsSync(file)) return [];
    const events = readFileSync(file, 'utf8').split('\n').flatMap((line, i) => {
      if (!line.trim()) return [];
      const parsed = parseLine(line);
      if (!parsed) console.warn(`${file} 第 ${i + 1} 行不是有效事件，已跳过`);
      return parsed ? [parsed] : [];
    });
    return events.map((e, i) => (typeof e.seq === 'number' ? e : { ...e, seq: i + 1 }));
  }

  /** 读不到（目录非法、文件不可读）按 0 起，落盘失败本来就只告警 */
  private lastPersistedSeq(spaceId: string, version: number): number {
    try {
      return this.history(spaceId, version).reduce((max, e) => Math.max(max, e.seq), 0);
    } catch {
      return 0;
    }
  }

  private nextSeq(spaceId: string, version: number): number {
    const key = `${spaceId}/${version}`;
    const last = this.lastSeq.get(key) ?? this.lastPersistedSeq(spaceId, version);
    this.lastSeq = new Map(this.lastSeq).set(key, last + 1);
    return last + 1;
  }

  /** 落盘失败只告警：写不进磁盘不能把出片流程带崩，浏览器仍能实时收到 */
  private persist(e: WorkEvent): void {
    try {
      const dir = this.versionDir(e.spaceId, e.version);
      mkdirSync(dir, { recursive: true });
      const file = join(dir, EVENTS_FILE);
      this.terminateTail(file);
      appendFileSync(file, `${JSON.stringify(e)}\n`);
    } catch (err) {
      console.warn(`事件写入 events.jsonl 失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 进程曾被杀在写到一半时，文件末行没有换行；先补一个换行，让残行单独成行、不吞掉下一条事件 */
  private terminateTail(file: string): void {
    if (this.tailChecked.has(file)) return;
    if (existsSync(file) && statSync(file).size > 0) {
      const fd = openSync(file, 'r');
      try {
        const last = Buffer.alloc(1);
        readSync(fd, last, 0, 1, statSync(file).size - 1);
        if (last[0] !== 0x0a) appendFileSync(file, '\n');
      } finally {
        closeSync(fd);
      }
    }
    this.tailChecked = new Set([...this.tailChecked, file]);
  }
}
