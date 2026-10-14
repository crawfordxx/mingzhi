import type { Token } from '../asr/types.js';
import { displayWidth, type CaptionLine } from './lines.js';

/** 逐字对齐的格子数上限（原稿字数 × 字幕字数），约 1 万字的稿子；更长时报错由调用方兜底 */
const MAX_ALIGN_CELLS = 100_000_000;

export interface Alignment { lines: CaptionLine[]; matchedRatio: number }

/** 参与对齐的字：转小写，只留字母、数字与汉字（去掉空格和标点） */
const alignChars = (text: string): string[] => [...text.toLowerCase()].filter((ch) => /[\p{L}\p{N}]/u.test(ch));
const isAsciiAlnum = (ch: string): boolean => /^[A-Za-z0-9]$/.test(ch);

/** 最长公共子序列对齐：返回 a 中每个字匹配到的 b 中位置，未匹配为 -1 */
function lcsMatch(a: string[], b: string[]): Int32Array {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) throw new Error(`稿子太长（${n} 字），无法逐字对齐字幕`);
  const w = m + 1;
  const dp = new Uint32Array((n + 1) * w);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i * w + j] = a[i] === b[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
    }
  }
  const match = new Int32Array(n).fill(-1);
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      match[i] = j;
      i += 1;
      j += 1;
    } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) i += 1;
    else j += 1;
  }
  return match;
}

/** 字幕行里对不上原稿的字数：行首（第一个对上的字之前）与行尾（最后一个对上的字之后） */
function unmatchedEdges(lineOf: number[], matched: boolean[]): { head: number[]; tail: number[] } {
  const count = Math.max(0, ...lineOf.map((l) => l + 1));
  const head = Array<number>(count).fill(0);
  const tail = Array<number>(count).fill(0);
  const seen = Array<boolean>(count).fill(false);
  lineOf.forEach((line, q) => {
    if (matched[q]) {
      seen[line] = true;
      tail[line] = 0;
    } else if (seen[line]) tail[line] += 1;
    else head[line] += 1;
  });
  return { head, tail };
}

/** 给每个保留的字分配字幕行：先按对上的字定行，对不上的连续几个字按前后两行「行尾/行首各有多少改写的字」分给两边 */
function assignTokens(tokenLine: number[], head: number[], tail: number[]): number[] {
  const out = [...tokenLine];
  let s = 0;
  while (s < out.length) {
    if (out[s] >= 0) { s += 1; continue; }
    let e = s;
    while (e < out.length && out[e] < 0) e += 1;
    const a = s > 0 ? out[s - 1] : -1;
    const b = e < out.length ? out[e] : -1;
    const len = e - s;
    const toA = a < 0 ? 0 : b < 0 || a === b ? len : tail[a] + head[b] === 0 ? Math.ceil(len / 2) : Math.round((len * tail[a]) / (tail[a] + head[b]));
    for (let k = s; k < e; k += 1) out[k] = k - s < toA ? a : Math.max(b, 0);
    s = e;
  }
  return out;
}

/** 把模型给的字幕行文字逐字对齐回原稿，得出每行覆盖的保留下标；一个字都没分到的行并入前一行（首行则并入后一行） */
export function alignLines(tokens: Token[], kept: number[], texts: string[]): Alignment {
  const raw = kept.flatMap((idx, p) => alignChars(tokens[idx].text).map((ch) => ({ ch, p })));
  const pol = texts.flatMap((text, line) => alignChars(text).map((ch) => ({ ch, line })));
  const match = lcsMatch(raw.map((r) => r.ch), pol.map((q) => q.ch));
  const tokenLine = Array<number>(kept.length).fill(-1);
  raw.forEach((r, i) => { if (match[i] >= 0 && tokenLine[r.p] < 0) tokenLine[r.p] = pol[match[i]].line; });
  const matched = Array<boolean>(pol.length).fill(false);
  match.forEach((q) => { if (q >= 0) matched[q] = true; });
  const { head, tail } = unmatchedEdges(pol.map((q) => q.line), matched);
  const owner = assignTokens(tokenLine, head, tail);

  const groups = texts.map((text, line) => ({ text, ps: owner.flatMap((o, p) => (o === line ? [p] : [])) }));
  const merged = groups.reduce<{ text: string; ps: number[] }[]>((acc, g) => {
    if (g.ps.length > 0) return [...acc, { ...g }];
    if (acc.length === 0) return [{ ...g }]; // 首行没分到字：先占位，等下一行并入
    const last = acc[acc.length - 1];
    return [...acc.slice(0, -1), { text: last.text + g.text, ps: last.ps }];
  }, []);
  const lines = merged.reduce<{ text: string; ps: number[] }[]>((acc, g) => {
    const last = acc[acc.length - 1];
    if (last && last.ps.length === 0) return [...acc.slice(0, -1), { text: last.text + g.text, ps: g.ps }];
    return [...acc, g];
  }, []).filter((g) => g.ps.length > 0);

  const matchedCount = Array.from(match).filter((q) => q >= 0).length;
  return {
    lines: lines.map((g) => ({ from: kept[g.ps[0]], to: kept[g.ps[g.ps.length - 1]], text: g.text.trim() })),
    matchedRatio: raw.length === 0 ? 1 : matchedCount / raw.length,
  };
}

/** 超宽的行在宽度最均衡处切开（不切开英文单词/数字），递归直到每段不超宽；整段是一个英文单词时无法再切 */
export function splitWide(text: string, maxWidth: number): string[] {
  const t = text.trim();
  if (displayWidth(t) <= maxWidth) return t ? [t] : [];
  const ch = [...t];
  let best = -1;
  let bestDiff = Infinity;
  for (let i = 1; i < ch.length; i += 1) {
    if (isAsciiAlnum(ch[i - 1]) && isAsciiAlnum(ch[i])) continue;
    const diff = Math.abs(displayWidth(ch.slice(0, i).join('')) - displayWidth(ch.slice(i).join('')));
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  if (best < 0) return [t];
  return [...splitWide(ch.slice(0, best).join(''), maxWidth), ...splitWide(ch.slice(best).join(''), maxWidth)];
}
