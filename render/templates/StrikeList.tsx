import React from 'react';
import { interpolateColors, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, Crumb, Reveal, SafeArea, easeAt, springAt, textEm, type TemplateProps } from './parts.js';

const TEXT_PX = 38;
const PILL_H = 104;
const PILL_PAD_X = 44;
const MIN_PILL_W = 540;
const GAP = 24;
/** 第一项出现时间、项与项的间隔、出现后多久开始划、划线时长（秒） */
const FIRST = 0.12;
const STAGGER = 0.42;
const STRIKE_DELAY = 0.18;
const STRIKE_SEC = 0.3;
const STRIKE_COLOR = 'rgba(224, 72, 72, 0.88)';

/** 一项：浅色胶囊，出现后红线从左到右划过，文字随之变淡、胶囊略微退后 */
const Item: React.FC<{ text: string; width: number; p: number; strike: number }> = ({ text, width, p, strike }) => (
  <Reveal p={p} dx={-36} dy={0}>
    <div style={{ position: 'relative', width, height: PILL_H, boxSizing: 'border-box', padding: `0 ${PILL_PAD_X}px`, display: 'flex', alignItems: 'center',
      borderRadius: 26, background: `rgba(255, 255, 255, ${0.82 - strike * 0.22})`, boxShadow: `0 12px 32px rgba(40, 30, 20, ${0.09 - strike * 0.05})`,
      transform: `scale(${1 - strike * 0.02})`, transformOrigin: 'left center' }}>
      <span style={{ fontSize: TEXT_PX, fontWeight: 600, whiteSpace: 'nowrap', color: interpolateColors(strike, [0, 1], [THEME.ink, THEME.faint]) }}>{text}</span>
      <div style={{ position: 'absolute', left: PILL_PAD_X - 12, right: PILL_PAD_X - 12, top: PILL_H / 2 + 1, height: 4, borderRadius: 2, background: STRIKE_COLOR,
        transform: `scaleX(${strike})`, transformOrigin: 'left center' }} />
    </div>
  </Reveal>
);

/** 划掉清单：竖排胶囊依次出现并被红线划掉；title 作面包屑 */
export const StrikeList: React.FC<TemplateProps<'strikeList'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const width = Math.min(CONTENT_W, Math.max(MIN_PILL_W, Math.max(...props.items.map(textEm)) * TEXT_PX + PILL_PAD_X * 2 + 8));
  return (
    <SafeArea>
      {props.title ? <Reveal p={springAt(local, 0, fps)} dy={12} style={{ marginBottom: 34 }}><Crumb text={props.title} /></Reveal> : null}
      <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
        {props.items.map((it, i) => {
          const at = FIRST + i * STAGGER;
          return <Item key={i} text={it} width={width} p={springAt(local, at, fps)} strike={easeAt(local, at + STRIKE_DELAY, STRIKE_SEC)} />;
        })}
      </div>
    </SafeArea>
  );
};
