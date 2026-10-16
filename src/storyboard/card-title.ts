import { displayWidth, type TimedCaption } from '../captions/lines.js';
import type { CardSpec, Shot } from './schema.js';

/** 补全后的标题最宽（显示宽度，汉字记 1）：标题卡最多折 3 行，再长字号会缩得太小 */
export const TITLE_FIX_MAX_WIDTH = 18;
/** 字幕拼成一句时：相邻两行的最大间隔、整句最长（秒） */
const JOIN_GAP_SEC = 0.5;
const JOIN_MAX_SEC = 3;
/** 标题末尾那段话所在的字幕行，与镜头的时间容差（秒） */
const NEAR_SEC = 0.5;
const COLON = /[：:]/;
const SENTENCE_END = /[。！？!?…]$/;

/** 结尾是标点（逗号、冒号、顿号等），后面一定还有话 */
const TRAILING_PUNCT = /[：:，,、；;—]$/;
/** 结尾是连词或助词（多字词先列），名词短语不会这样收尾；「目的」「真的」之类以「的」结尾的完整词除外 */
const DANGLING_WORD = /(?:以及|并且|而且|或者|还有|然后|所以|因为|如果|但是|不过|关于|对于|通过)$|[的地得和与及把被让]$/;
const COMPLETE_WORD = /(?:目的|真的|是的|有的|别的|对的|好的|似的|平和|温和|暖和|柔和|调和|缓和|祥和)$/;
/** 结尾是时间状语（「每天睡前」「早上」），后面该接做什么 */
const TIME_LEAD = /(?:睡前|饭前|饭后|睡觉前|起床后|之前|之后|以前|以后|的时候|开始时|结束后|每天|每次|每周|每月|每年|早上|早晨|晚上|中午)$/;

/** 标题是完整意思：不以标点、连词助词或时间状语收尾（话没说一半） */
export function isCompleteTitle(title: string): boolean {
  const t = title.trim();
  if (t === '' || TRAILING_PUNCT.test(t) || TIME_LEAD.test(t)) return false;
  return COMPLETE_WORD.test(t) || !DANGLING_WORD.test(t);
}

/** 从 tail 所在的字幕行起往后拼成一整句（行间隔 ≤ JOIN_GAP_SEC、合计 ≤ JOIN_MAX_SEC、遇句末标点停）；找不到返回 undefined */
function sentenceFrom(tail: string, captions: TimedCaption[], near: { start: number; end: number }): string | undefined {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const i = sorted.findIndex((c) => c.text.includes(tail) && c.end > near.start - NEAR_SEC && c.start < near.end + NEAR_SEC);
  if (i < 0) return undefined;
  const first = sorted[i];
  const joined = sorted.slice(i + 1).reduce<{ text: string; end: number; open: boolean }>((acc, c) => (
    acc.open && c.start - acc.end <= JOIN_GAP_SEC && c.end - first.start <= JOIN_MAX_SEC && !SENTENCE_END.test(acc.text)
      ? { text: acc.text + c.text, end: c.end, open: true } : { ...acc, open: false }
  ), { text: first.text.slice(first.text.indexOf(tail)), end: first.end, open: true });
  return joined.text.replace(SENTENCE_END, '');
}

const fits = (t: string): boolean => displayWidth(t) <= TITLE_FIX_MAX_WIDTH && isCompleteTitle(t);

/**
 * 话说一半的标题怎么改：有冒号时先试「冒号前 + 字幕整句」，再试「字幕整句」，最后去掉冒号后的半句只留冒号前；
 * 没有冒号时只试字幕整句。都不行返回 undefined。字幕整句 = 标题末尾那段话所在的字幕行起，往后拼到句子结束
 */
export function repairedTitle(title: string, captions: TimedCaption[], shot: { start: number; end: number }): string | undefined {
  const m = COLON.exec(title);
  const lead = m ? title.slice(0, m.index).trim() : '';
  const tail = (m ? title.slice(m.index + 1) : title).trim();
  const sentence = tail ? sentenceFrom(tail, captions, shot) : undefined;
  const options = [
    ...(lead && sentence ? [`${lead}：${sentence}`] : []),
    ...(sentence ? [sentence] : []),
    ...(lead.length >= 2 ? [lead] : []),
  ];
  return options.find(fits);
}

export interface TitleCheck { shots: Shot[]; fixes: string[]; unfixed: string[] }

/** 卡片标题字段：钩子（headline）、标题卡 / 证据列表 / 流程图的 title */
function titleOf(card: CardSpec): string | undefined {
  if (card.template === 'hook') return card.props.headline;
  return card.template === 'title' || card.template === 'evidenceList' || card.template === 'flow' ? card.props.title : undefined;
}

function withTitle(card: CardSpec, title: string): CardSpec {
  if (card.template === 'hook') return { template: 'hook', props: { ...card.props, headline: title, highlight: card.props.highlight.filter((h) => title.includes(h)) } };
  if (card.template === 'title' || card.template === 'evidenceList' || card.template === 'flow') return { ...card, props: { ...card.props, title } } as CardSpec;
  return card;
}

/** 卡片标题都是完整意思（没有标题字段的卡片算完整）；改写卡片时用 */
export function cardTitleComplete(card: CardSpec): boolean {
  const title = titleOf(card);
  return title === undefined || isCompleteTitle(title);
}

/**
 * 校验并修复所有卡片标题：不完整的按 repairedTitle 改，改不了的保留原样记入 unfixed。
 * 不改入参；完整标题与无卡片镜头原样返回同一个对象
 */
export function completeCardTitles(shots: Shot[], captions: TimedCaption[]): TitleCheck {
  const fixes: string[] = [];
  const unfixed: string[] = [];
  const out = shots.map((s, i): Shot => {
    const title = s.card ? titleOf(s.card) : undefined;
    if (!s.card || title === undefined || isCompleteTitle(title)) return s;
    const next = repairedTitle(title, captions, s);
    if (next === undefined) {
      unfixed.push(`第 ${i + 1} 个镜头的标题「${title}」话没说完，应以句末或完整短语结束`);
      return s;
    }
    fixes.push(`第 ${i + 1} 个镜头的标题「${title}」话没说完，已改为「${next}」`);
    return { ...s, card: withTitle(s.card, next) };
  });
  return { shots: out, fixes, unfixed };
}
