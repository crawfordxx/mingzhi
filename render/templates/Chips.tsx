import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, CardFrame, Reveal, SafeArea, fitFontSize, springAt, type PropsOf, type TemplateProps } from './parts.js';

type Mark = 'yes' | 'no' | 'maybe';
type Group = PropsOf<'chips'>['groups'][number];

const PAD_X = 44;
const LABEL_W = 190;
const PILLS_W = CONTENT_W - PAD_X * 2 - LABEL_W - 20;
const PILL_H = 66;
const STAGGER = 0.12;
const MARKS: Record<Mark, { bg: string; fg: string }> = {
  yes: { bg: '#E3F3E8', fg: THEME.badge['收益'] },
  no: { bg: '#FBE5E4', fg: THEME.red },
  maybe: { bg: '#EEEDEA', fg: '#8C877E' },
};

/** 勾、叉、问号图标（SVG，不依赖字体字形） */
const MarkIcon: React.FC<{ mark: Mark; size: number; color: string }> = ({ mark, size, color }) => {
  if (mark === 'maybe') return <span style={{ width: size, textAlign: 'center', fontWeight: 800, color }}>?</span>;
  const d = mark === 'yes' ? 'M4.5 12.5 L9.5 17.5 L19.5 6.5' : 'M6.5 6.5 L17.5 17.5 M17.5 6.5 L6.5 17.5';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ flex: 'none' }}>
      <path d={d} fill="none" stroke={color} strokeWidth={3.2} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
};

/** 胶囊：依次弹入（带一点过冲） */
const Pill: React.FC<{ text: string; mark: Mark; p: number }> = ({ text, mark, p }) => {
  const px = fitFontSize(text, PILLS_W - 90, 32, 20);
  const c = MARKS[mark];
  return (
    <Reveal p={p} dy={10} from={0.6}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10, height: PILL_H, padding: '0 28px 0 22px', borderRadius: PILL_H / 2,
        background: c.bg, color: c.fg, fontSize: px, fontWeight: 700, whiteSpace: 'nowrap' }}>
        <MarkIcon mark={mark} size={Math.round(px * 0.95)} color={c.fg} />
        <span>{text}</span>
      </div>
    </Reveal>
  );
};

const Row: React.FC<{ group: Group; first: number; divider: boolean; local: number; fps: number }> = ({ group, first, divider, local, fps }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 20, padding: '28px 0', borderTop: divider ? '2px solid #EFEDE9' : 'none' }}>
    <div style={{ width: LABEL_W, flex: 'none', fontSize: fitFontSize(group.label, LABEL_W, 32, 20, 2), fontWeight: 600, color: THEME.sub, lineHeight: 1.3 }}>{group.label}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14 }}>
      {group.items.map((it, i) => <Pill key={i} text={it.text} mark={it.mark} p={springAt(local, 0.15 + (first + i) * STAGGER, fps, { damping: 12, mass: 0.6 })} />)}
    </div>
  </div>
);

/** 标签卡：每组一行，左侧组名，右侧 yes/no/maybe 胶囊 */
export const Chips: React.FC<TemplateProps<'chips'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const firsts = props.groups.map((_, gi) => props.groups.slice(0, gi).reduce((n, g) => n + g.items.length, 0));
  return (
    <SafeArea>
      <CardFrame padding={`12px ${PAD_X}px`}>
        {props.groups.map((g, gi) => <Row key={gi} group={g} first={firsts[gi]} divider={gi > 0} local={local} fps={fps} />)}
      </CardFrame>
    </SafeArea>
  );
};
