/** 可想 AI 账户余额不足：继续降级或重试只会白白消耗时间，必须一路抛到命令行提示用户充值 */
export class InsufficientBalanceError extends Error {
  constructor(message = '可想 AI 账户余额不足，请充值后重试') {
    super(message);
    this.name = 'InsufficientBalanceError';
  }
}

export const RECHARGE_URL = 'https://kexiangai.com';

/** 网络错误与 429/5xx 的重试间隔（毫秒）：代理短暂中断常常持续十几秒，所以退避要够长；重试次数 = 间隔个数 */
export const RETRY_BACKOFF_MS = [2000, 5000, 10000] as const;

/** 响应是 HTTP 400 且 JSON 里 msg / message 含「余额不足」时返回对应错误，否则返回 undefined */
export function balanceErrorFrom(status: number, body: string): InsufficientBalanceError | undefined {
  if (status !== 400) return undefined;
  try {
    const json = JSON.parse(body) as { msg?: unknown; message?: unknown } | null;
    const texts = [json?.msg, json?.message].filter((t): t is string => typeof t === 'string');
    return texts.some((t) => t.includes('余额不足')) ? new InsufficientBalanceError() : undefined;
  } catch {
    return undefined;
  }
}

/** fetch 抛错时 err.cause 里的系统错误码（如 ECONNRESET、ENOTFOUND） */
export function causeCode(err: unknown): string | undefined {
  const code = (err as { cause?: { code?: unknown } } | null)?.cause?.code;
  return typeof code === 'string' ? code : undefined;
}

/** 网络错误的一句话原因；undici 的 fetch 只抛 "fetch failed"，真正原因在 err.cause（code / message） */
export function networkReason(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return '请求超时';
  const base = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: { message?: unknown } } | null)?.cause;
  const code = causeCode(err);
  const message = typeof cause?.message === 'string' ? cause.message : undefined;
  const detail = [...(code && !message?.includes(code) ? [code] : []), ...(message ? [message] : [])].join(' ');
  return `网络错误 ${base}${detail ? `（${detail}）` : ''}`;
}

/** 在「失败就降级」的 catch 里第一句调用：余额不足不能降级，原样继续往外抛 */
export function rethrowIfBalance(err: unknown): void {
  if (err instanceof InsufficientBalanceError) throw err;
}
