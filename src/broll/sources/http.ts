import type { Candidate, SourceOptions } from './types.js';

const REQUEST_TIMEOUT_MS = 30_000;
/** 429 重试最多等这么久，更长的限流（如按小时）直接报给调用方去降级 */
const MAX_RETRY_WAIT_MS = 10_000;
const DEFAULT_RETRY_WAIT_MS = 1_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function attempt(name: string, fetchImpl: typeof fetch, url: string, init: RequestInit, signal?: AbortSignal): Promise<Response> {
  try {
    return await fetchImpl(url, { ...init, signal: requestSignal(signal) });
  } catch (err) {
    if (signal?.aborted) throw err; // 调用方主动取消，原样透传
    if (err instanceof Error && err.name === 'TimeoutError') throw new Error(`${name} 搜索超时（${REQUEST_TIMEOUT_MS / 1000} 秒）`);
    throw new Error(`${name} 网络请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** Retry-After 只认秒数；缺失或不可解析时取默认等待 */
function retryWaitMs(res: Response): number {
  const seconds = Number(res.headers.get('Retry-After'));
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : DEFAULT_RETRY_WAIT_MS;
}

/** GET JSON：超时/网络失败带来源名；429 在 Retry-After 不超过 10 秒时重试 1 次 */
export async function getJson<T>(name: string, url: string, init: RequestInit, opts: SourceOptions, signal?: AbortSignal): Promise<T> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  let res = await attempt(name, fetchImpl, url, init, signal);
  if (res.status === 429) {
    const wait = retryWaitMs(res);
    if (wait <= MAX_RETRY_WAIT_MS) {
      await (opts.sleep ?? defaultSleep)(wait);
      res = await attempt(name, fetchImpl, url, init, signal);
    }
  }
  if (res.status === 429) throw new Error(`${name} 搜索被限流（429），Retry-After ${res.headers.get('Retry-After') ?? '未给出'} 秒，稍后再试或改用其它来源`);
  if (!res.ok) throw new Error(`${name} 搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  return (await res.json()) as T;
}

/** 多个检索并行：成功的合并，全部失败才抛第一个错误 */
export async function settleAll(tasks: readonly Promise<Candidate[]>[]): Promise<Candidate[]> {
  const results = await Promise.allSettled(tasks);
  const ok = results.filter((r): r is PromiseFulfilledResult<Candidate[]> => r.status === 'fulfilled');
  if (ok.length === 0) {
    const first = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    throw first?.reason ?? new Error('没有可执行的检索');
  }
  return ok.flatMap((r) => r.value);
}
