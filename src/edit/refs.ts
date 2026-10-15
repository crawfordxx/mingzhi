import type { Shot } from '../storyboard/schema.js';

export interface TimeRef { sec: number; label?: string }

/** 匹配 `@mm:ss`，其后紧跟（可隔空格）的一段非空白文字视为卡片名；秒数只认 00-59 */
const REF_RE = /@(\d{1,3})[:：]([0-5]\d)(?!\d)(?:[ \t]+([^\s@]+))?/g;

/** 从用户消息里取出 `@01:05` 或 `@1:05 对比条卡` 形式的时间引用，按出现顺序返回 */
export function parseTimeRefs(text: string): TimeRef[] {
  return [...text.matchAll(REF_RE)].map((m) => {
    const sec = Number(m[1]) * 60 + Number(m[2]);
    return m[3] ? { sec, label: m[3] } : { sec };
  });
}

/** 成片时间落在哪个镜头（区间左闭右开）；早于首镜头取首个，晚于末镜头取末个，没有镜头返回 -1 */
export function shotForTime(shots: Shot[], sec: number): number {
  if (shots.length === 0) return -1;
  const hit = shots.findIndex((s) => sec >= s.start && sec < s.end);
  if (hit >= 0) return hit;
  return sec < shots[0].start ? 0 : shots.length - 1;
}
