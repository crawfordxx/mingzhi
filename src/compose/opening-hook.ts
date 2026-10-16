import { displayWidth, type TimedCaption } from '../captions/lines.js';
import type { CoverTitle, Shot } from '../storyboard/schema.js';
import { visualLayout } from './layout.js';

/** 钩子文字最宽（显示宽度，汉字记 1）：一行 96px 左右的粗体放得下 */
export const HOOK_TEXT_MAX_WIDTH = 16;
/** 只看开头这么多秒内、且在第一个镜头结束前开口的字幕 */
const LOOKAHEAD_SEC = 4;
/** 寒暄与开场套话：整句只剩这些就不用，句首的剥掉 */
const FILLER = /^(?:hello|hi|hey|嗨|哈喽|你好|大家好|各位|朋友们|兄弟们|欢迎(?:来到)?|今天(?:我们)?(?:来)?(?:一起)?(?:聊聊|聊一聊|讲讲|讲一讲|分享|说说|说一说|看看|聊|讲)|这期(?:视频)?|这个视频|本期)[\s，,、]*/i;
/** 数字：阿拉伯数字，或「三个」「两倍」这样的中文数量（「一条」「一键」是量词用法，不算） */
const NUMERIC = /[0-9０-９]|[二三四五六七八九十两百千万]+(?:个|条|倍|件|步|天|秒|分|种|招|点|项|年|月|次|成)/;
const SEPARATOR = /[\s，,、；;：:]/;

const stripFiller = (text: string): string => {
  const next = text.trim().replace(FILLER, '');
  return next === text.trim() ? next : stripFiller(next);
};

const fits = (text: string): boolean => text !== '' && displayWidth(text) <= HOOK_TEXT_MAX_WIDTH;

/** 超出一行时在最后一个停顿或空格处截到一行内；截不出返回空串 */
function fitPhrase(text: string): string {
  if (fits(text)) return text;
  const cuts = [...text].flatMap((ch, i) => (SEPARATOR.test(ch) ? [i] : []));
  const ok = cuts.filter((i) => fits(text.slice(0, i).trim())).pop();
  return ok === undefined ? '' : text.slice(0, ok).trim();
}

const firstWords = (captions: TimedCaption[], untilSec: number): string[] =>
  [...captions].sort((a, b) => a.start - b.start).filter((c) => c.start < untilSec).map((c) => stripFiller(c.text)).filter((t) => t !== '');

/**
 * 开头钩子文字（一行标题或数字）的来源，按优先级：
 * 分镜里钩子卡的标题 → 开头字幕里带数字的核心短语 → 封面主标题 → 开头第一句字幕的核心短语（去掉寒暄）。
 * 放不进一行（≤ HOOK_TEXT_MAX_WIDTH）的来源跳过，字幕短语可在停顿处截断；都没有返回 undefined
 */
export function openingHookText(shots: Shot[], captions: TimedCaption[], coverTitle: Pick<CoverTitle, 'title'> | undefined): string | undefined {
  const card = shots.find((s) => s.card?.template === 'hook')?.card;
  const headline = card?.template === 'hook' ? card.props.headline.trim() : '';
  const words = firstWords(captions, Math.min(LOOKAHEAD_SEC, shots[0]?.end ?? LOOKAHEAD_SEC)).map(fitPhrase).filter((t) => t !== '');
  const numeric = words.find((t) => NUMERIC.test(t));
  const cover = coverTitle?.title.trim() ?? '';
  return [headline, numeric ?? '', cover, words[0] ?? ''].find(fits);
}

/** 第一个镜头是全屏素材（从 0 秒起、素材在）时，把钩子文字写进它的 broll.hook；其余情形、没有可用文字时原样返回同一个数组。不改入参 */
export function withOpeningHook(shots: Shot[], captions: TimedCaption[], coverTitle: Pick<CoverTitle, 'title'> | undefined): Shot[] {
  const first = shots[0];
  if (!first?.broll || first.start !== 0 || visualLayout(first) !== 'broll') return shots;
  const text = openingHookText(shots, captions, coverTitle);
  return text ? [{ ...first, broll: { ...first.broll, hook: text } }, ...shots.slice(1)] : shots;
}
