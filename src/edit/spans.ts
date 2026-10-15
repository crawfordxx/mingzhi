import type { TimeRange } from '../cut/plan.js';

const round = (n: number): number => Math.round(n * 1000) / 1000;

/** 成片时间区间 → 原片时间区间（可能跨多个保留段，所以返回列表）；落在被剪掉处的部分自然不会出现 */
export function outputToSource(keep: TimeRange[], from: number, to: number): TimeRange[] {
  const pieces: TimeRange[] = [];
  let offset = 0;
  for (const r of keep) {
    const len = r.end - r.start;
    const lo = Math.max(from, offset);
    const hi = Math.min(to, offset + len);
    if (hi > lo) pieces.push({ start: round(r.start + lo - offset), end: round(r.start + hi - offset) });
    offset += len;
  }
  return pieces;
}

/** 从列表里扣掉 cut，返回不可变的新列表 */
export function subtractRange(ranges: TimeRange[], cut: TimeRange): TimeRange[] {
  return ranges.flatMap((r) => {
    if (cut.end <= r.start || cut.start >= r.end) return [r];
    return [{ start: r.start, end: cut.start }, { start: cut.end, end: r.end }].filter((x) => x.end > x.start);
  });
}

/** 加入一段并合并重叠/相接的区间，结果按起点排序 */
export function addRange(ranges: TimeRange[], add: TimeRange): TimeRange[] {
  return [...ranges, add].sort((a, b) => a.start - b.start).reduce<TimeRange[]>((acc, r) => {
    const last = acc[acc.length - 1];
    return last && r.start <= last.end ? [...acc.slice(0, -1), { start: last.start, end: Math.max(last.end, r.end) }] : [...acc, { ...r }];
  }, []);
}
