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
  /** 墙上时钟（测试注入），默认 Date.now */
  now?: () => number;
}

/** 两次检查的实际间隔超过 checkMs 的这么多倍，就当作电脑刚从睡眠中醒来 */
const WAKE_GAP_FACTOR = 3;

/**
 * 开始检查空闲；返回停止函数。定时器不拖住进程退出。
 * 睡眠时定时器停走而墙上时钟照走：唤醒后的第一轮会看到「空闲了好几个小时」，而开着的页面还没来得及 ping。
 * 所以两次检查间隔远大于 checkMs 时记一次活动并跳过本轮，从唤醒时重新计时。
 */
export function watchIdle(o: IdleWatchOptions): () => void {
  const now = o.now ?? (() => Date.now());
  let last = now();
  const timer = setInterval(() => {
    const at = now();
    const woke = at - last > WAKE_GAP_FACTOR * o.checkMs;
    last = at;
    // 任务在跑就算活动：任务结束后从那一刻重新计时
    if (woke || o.busy()) { o.activity.touch(); return; }
    if (o.activity.idleFor() < o.idleMs) return;
    clearInterval(timer);
    o.onIdle();
  }, o.checkMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
