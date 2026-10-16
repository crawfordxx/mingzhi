/**
 * Tab 键在 count 个可聚焦元素里循环：current 是当前聚焦的下标（-1 = 焦点不在其中）。
 * 返回要跳到的下标；返回 undefined 表示交给浏览器默认处理（中间位置的正常前进 / 后退）
 */
export function nextFocus(count: number, current: number, backwards: boolean): number | undefined {
  if (count === 0) return undefined;
  if (current < 0) return backwards ? count - 1 : 0;
  if (backwards && current === 0) return count - 1;
  if (!backwards && current === count - 1) return 0;
  return undefined;
}
