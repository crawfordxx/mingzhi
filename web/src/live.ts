/**
 * 剪辑直播：SSE 订阅、补历史、重播。
 * - 实时：api.events（EventSource，先补历史再推实时，按 seq 去重）
 * - 历史：loadHistory 收齐一个版本已落盘的事件（遇到 done/failed 或静默片刻即收尾）
 * - 重播：按 events.jsonl 的真实时间间隔放映，整体压缩到 ≤ 20 秒（见 replayOffsets）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type WorkEvent } from './api';
import { REPLAY_HOLD_MS, REPLAY_LEAD_MS, replayOffsets } from './lib/replay';

/** 历史补完后静默这么久，就认为没有更多（版本被中断时不会有 done） */
const HISTORY_IDLE_MS = 1200;
const HISTORY_TIMEOUT_MS = 8000;

export const isTerminal = (e: WorkEvent): boolean => e.step === 'done' || e.step === 'failed';

/** 读一个已结束版本的全部事件（打开一条事件流，收齐即关） */
function readHistory(spaceId: string, version: number): Promise<WorkEvent[]> {
  return new Promise((resolve) => {
    const got: WorkEvent[] = [];
    let idle = 0;
    let ended = false;
    let close: (() => void) | undefined;
    const finish = () => {
      if (ended) return;
      ended = true;
      window.clearTimeout(idle); window.clearTimeout(cap); close?.(); resolve(got);
    };
    const cap = window.setTimeout(finish, HISTORY_TIMEOUT_MS);
    close = api.events(spaceId, version, (e) => {
      got.push(e);
      window.clearTimeout(idle);
      if (isTerminal(e)) finish();
      else idle = window.setTimeout(finish, HISTORY_IDLE_MS);
    });
    if (ended) close();
  });
}

let queue: Promise<unknown> = Promise.resolve();

/**
 * 补历史一条一条来（同时只开一条事件流，避免和实时流、视频一起撞上浏览器每个源 6 条连接的上限）。
 * 轮到时 wanted() 为 false（已经切到别的项目）就跳过，返回 undefined。
 */
export function loadHistory(spaceId: string, version: number, wanted: () => boolean = () => true): Promise<WorkEvent[] | undefined> {
  const run = queue.then(() => (wanted() ? readHistory(spaceId, version) : undefined));
  queue = run.catch(() => undefined);
  return run;
}

export interface Replay {
  /** 正在重播时给出已放映的事件，否则 undefined */
  shown?: WorkEvent[];
  /** 0–1 */
  progress: number;
  start: () => void;
  stop: () => void;
}

/** 重播一个版本的事件；放完停一下再回到完整画面 */
export function useReplay(events: readonly WorkEvent[]): Replay {
  const [count, setCount] = useState<number>();
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach((id) => window.clearTimeout(id)); timers.current = []; };
  const stop = useCallback(() => { clear(); setCount(undefined); }, []);
  const start = useCallback(() => {
    clear();
    const offsets = replayOffsets(events);
    setCount(0);
    timers.current = offsets.map((ms, i) => window.setTimeout(() => setCount(i + 1), ms + REPLAY_LEAD_MS));
    timers.current.push(window.setTimeout(() => setCount(undefined), (offsets.at(-1) ?? 0) + REPLAY_LEAD_MS + REPLAY_HOLD_MS));
  }, [events]);
  useEffect(() => clear, []);
  const shown = count === undefined ? undefined : events.slice(0, count);
  return { shown, progress: count === undefined || !events.length ? 0 : count / events.length, start, stop };
}
