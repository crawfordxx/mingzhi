import type { Token } from './types.js';

const MAX_TOKEN_SEC = 0.5;
const round = (n: number): number => Math.round(n * 1000) / 1000;

/** SenseVoice 时间戳相对片段起点，这里转成原片绝对时间并补上 end；空白 token 丢弃 */
export function buildTokens(raw: { tokens: string[]; timestamps: number[] }, offsetSec: number, segEndSec: number): Token[] {
  const result: Token[] = [];
  raw.tokens.forEach((tok, i) => {
    const text = tok.trim();
    if (!text) return;
    const start = round(offsetSec + raw.timestamps[i]);
    const nextStart = i + 1 < raw.tokens.length ? offsetSec + raw.timestamps[i + 1] : segEndSec;
    const end = round(Math.min(nextStart, start + MAX_TOKEN_SEC, segEndSec));
    result.push({ text, start, end: Math.max(end, round(start + 0.02)) });
  });
  return result;
}
