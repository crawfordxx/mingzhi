/**
 * 服务的活动与空闲退出：
 * - Activity 记录进行中的请求数（SSE、长上传也算）与最后一次活动时间；
 * - watchIdle 定时检查：没有请求开着、没有任务、离最后一次活动满 idleMs 时调用 onIdle（只调一次）。
 * 工作台页面开着时每分钟 ping 一次，所以只有浏览器都关了才会计时。
 */

export class Activity {
  private open = 0;
  private last: number;

  constructor(private readonly now: () => number = Date.now) {
    this.last = now();
  }

  /** 一个请求开始；返回在它结束时调用的函数（重复调用无害） */
  begin(): () => void {
    this.open += 1;
    this.touch();
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.open -= 1;
      this.touch();
    };
  }

  touch(): void {
    this.last = this.now();
  }

  /** 已空闲多久；有请求开着时为 0 */
  idleFor(): number {
    return this.open > 0 ? 0 : Math.max(0, this.now() - this.last);
  }
}

export interface IdleWatchOptions {
  activity: Activity;
  /** 有任务排队或运行中 */
  busy: () => boolean;
  idleMs: number;
  checkMs: number;
  onIdle: () => void;
}

/** 开始检查空闲；返回停止函数。定时器不拖住进程退出 */
export function watchIdle(o: IdleWatchOptions): () => void {
  const timer = setInterval(() => {
    // 任务在跑就算活动：任务结束后从那一刻重新计时
    if (o.busy()) { o.activity.touch(); return; }
    if (o.activity.idleFor() < o.idleMs) return;
    clearInterval(timer);
    o.onIdle();
  }, o.checkMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
