import { createWriteStream, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const KEXIANG_TASK_BASE = 'https://kexiangai.com/api/v1/user_task';
const FAILED = new Set(['failed', 'fail', 'error', 'cancelled']);
const SUCCEEDED = new Set(['success', 'succeeded', 'completed']);
/** 轮询连续失败的容忍次数，超过则放弃（任务可能仍在云端运行，但已付费，报错让调用方知情） */
const MAX_POLL_FAILURES = 3;

export interface TaskInput { modelName: string; modelType: string; [key: string]: unknown }
export interface TaskResult { taskId: string; url: string; cost?: number }
export interface TaskRunOptions { kind: 'image' | 'video'; timeoutMs?: number; onStatus?: (status: string) => void }
export interface TaskClient { run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> }

interface TaskQuery { task_status?: string; cost?: number; service_output?: { imgUrl?: string; videoUrl?: string; failReason?: string } }

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 可想异步任务（生图/生视频）：套餐同一时间只能跑 1 个任务，所以全部经实例内的队列串行执行 */
export class KexiangTaskClient implements TaskClient {
  private readonly key: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly sleep = defaultSleep, private readonly pollMs = 5000) {
    if (!apiKey) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
    this.key = apiKey.replace(/^sk-/, '');
  }

  run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> {
    const next = this.queue.then(() => this.runOnce(input, opts));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOnce(input: TaskInput, { kind, timeoutMs = 20 * 60_000, onStatus }: TaskRunOptions): Promise<TaskResult> {
    const submitted = await this.request<{ id?: number | string }>(`${KEXIANG_TASK_BASE}/asyncCreateWithCost`, { method: 'POST', body: JSON.stringify({ user_input: input }) });
    if (submitted.id === undefined) throw new Error(`可想任务提交失败：${JSON.stringify(submitted).slice(0, 200)}`);
    const taskId = String(submitted.id);
    let pollFailures = 0;
    for (let waited = 0; waited < timeoutMs; waited += this.pollMs) {
      await this.sleep(this.pollMs);
      let q: TaskQuery;
      try {
        q = await this.request<TaskQuery>(`${KEXIANG_TASK_BASE}/get/passAuth/${taskId}`);
        pollFailures = 0;
      } catch (err) {
        pollFailures += 1;
        if (pollFailures > MAX_POLL_FAILURES) throw new Error(`可想任务 ${taskId} 查询失败：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const out = q.service_output ?? {};
      const status = String(q.task_status ?? '').toLowerCase();
      if (out.failReason || FAILED.has(status)) throw new Error(`可想任务失败：${out.failReason ?? status}`);
      const url = kind === 'image' ? out.imgUrl : out.videoUrl;
      if (url) return { taskId, url, ...(q.cost !== undefined ? { cost: q.cost } : {}) };
      if (SUCCEEDED.has(status)) throw new Error(`可想任务 ${taskId} 已完成但没有返回${kind === 'image' ? '图片' : '视频'}地址`);
      onStatus?.(status);
    }
    throw new Error(`可想任务 ${taskId} 等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.fetchImpl(url, { ...init, headers: { 'x-api-key': this.key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    const text = await res.text();
    if (!res.ok) throw new Error(`可想任务请求失败 ${res.status}：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`可想任务返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }
}

/** 先写 <dest>.part，完整下载后再改名，避免中断留下半截文件 */
export async function downloadTo(url: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}：${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  renameSync(part, dest);
}
