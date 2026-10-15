/** 用户取消任务：流程里所有「失败就降级」的 catch 都要像余额不足一样把它原样重抛，不能当普通失败吞掉 */
export class CancelledError extends Error {
  constructor(message = '已取消') {
    super(message);
    this.name = 'CancelledError';
  }
}

/** 已取消则抛 CancelledError；流程在步骤之间与长任务内部调用 */
export function throwIfCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError();
}

/** 在「失败就降级」的 catch 里与 rethrowIfBalance 并列调用：取消不能降级，原样继续往外抛 */
export function rethrowIfCancelled(err: unknown): void {
  if (err instanceof CancelledError) throw err;
}
