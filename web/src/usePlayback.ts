/**
 * 播放时钟的 React 接口：时钟实例全局只建一个（不放在 React 状态里），
 * 需要播放头的组件用 useClock 订阅，可以只取一个派生值（例如「暂停时的整秒」），播放时就不会跟着重渲。
 */
import { useRef, useSyncExternalStore } from 'react';
import { Clock, type ClockState } from './lib/clock';

export { Clock } from './lib/clock';
export type { ClockState } from './lib/clock';

export function usePlayback(): Clock {
  const ref = useRef<Clock>();
  ref.current ??= new Clock();
  return ref.current;
}

/** 订阅时钟；select 返回原始值时，只有它变了才重渲 */
export function useClock<T = ClockState>(clock: Clock, select?: (s: ClockState) => T): T {
  const read = () => (select ? select(clock.getState()) : (clock.getState() as T));
  return useSyncExternalStore(clock.subscribe, read, read);
}
