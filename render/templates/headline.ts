import { textEm } from './parts.js';

/** 标题里不可再拆的片段；hot 表示属于高亮子串 */
export interface Token { text: string; hot: boolean }

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** 英文单词、数字作为整体，其余逐字 */
const ATOM = /[A-Za-z0-9.%,]+|\s+|./gu;
/** 不能出现在行首的标点 */
const NO_LINE_START = /^[，。、：；！？）》」』,.!?:;)]/;

/** 切片：高亮子串整体一段，其余按 ATOM 切 */
export function tokenize(headline: string, highlight: string[]): Token[] {
  const phrases = highlight.filter((h) => h.length > 0).sort((a, b) => b.length - a.length);
  const parts = phrases.length === 0 ? [headline] : headline.split(new RegExp(`(${phrases.map(escape).join('|')})`, 'g'));
  return parts.flatMap((part, i): Token[] => {
    if (part === '') return [];
    if (i % 2 === 1) return [{ text: part, hot: true }];
    return (part.match(ATOM) ?? []).map((text) => ({ text, hot: false }));
  });
}

const widthOf = (tokens: Token[]): number => tokens.reduce((s, t) => s + textEm(t.text), 0);
/** 短语结尾的标点（断在它后面最自然） */
const PHRASE_END = /^[，。、：；！？,!?:;]$/;
/** 行末可以省掉的逗号 */
const LINE_END_COMMA = /^[，、,]$/;
/** 按标点断行时，最短行至少是最长行的这个比例，否则太不均衡 */
const MIN_BALANCE = 0.4;

/** 均衡断行：先按 maxEm 算出最少行数；能在标点后断开且足够均衡就按短语断，否则逐片段让各行宽度接近平均值；行首不放标点；断行处的逗号省掉 */
export function balanceLines(tokens: Token[], maxEm: number): Token[][] {
  const total = widthOf(tokens);
  const minLines = Math.max(1, Math.ceil(total / maxEm));
  const byPhrase = splitInto(phrases(tokens), total / minLines, minLines);
  if (byPhrase.length === minLines && fits(byPhrase, maxEm) && balanced(byPhrase)) return dropBreakCommas(byPhrase);
  const units = tokens.map((t) => [t]);
  for (let n = minLines; n <= 8; n++) {
    const lines = splitInto(units, total / n, n);
    if (fits(lines, maxEm)) return dropBreakCommas(lines);
  }
  return dropBreakCommas(splitInto(units, maxEm, Infinity));
}

const fits = (lines: Token[][], maxEm: number): boolean => lines.every((l) => widthOf(l) <= maxEm);
const balanced = (lines: Token[][]): boolean => {
  const widths = lines.map(widthOf);
  return Math.min(...widths) >= Math.max(...widths) * MIN_BALANCE;
};

/** 把片段合成短语，标点留在短语末尾 */
function phrases(tokens: Token[]): Token[][] {
  return tokens.reduce<Token[][]>((acc, tok) => {
    const merged = [...acc.slice(0, -1), [...acc[acc.length - 1], tok]];
    return PHRASE_END.test(tok.text) ? [...merged, []] : merged;
  }, [[]]).filter((p) => p.length > 0);
}

/** 非最后一行末尾的逗号省掉（标题排版习惯） */
function dropBreakCommas(lines: Token[][]): Token[][] {
  return lines.map((l, i) => (i < lines.length - 1 && l.length > 1 && LINE_END_COMMA.test(l[l.length - 1].text) ? l.slice(0, -1) : l));
}

/** 单元（片段或短语）中点越过目标宽度时换行，最多 n 行（最后一行收下剩余） */
function splitInto(units: Token[][], target: number, n: number): Token[][] {
  const result = units.reduce<{ lines: Token[][]; width: number }>((acc, unit) => {
    const w = widthOf(unit);
    const current = acc.lines[acc.lines.length - 1];
    const overflow = acc.width + w / 2 > target && current.length > 0;
    const canBreak = acc.lines.length < n && !NO_LINE_START.test(unit[0].text);
    if (overflow && canBreak) {
      const lead = unit[0].text.trim() === '' ? unit.slice(1) : unit;
      return { lines: [...acc.lines, lead], width: widthOf(lead) };
    }
    return { lines: [...acc.lines.slice(0, -1), [...current, ...unit]], width: acc.width + w };
  }, { lines: [[]], width: 0 });
  return result.lines.filter((l) => l.length > 0);
}
