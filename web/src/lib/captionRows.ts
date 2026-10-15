/**
 * 直播转录的行：有校对后的字幕时按字幕行显示（文字是校对后的，被剪的词按 token 区间标回去），没有时显示识别原文。
 * 两行字幕之间被剪的词标在下一行开头，最后一行之后的接在末尾；行内被剪的按保留字数估算插入位置（校对只改个别字，位置基本对得上）。
 */
import { cutTokenSet, type CapLine, type CutMark, type TxLine } from './liveModel';

export interface RowPart { text: string; cut: boolean }
export interface TxRow { key: string; parts: RowPart[] }

/** 追加一段，与前一段同为剪掉/保留时并成一段 */
function push(parts: RowPart[], text: string, cut: boolean): RowPart[] {
  if (!text) return parts;
  const last = parts.at(-1);
  return last && last.cut === cut ? [...parts.slice(0, -1), { text: last.text + text, cut }] : [...parts, { text, cut }];
}

/** 识别原文：每个识别行一行 */
export function transcriptRows(lines: readonly TxLine[], cuts: readonly CutMark[]): TxRow[] {
  const cut = cutTokenSet([...cuts]);
  return lines.map((l) => ({ key: `t${l.from}`, parts: l.tokens.reduce<RowPart[]>((ps, tok, k) => push(ps, tok, cut.has(l.from + k)), []) }));
}

const tokenTexts = (lines: readonly TxLine[]): Map<number, string> => new Map(lines.flatMap((l) => l.tokens.map((t, k) => [l.from + k, t] as const)));

/** [from, to] 里被剪的 token 文字 */
function cutText(text: Map<number, string>, cut: ReadonlySet<number>, from: number, to: number): string {
  return [...cut].filter((k) => k >= from && k <= to).sort((a, b) => a - b).map((k) => text.get(k) ?? '').join('');
}

/** 计字时不算标点与空白（校对后的字幕去掉了标点，又会在中英文之间加空格） */
const SKIP = /[\p{P}\s]/u;
const letters = (t: string): number => [...t].filter((ch) => !SKIP.test(ch)).length;

/** 校对后文字里数够 n 个字（不算标点空白）之后的位置 */
function indexAfter(text: string, n: number): number {
  let seen = 0;
  for (let i = 0; i < text.length; i++) {
    if (seen >= n) return i;
    if (!SKIP.test(text[i])) seen += 1;
  }
  return text.length;
}

/** 行内被剪的词：在校对后文字里的插入位置（按此前保留的字数）与文字 */
function insideCuts(text: Map<number, string>, cut: ReadonlySet<number>, c: CapLine): { at: number; text: string }[] {
  const out: { at: number; text: string }[] = [];
  let kept = 0;
  let run = '';
  for (let k = c.from; k <= c.to; k++) {
    const t = text.get(k) ?? '';
    if (cut.has(k)) { run += t; continue; }
    if (run) { out.push({ at: indexAfter(c.text, kept), text: run }); run = ''; }
    kept += letters(t);
  }
  return out;
}

function captionRow(c: CapLine, lead: string, tail: string, inside: { at: number; text: string }[]): RowPart[] {
  let parts = push([], lead, true);
  let pos = 0;
  for (const ins of inside) {
    const at = Math.min(c.text.length, Math.max(pos, ins.at));
    parts = push(push(parts, c.text.slice(pos, at), false), ins.text, true);
    pos = at;
  }
  return push(push(parts, c.text.slice(pos), false), tail, true);
}

/** 校对后的字幕行，带上被剪的词 */
export function captionRows(caps: readonly CapLine[], lines: readonly TxLine[], cuts: readonly CutMark[]): TxRow[] {
  const text = tokenTexts(lines);
  const cut = cutTokenSet([...cuts]);
  const lastToken = Math.max(-1, ...text.keys());
  return caps.map((c, i) => {
    const lead = cutText(text, cut, i === 0 ? 0 : caps[i - 1].to + 1, c.from - 1);
    const tail = i === caps.length - 1 ? cutText(text, cut, c.to + 1, lastToken) : '';
    return { key: `c${c.from}`, parts: captionRow(c, lead, tail, insideCuts(text, cut, c)) };
  });
}
