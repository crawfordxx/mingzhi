import { describe, expect, it } from 'vitest';
import { nextFocus } from './focusTrap';

describe('抽屉里的 Tab 循环', () => {
  it('最后一个再往后回到第一个，第一个再往前回到最后一个', () => {
    expect(nextFocus(4, 3, false)).toBe(0);
    expect(nextFocus(4, 0, true)).toBe(3);
  });
  it('中间位置交给浏览器', () => {
    expect(nextFocus(4, 1, false)).toBeUndefined();
    expect(nextFocus(4, 2, true)).toBeUndefined();
  });
  it('焦点在面板外（或在面板本身）：往后进第一个、往前进最后一个', () => {
    expect(nextFocus(4, -1, false)).toBe(0);
    expect(nextFocus(4, -1, true)).toBe(3);
  });
  it('没有可聚焦元素不处理', () => {
    expect(nextFocus(0, -1, false)).toBeUndefined();
  });
});
