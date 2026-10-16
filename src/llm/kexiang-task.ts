import { createWriteStream, renameSync, rmSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { EST_TASK_YUAN } from '../cost/constants.js';
import type { CostMeter } from '../cost/meter.js';
import { balanceErrorFrom, causeCode, networkReason, rethrowIfBalance, RETRY_BACKOFF_MS } from './errors.js';

export const KEXIANG_TASK_BASE = 'https://kexiangai.com/api/v1/user_task';
const FAILED = new Set(['failed', 'fail', 'error', 'cancelled']);
const SUCCEEDED = new Set(['success', 'succeeded', 'completed']);
/** 轮询连续失败的容忍次数，超过则放弃（任务可能仍在云端运行，但已付费，报错让调用方知情） */
const MAX_POLL_FAILURES = 3;

/** 这些错误码说明请求根本没送达服务器（没连上或没解析出地址），重新提交不会重复扣费 */
const NOT_DELIVERED_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

/** fetch 本身抛错（网络中断、超时），区别于服务器返回了非 2xx；notDelivered 表示可以确定请求没送达 */
class TaskNetworkError extends Error {
  constructor(message: string, readonly notDelivered: boolean) {
    super(message);
  }
}

export interface TaskInput { modelName: string; modelType: string; [key: string]: unknown }
export interface TaskResult { taskId: string; url: string; cost?: number }
export interface TaskRunOptions {
  kind: 'image' | 'video'; timeoutMs?: number; onStatus?: (status: string) => void;
  /** 记账时显示的用途说明，缺省用模型名 */
  label?: string;
  /** 接口没返回 cost 时按它记账，缺省按 kind 的预估单价（封面底图单价 ¥0.6 与普通生图不同） */
  estimateYuan?: number;
}
export interface TaskClient { run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> }

interface TaskQuery { task_status?: string; cost?: number | string; service_output?: { imgUrl?: string; videoUrl?: string; failReason?: string } }

/** 可想返回的 cost 可能是字符串（实测 "0.6"），统一转成数字；无法解析时不带 cost */
const costOf = (cost: number | string | undefined): { cost?: number } => {
  const n = cost === undefined ? NaN : Number(cost);
  return Number.isFinite(n) ? { cost: n } : {};
};

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 可想异步任务（生图/生视频）：套餐同一时间只能跑 1 个任务，所以全部经实例内的队列串行执行 */
export class KexiangTaskClient implements TaskClient {
  private readonly key: string;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly sleep = defaultSleep, private readonly pollMs = 5000, private readonly meter?: CostMeter) {
    if (!apiKey) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
    this.key = apiKey.replace(/^sk-/, '');
  }

  run(input: TaskInput, opts: TaskRunOptions): Promise<TaskResult> {
    const next = this.queue.then(() => this.runOnce(input, opts));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async runOnce(input: TaskInput, { kind, timeoutMs = 20 * 60_000, onStatus, label, estimateYuan }: TaskRunOptions): Promise<TaskResult> {
    const submitted = await this.submit(input);
    if (submitted.id == null) throw new Error(`可想任务提交失败：${JSON.stringify(submitted).slice(0, 200)}`);
    const taskId = String(submitted.id);
    let pollFailures = 0;
    for (let waited = 0; waited < timeoutMs; waited += this.pollMs) {
      await this.sleep(this.pollMs);
      let q: TaskQuery;
      try {
        q = await this.request<TaskQuery>(`${KEXIANG_TASK_BASE}/get/passAuth/${taskId}`);
        pollFailures = 0;
      } catch (err) {
        rethrowIfBalance(err);
        pollFailures += 1;
        if (pollFailures > MAX_POLL_FAILURES) throw new Error(`可想任务 ${taskId} 查询失败：${err instanceof Error ? err.message : String(err)}`);
        continue;
      }
      const out = q.service_output ?? {};
      const status = String(q.task_status ?? '').toLowerCase();
      if (out.failReason || FAILED.has(status)) throw new Error(`可想任务失败：${out.failReason ?? status}`);
      const url = kind === 'image' ? out.imgUrl : out.videoUrl;
      if (url) {
        const result = { taskId, url, ...costOf(q.cost) };
        this.charge(input.modelName, kind, result.cost, label, estimateYuan);
        return result;
      }
      if (SUCCEEDED.has(status)) throw new Error(`可想任务 ${taskId} 已完成但没有返回${kind === 'image' ? '图片' : '视频'}地址`);
      onStatus?.(status);
    }
    throw new Error(`可想任务 ${taskId} 等待超时（${Math.round(timeoutMs / 1000)} 秒）`);
  }

  /** 只在成功时记账；超时/失败的任务若云端仍扣费，这里不计入。没拿到 cost 时按预估价记，避免预算形同虚设 */
  private charge(model: string, kind: 'image' | 'video', cost: number | undefined, label?: string, estimateYuan?: number): void {
    if (cost === undefined) this.meter?.addTask(model, estimateYuan ?? EST_TASK_YUAN[kind], `${label ?? model}（按预估）`);
    else this.meter?.addTask(model, cost, label);
  }

  /**
   * 提交任务：只在确定请求没送达（没连上、域名解析失败）时重试；
   * 其他网络错误（超时、连接中断）请求可能已被受理，重试会重复扣费，直接报错
   */
  private async submit(input: TaskInput): Promise<{ id?: number | string | null }> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.request<{ id?: number | string | null }>(`${KEXIANG_TASK_BASE}/asyncCreateWithCost`, { method: 'POST', body: JSON.stringify({ user_input: input }) });
      } catch (err) {
        if (!(err instanceof TaskNetworkError) || !err.notDelivered || attempt >= RETRY_BACKOFF_MS.length) throw err;
        await this.sleep(RETRY_BACKOFF_MS[attempt]);
      }
    }
  }

  private async request<T>(url: string, init: RequestInit = {}): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, headers: { 'x-api-key': this.key, 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(60_000) });
    } catch (err) {
      const code = causeCode(err);
      throw new TaskNetworkError(`可想任务请求失败：${networkReason(err)}`, code !== undefined && NOT_DELIVERED_CODES.has(code));
    }
    const text = await res.text();
    if (!res.ok) throw balanceErrorFrom(res.status, text) ?? new Error(`可想任务请求失败 ${res.status}：${text.slice(0, 200)}`);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new Error(`可想任务返回的不是 JSON：${text.slice(0, 200)}`);
    }
  }
}

const protocolOf = (url: string): string => { try { return new URL(url).protocol; } catch { return ''; } };

/** 先写 <dest>.part，完整下载后再改名，避免中断留下半截文件 */
export async function downloadTo(url: string, dest: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  // 任务结果里的地址来自远程接口：只收 http(s)，拒绝 file:、data: 等协议
  if (!/^https?:$/.test(protocolOf(url))) throw new Error(`下载地址不是 http(s) 网址，已拒绝：${url.slice(0, 120)}`);
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(5 * 60_000) });
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}：${url}`);
  const part = `${dest}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
    renameSync(part, dest);
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
}
