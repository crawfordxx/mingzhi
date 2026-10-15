import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, Reveal, SafeArea, lineCount, springAt, type TemplateProps } from './parts.js';

/** 打字从镜头第几秒开始、每秒几个字、行与行之间停多久 */
export const TYPE_START = 0.25;
const CHARS_PER_SEC = 28;
const LINE_PAUSE = 0.2;

const WIN_H = 640;
const PAD_X = 40;
const BODY_W = CONTENT_W - PAD_X * 2;
const HEADER_H = 92;
const LINE_HEIGHT = 1.5;
const LINE_GAP_EM = 0.55;
/** 用户输入与回答之间多空一点 */
const PROMPT_GAP_EM = 1;
const MAX_PX = 32;
const MIN_PX = 22;
const PROMPT = '> ';
const TITLE_ORANGE = '#D97757';
const DOTS = ['#FF5F57', '#FEBC2E', '#28C840'];
const MONO_CJK = `${THEME.mono}, ${THEME.font}`;

const chars = (s: string): string[] => [...s];

/** 每行在 local 秒时已经打出的字数（按码点计） */
export function typedChars(lines: string[], local: number): number[] {
  const starts = lines.reduce<number[]>((acc, line, i) => (i === 0 ? [TYPE_START] : [...acc, acc[i - 1] + chars(lines[i - 1]).length / CHARS_PER_SEC + LINE_PAUSE]), []);
  return lines.map((line, i) => Math.min(chars(line).length, Math.max(0, Math.floor((local - starts[i]) * CHARS_PER_SEC + 1e-6))));
}

/** 内容估算高度不超过窗口时的最大字号 */
function bodyPx(lines: string[]): number {
  const avail = WIN_H - HEADER_H - 40;
  for (let px = MAX_PX; px > MIN_PX; px--) {
    const rows = lines.reduce((n, l, i) => n + lineCount((i === 0 ? PROMPT : '') + l, BODY_W, px), 0);
    if (rows * px * LINE_HEIGHT + (lines.length - 1) * px * LINE_GAP_EM + px * (PROMPT_GAP_EM - LINE_GAP_EM) <= avail) return px;
  }
  return MIN_PX;
}

/** 方块光标：正在打字时常亮，停下后每秒闪一次 */
const Caret: React.FC<{ typing: boolean; local: number }> = ({ typing, local }) => (
  <span style={{ display: 'inline-block', width: '0.6em', height: '1.1em', marginLeft: 2, verticalAlign: '-0.18em', background: '#E8E8E8',
    opacity: typing || local % 1 < 0.5 ? 1 : 0 }} />
);

/** 标题栏：红黄绿三点 + 橙色等宽标题 */
const Header: React.FC<{ title: string }> = ({ title }) => (
  <div style={{ height: HEADER_H, display: 'flex', alignItems: 'center', gap: 34, padding: `0 ${PAD_X}px` }}>
    <div style={{ display: 'flex', gap: 12 }}>{DOTS.map((c) => <span key={c} style={{ width: 18, height: 18, borderRadius: 9, background: c }} />)}</div>
    <div style={{ fontFamily: MONO_CJK, fontSize: 30, fontWeight: 700, color: TITLE_ORANGE, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>✻ {title}</div>
  </div>
);

/** 终端卡：深色窗口里逐字打出 lines，第一行是用户输入（带 > 提示符） */
export const Terminal: React.FC<TemplateProps<'terminal'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const typed = typedChars(props.lines, local);
  const px = bodyPx(props.lines);
  const caretAt = typed.reduce((last, n, i) => (n > 0 ? i : last), 0);
  const typing = typed.some((n, i) => n > 0 && n < chars(props.lines[i]).length);
  return (
    <SafeArea>
      <Reveal p={springAt(local, 0, fps)} dy={20}>
        <div style={{ height: WIN_H, background: THEME.terminal, borderRadius: 22, boxShadow: '0 28px 64px rgba(20, 16, 12, 0.30)', overflow: 'hidden' }}>
          <Header title={props.title ?? 'Claude Code'} />
          <div style={{ padding: `4px ${PAD_X}px`, fontFamily: MONO_CJK, fontSize: px, lineHeight: LINE_HEIGHT, color: '#E6E6E6', wordBreak: 'break-all' }}>
            {props.lines.map((line, i) => (i > 0 && typed[i] === 0 ? null : (
              <div key={i} style={{ marginTop: i === 0 ? 0 : `${i === 1 ? PROMPT_GAP_EM : LINE_GAP_EM}em`, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? '#FFFFFF' : '#D6D6D6' }}>
                {i === 0 ? <span style={{ color: '#9C9C9C' }}>{PROMPT}</span> : null}
                {chars(line).slice(0, typed[i]).join('')}
                {i === caretAt ? <Caret typing={typing} local={local} /> : null}
              </div>
            )))}
          </div>
        </div>
      </Reveal>
    </SafeArea>
  );
};
