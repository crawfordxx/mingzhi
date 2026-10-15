/**
 * 剪辑直播：SSE 订阅、补历史、重播。
 * - 实时：api.events（EventSource，先补历史再推实时，按 seq 去重）
 * - 历史：loadHistory 收齐一个版本已落盘的事件（遇到 done/failed 或静默片刻即收尾）
 * - 重播：按 events.jsonl 的真实时间间隔放映，整体压缩到 ≤ 20 秒（见 replayOffsets）
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type WorkEvent } from './api';

export const REPLAY_MAX_MS = 20_000;
/** 历史补完后静默这么久，就认为没有更多（版本被中断时不会有 done） */
const HISTORY_IDLE_MS = 1200;
const HISTORY_TIMEOUT_MS = 8000;

export const isTerminal = (e: WorkEvent): boolean => e.step === 'done' || e.step === 'failed';

/** 读一个已结束版本的全部事件 */
export function loadHistory(spaceId: string, version: number): Promise<WorkEvent[]> {
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

/**
 * 重播时间表：第 i 条事件在第几毫秒出现。
 * 真实间隔先开平方（长的抠像、渲染被压得多，短的识别、分镜几乎不压；连续进度事件再打四分之一），再整体缩放到 ≤ 20 秒；
 * 真实总时长本来就不到 20 秒时按原速。每条至少间隔 40ms，打字效果看得清。
 */
export function replayOffsets(events: readonly WorkEvent[], maxMs = REPLAY_MAX_MS): number[] {
  if (!events.length) return [];
  const gaps = events.map((e, i) => (i === 0 ? 0 : Math.max(0, e.t - events[i - 1].t)));
  const real = gaps.reduce((a, b) => a + b, 0);
  const target = Math.min(maxMs, real);
  // 同一步骤里连续的进度事件（抠像 12%→15%…）只算四分之一，免得重播大半时间都在看进度条
  const curved = gaps.map((g, i) => Math.sqrt(g) * (i > 0 && events[i].detail?.kind === 'progress' && events[i - 1].step === events[i].step ? 0.25 : 1));
  const sum = curved.reduce((a, b) => a + b, 0) || 1;
  const scaled = curved.map((c, i) => (i === 0 ? 0 : Math.max(40, (c / sum) * target)));
  const over = scaled.reduce((a, b) => a + b, 0) / maxMs;
  const fit = over > 1 ? scaled.map((s) => s / over) : scaled;
  return fit.reduce<number[]>((acc, g, i) => [...acc, (i === 0 ? 0 : acc[i - 1]) + g], []);
}

export interface Replay {
  /** 正在重播时给出已放映的事件，否则 undefined */
  shown?: WorkEvent[];
  /** 0–1 */
  progress: number;
  start: () => void;
  stop: () => void;
}

/** 重播一个版本的事件；放完停半秒再回到完整画面 */
export function useReplay(events: readonly WorkEvent[]): Replay {
  const [count, setCount] = useState<number>();
  const timers = useRef<number[]>([]);
  const clear = () => { timers.current.forEach((id) => window.clearTimeout(id)); timers.current = []; };
  const stop = useCallback(() => { clear(); setCount(undefined); }, []);
  const start = useCallback(() => {
    clear();
    const offsets = replayOffsets(events);
    setCount(0);
    timers.current = offsets.map((ms, i) => window.setTimeout(() => setCount(i + 1), ms + 300));
    timers.current.push(window.setTimeout(() => setCount(undefined), (offsets.at(-1) ?? 0) + 1400));
  }, [events]);
  useEffect(() => clear, []);
  const shown = count === undefined ? undefined : events.slice(0, count);
  return { shown, progress: count === undefined || !events.length ? 0 : count / events.length, start, stop };
}
