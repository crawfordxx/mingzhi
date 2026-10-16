import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, EXIT_SEC, Reveal, SafeArea, springAt, type TemplateProps } from './parts.js';

/** 打字从镜头第几秒开始、每秒几个字、行与行之间停多久 */
export const TYPE_START = 0.25;
const CHARS_PER_SEC = 28;
const LINE_PAUSE = 0.2;
/** 全部打完至少要在出场前多久（秒），另留一点浮点余量 */
const DONE_BEFORE_EXIT = 0.4;
const SLACK = 0.02;
/** 时间再紧也至少留这么久给打字（秒） */
const MIN_TYPE_SEC = 0.3;

const WIN_H = 660;
const PAD_X = 40;
const BODY_W = CONTENT_W - PAD_X * 2;
const HEADER_H = 92;
const LINE_HEIGHT = 1.5;
const LINE_GAP_EM = 0.55;
/** 用户输入与回答之间多空一点 */
const PROMPT_GAP_EM = 1;
const MAX_PX = 38;
const MIN_PX = 22;
const PROMPT = '> ';
const DOTS = ['#FF5F57', '#FEBC2E', '#28C840'];
const MONO_CJK = `${THEME.mono}, ${THEME.font}`;

const chars = (s: string): string[] => [...s];

/** 打字速度：默认每秒 28 字；镜头短时加快，保证在出场前 DONE_BEFORE_EXIT 秒打完 */
export function typingRate(lines: string[], dur: number): number {
  const total = lines.reduce((n, l) => n + chars(l).length, 0);
  const available = dur - EXIT_SEC - DONE_BEFORE_EXIT - SLACK - TYPE_START - LINE_PAUSE * (lines.length - 1);
  return Math.max(CHARS_PER_SEC, total / Math.max(MIN_TYPE_SEC, available));
}

/** 每行在 local 秒时已经打出的字数（按码点计）；dur 为镜头时长 */
export function typedChars(lines: string[], local: number, dur = Infinity): number[] {
  const rate = typingRate(lines, dur);
  const starts = lines.reduce<number[]>((acc, line, i) => (i === 0 ? [TYPE_START] : [...acc, acc[i - 1] + chars(lines[i - 1]).length / rate + LINE_PAUSE]), []);
  return lines.map((line, i) => Math.min(chars(line).length, Math.max(0, Math.floor((local - starts[i]) * rate + 1e-6))));
}

/** 等宽字体下的宽度估算：ASCII 约 0.6em，其余 1em */
const monoEm = (text: string): number => chars(text).reduce((n, ch) => n + (ch.charCodeAt(0) < 128 ? 0.6 : 1), 0);
const monoLines = (text: string, widthPx: number, px: number): number => Math.max(1, Math.ceil((monoEm(text) * px) / widthPx));

/** 内容估算高度不超过窗口时的最大字号 */
function bodyPx(lines: string[]): number {
  const avail = WIN_H - HEADER_H - 40;
  for (let px = MAX_PX; px > MIN_PX; px--) {
    const rows = lines.reduce((n, l, i) => n + monoLines((i === 0 ? PROMPT : '') + l, BODY_W, px), 0);
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
    <div style={{ fontFamily: MONO_CJK, fontSize: 30, fontWeight: 700, color: THEME.termInk.title, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>✻ {title}</div>
  </div>
);

/** 终端卡：深色窗口里逐字打出 lines，第一行是用户输入（带 > 提示符） */
export const Terminal: React.FC<TemplateProps<'terminal'>> = ({ props, local, dur }) => {
  const { fps } = useVideoConfig();
  const typed = typedChars(props.lines, local, dur);
  const px = bodyPx(props.lines);
  const caretAt = typed.reduce((last, n, i) => (n > 0 ? i : last), 0);
  const typing = typed.some((n, i) => n > 0 && n < chars(props.lines[i]).length);
  return (
    <SafeArea>
      <Reveal p={springAt(local, 0, fps)} dy={20}>
        <div style={{ height: WIN_H, background: THEME.terminal, borderRadius: 22, boxShadow: '0 16px 36px rgba(20, 16, 12, 0.24)', overflow: 'hidden' }}>
          <Header title={props.title ?? 'Claude Code'} />
          <div style={{ padding: `4px ${PAD_X}px`, fontFamily: MONO_CJK, fontSize: px, lineHeight: LINE_HEIGHT, wordBreak: 'break-all' }}>
            {props.lines.map((line, i) => (i > 0 && typed[i] === 0 ? null : (
              <div key={i} style={{ marginTop: i === 0 ? 0 : `${i === 1 ? PROMPT_GAP_EM : LINE_GAP_EM}em`, fontWeight: i === 0 ? 700 : 500, color: i === 0 ? THEME.termInk.head : THEME.termInk.body }}>
                {i === 0 ? <span style={{ color: THEME.termInk.prompt }}>{PROMPT}</span> : null}
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
