import type { Shot } from '../storyboard/schema.js';

export interface TimeRef { sec: number; label?: string }

/**
 * 工作台「插入」按钮生成的卡片名（与 web/src/lib/shots.ts 的 cardName 一致）：只有这些名字跟在 @mm:ss 后面才算卡片名，
 * 手打的「@00:07 这张卡换成…」只认时间，后面的话不会被当成卡片名
 */
const CARD_LABEL = '钩子卡\\d/\\d|标题卡|数字卡|标签卡|对比条卡|证据清单卡|终端卡|开关卡|划线清单卡|网页截图|图片卡|流程卡|三连CTA|纯人像|画面';
/** 匹配 `@mm:ss`，其后隔空格紧跟、且到空白或结尾为止的已知卡片名视为卡片名；秒数只认 00-59 */
const REF_RE = new RegExp(`@(\\d{1,3})[:：]([0-5]\\d)(?!\\d)(?:[ \\t]+(${CARD_LABEL})(?=\\s|$))?`, 'g');

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
