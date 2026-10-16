import { displayWidth, type TimedCaption } from '../captions/lines.js';

/** 一句话被停顿切成多行字幕时：相邻两行最大间隔、整句最长（秒） */
export const SENTENCE_GAP_SEC = 0.5;
export const SENTENCE_MAX_SEC = 3;
/** 收尾话（关注、点赞、再见……）最宽：再长的多半是正文里碰巧带了这个词 */
const CLOSING_MAX_WIDTH = 12;
const CLOSING_WORDS = /关注|点赞|收藏|订阅|转发|评论区|下期|下次|再见|拜拜|谢谢|感谢|三连/;
const SENTENCE_END = /[。！？!?…]$/;

/** 收尾话：呼吁互动或告别，不承载信息，CTA 可以和它同时出现 */
export const isClosingLine = (text: string): boolean => displayWidth(text) <= CLOSING_MAX_WIDTH && CLOSING_WORDS.test(text);

export interface SentenceSpan { start: number; end: number }

/**
 * 最后一个承载信息的字幕句（CTA 不能盖住它）：跳过结尾的收尾话，取最后一个内容行，再往前并入同一句话的前几行
 * （行间隔 ≤ SENTENCE_GAP_SEC、整句 ≤ SENTENCE_MAX_SEC、前一行不以句末标点结束）。全是收尾话时退回最后一行；没有字幕返回 undefined
 */
export function contentSentence(captions: TimedCaption[]): SentenceSpan | undefined {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  if (sorted.length === 0) return undefined;
  const lastInfo = sorted.map((c) => !isClosingLine(c.text)).lastIndexOf(true);
  const idx = lastInfo >= 0 ? lastInfo : sorted.length - 1;
  const end = sorted[idx].end;
  const joins = (j: number): boolean => sorted[j + 1].start - sorted[j].end <= SENTENCE_GAP_SEC && end - sorted[j].start <= SENTENCE_MAX_SEC && !SENTENCE_END.test(sorted[j].text);
  let first = idx;
  while (first > 0 && joins(first - 1)) first -= 1;
  return { start: sorted[first].start, end };
}
