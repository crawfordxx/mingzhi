import React from 'react';
import { interpolateColors, useVideoConfig } from 'remotion';
import { usePalette } from '../palette.js';
import { CONTENT_W, CardFrame, Crumb, EXIT_SEC, Reveal, SafeArea, easeAt, fitFontSize, fitScale, itemTimes, springAt, textEm, type TemplateProps } from './parts.js';

const TEXT_PX = 46;
const MIN_TEXT_PX = 30;
const PILL_H = 112;
const PILL_PAD_X = 44;
const GAP = 20;
/** 白卡内边距；胶囊在卡内铺满一行 */
const FRAME_PAD_X = 40;
const PILL_W = CONTENT_W - FRAME_PAD_X * 2;
/** 第一项出现时间、项与项的间隔、出现后多久开始划、划线时长（秒） */
const FIRST = 0.12;
const STAGGER = 0.42;
const STRIKE_DELAY = 0.18;
const STRIKE_SEC = 0.3;
const STRIKE_COLOR = 'rgba(224, 72, 72, 0.88)';
/** 一项从出现到划完的时长（秒） */
export const STRIKE_END = STRIKE_DELAY + STRIKE_SEC;
/** 最后一道划线至少在出场前多久划完（秒） */
const DONE_BEFORE_EXIT = 0.3;
const STRIKE_PAD = 12;

/** 每项出现的时间：默认间隔 STAGGER；镜头短时压缩间隔，让最后一道划线在出场前 DONE_BEFORE_EXIT 秒划完 */
export function strikeStarts(n: number, dur: number): number[] {
  const room = dur - EXIT_SEC - DONE_BEFORE_EXIT - FIRST - STRIKE_END;
  const stagger = n > 1 ? Math.max(0, Math.min(STAGGER, room / (n - 1))) : 0;
  return Array.from({ length: n }, (_, i) => FIRST + i * stagger);
}

/** 胶囊内文字最宽多少 */
const MAX_TEXT_W = PILL_W - PILL_PAD_X * 2;
const itemPx = (text: string): number => fitFontSize(text, MAX_TEXT_W, TEXT_PX, MIN_TEXT_PX);

/** 一项：卡内浅色胶囊，出现后红线从左到右划过，文字随之变淡、胶囊略微退后；划线不超出胶囊内宽；pending 时先画虚线占位 */
const Item: React.FC<{ text: string; p: number; strike: number; pending: boolean }> = ({ text, p, strike, pending }) => {
  const px = itemPx(text);
  const lineW = Math.min(textEm(text) * px, PILL_W - PILL_PAD_X * 2) + STRIKE_PAD * 2;
  const pal = usePalette();
  return (
  <div style={{ position: 'relative' }}>
  {pending ? <div style={{ position: 'absolute', inset: 0, borderRadius: 26, border: `2.5px dashed ${pal.track}`, opacity: Math.max(0, 1 - p * 1.5) }} /> : null}
  <Reveal p={p} dx={-36} dy={0}>
    <div style={{ position: 'relative', width: PILL_W, height: PILL_H, boxSizing: 'border-box', padding: `0 ${PILL_PAD_X}px`, display: 'flex', alignItems: 'center',
      borderRadius: 26, background: pal.inset, opacity: 1 - strike * 0.25,
      transform: `scale(${1 - strike * 0.02})`, transformOrigin: 'left center' }}>
      <span style={{ fontSize: px, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: interpolateColors(strike, [0, 1], [pal.ink, pal.faint]) }}>{text}</span>
      <div style={{ position: 'absolute', left: PILL_PAD_X - STRIKE_PAD, width: lineW, top: PILL_H / 2 + 1, height: 4, borderRadius: 2, background: STRIKE_COLOR,
        transform: `scaleX(${strike})`, transformOrigin: 'left center' }} />
    </div>
  </Reveal>
  </div>
  );
};

/** 估算卡片高度：面包屑 + 各项胶囊 + 卡片上下内边距 96 */
export const estimateStrikeHeight = (n: number, title: boolean): number => 96 + (title ? 70 : 0) + n * PILL_H + (n - 1) * GAP;

/** 划掉清单：白卡里竖排胶囊依次出现并被红线划掉；title 作面包屑；有 reveal 时随口播逐项出现、划掉 */
export const StrikeList: React.FC<TemplateProps<'strikeList'>> = ({ props, local, dur }) => {
  const { fps } = useVideoConfig();
  const fallback = strikeStarts(props.items.length, dur);
  const starts = itemTimes(props.reveal, props.items.length, (i) => fallback[i], dur);
  const evolving = props.reveal?.length === props.items.length;
  return (
    <SafeArea scale={fitScale(estimateStrikeHeight(props.items.length, Boolean(props.title)))}>
      <CardFrame fill padding={`48px ${FRAME_PAD_X}px`}>
        {props.title ? <Reveal p={springAt(local, 0, fps)} dy={12} style={{ marginBottom: 30, marginLeft: 8 }}><Crumb text={props.title} size={30} /></Reveal> : null}
        <div style={{ display: 'flex', flexDirection: 'column', gap: GAP }}>
          {props.items.map((it, i) => {
            const at = starts[i];
            return <Item key={i} text={it} pending={evolving} p={springAt(local, at, fps)} strike={easeAt(local, at + STRIKE_DELAY, STRIKE_SEC)} />;
          })}
        </div>
      </CardFrame>
    </SafeArea>
  );
};
