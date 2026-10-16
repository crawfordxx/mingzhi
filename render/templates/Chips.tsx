import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, CardFrame, SAFE_H, Reveal, SafeArea, clampLines, fitFontSize, fitScale, lineCount, springAt, textEm, useMinPx, type PropsOf, type TemplateProps } from './parts.js';

type Mark = 'yes' | 'no' | 'maybe';
type Group = PropsOf<'chips'>['groups'][number];

const PAD_X = 44;
const LABEL_W = 200;
const PILLS_W = CONTENT_W - PAD_X * 2 - LABEL_W - 20;
const PILL_H = 86;
const PILL_GAP = 14;
const ICON_GAP = 10;
const PILL_PAD = 50;
const ROW_PAD_Y = 40;
const CARD_PAD_Y = 24;
const LABEL_LH = 1.3;
/** 字段上限的极端输入（2 组 × 5 个 12 字标签）也要放进安全区：最多缩到 0.55（胶囊字仍有 23px） */
const MIN_SCALE = 0.55;
/** 第一个胶囊弹入的时间与相邻胶囊的间隔（秒）；音效触发点（src/audio/plan.ts）与之对拍 */
export const FIRST_POP = 0.15;
export const STAGGER = 0.12;
const MARKS: Record<Mark, { bg: string; fg: string }> = {
  yes: { bg: THEME.tint.yes, fg: THEME.greenText },
  no: { bg: THEME.tint.no, fg: THEME.redText },
  maybe: THEME.maybe,
};

/** 标签总数不多（≤ SPARSE_ITEMS）时整体放大，卡片不显空 */
const SPARSE_ITEMS = 4;
const SPARSE_ZOOM = 1.25;
const zoomOf = (groups: Group[]): number => (groups.reduce((n, g) => n + g.items.length, 0) <= SPARSE_ITEMS ? SPARSE_ZOOM : 1);

const pillPx = (text: string, k: number): number => fitFontSize(text, PILLS_W - 90, Math.round(42 * k), 22);
const labelPx = (label: string, k: number): number => fitFontSize(label, LABEL_W, Math.round(38 * k), 22, 2);
/** 实际字号：不低于当前表面的下限（浮层见 useMinPx） */
export const chipPillPx = (text: string, k: number, minPx: number): number => Math.max(minPx, pillPx(text, k));
export const chipLabelPx = (label: string, k: number, minPx: number): number => Math.max(minPx, labelPx(label, k));
export const chipsZoom = (groups: Group[]): number => zoomOf(groups);
/** 胶囊宽度估算：文字 + 图标 + 间距 + 左右内边距 */
const pillWidth = (text: string, k: number): number => {
  const px = pillPx(text, k);
  return textEm(text) * px + Math.round(px * 0.95) + ICON_GAP + PILL_PAD;
};

/** 按胶囊宽度排进 PILLS_W，估算折成几行 */
function pillRows(texts: string[], k: number): number {
  return texts.reduce((acc, t) => {
    const w = pillWidth(t, k);
    return acc.used > 0 && acc.used + PILL_GAP + w > PILLS_W ? { rows: acc.rows + 1, used: w } : { rows: acc.rows, used: acc.used + (acc.used > 0 ? PILL_GAP : 0) + w };
  }, { rows: 1, used: 0 }).rows;
}

/** 整张卡的估算高度（px），超出安全区时整体缩小 */
export function estimateChipsHeight(groups: Group[]): number {
  const k = zoomOf(groups);
  const rowsH = groups.reduce((h, g) => {
    const rows = pillRows(g.items.map((it) => it.text), k);
    const pills = rows * PILL_H * k + (rows - 1) * PILL_GAP;
    const label = lineCount(g.label, LABEL_W, labelPx(g.label, k)) * labelPx(g.label, k) * LABEL_LH;
    return h + Math.max(pills, label) + ROW_PAD_Y * 2;
  }, 0);
  return CARD_PAD_Y * 2 + rowsH + (groups.length - 1) * 2;
}

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
const Pill: React.FC<{ text: string; mark: Mark; p: number; k: number; minPx: number }> = ({ text, mark, p, k, minPx }) => {
  const px = chipPillPx(text, k, minPx);
  const c = MARKS[mark];
  return (
    <Reveal p={p} dy={10} from={0.6}>
      <div style={{ display: 'inline-flex', alignItems: 'center', gap: ICON_GAP, height: PILL_H * k, padding: '0 28px 0 22px', borderRadius: (PILL_H * k) / 2,
        background: c.bg, color: c.fg, fontSize: px, fontWeight: 700, whiteSpace: 'nowrap' }}>
        <MarkIcon mark={mark} size={Math.round(px * 0.95)} color={c.fg} />
        <span>{text}</span>
      </div>
    </Reveal>
  );
};

/** minPx > 0（浮层）时组名单独一行、胶囊排在下面，字号不低于 minPx（缩放后 ≥ 28px） */
const Row: React.FC<{ group: Group; first: number; divider: boolean; local: number; fps: number; k: number; minPx: number }> = ({ group, first, divider, local, fps, k, minPx }) => (
  <div style={{ display: 'flex', flexDirection: minPx ? 'column' : 'row', alignItems: minPx ? 'flex-start' : 'center', gap: 20, padding: `${ROW_PAD_Y}px 0`, borderTop: divider ? '2px solid #EFEDE9' : 'none' }}>
    <div style={{ width: minPx ? undefined : LABEL_W, flex: 'none', fontSize: chipLabelPx(group.label, k, minPx), fontWeight: 600, color: THEME.sub, lineHeight: LABEL_LH, ...clampLines(2) }}>{group.label}</div>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: PILL_GAP }}>
      {group.items.map((it, i) => <Pill key={i} text={it.text} mark={it.mark} k={k} minPx={minPx} p={springAt(local, FIRST_POP + (first + i) * STAGGER, fps, { damping: 12, mass: 0.6 })} />)}
    </div>
  </div>
);

/** 标签卡：白卡撑满卡片区，每组一行，左侧组名，右侧 yes/no/maybe 胶囊 */
export const Chips: React.FC<TemplateProps<'chips'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const k = zoomOf(props.groups);
  const firsts = props.groups.map((_, gi) => props.groups.slice(0, gi).reduce((n, g) => n + g.items.length, 0));
  const minPx = useMinPx();
  return (
    <SafeArea scale={minPx ? 1 : fitScale(estimateChipsHeight(props.groups), SAFE_H, MIN_SCALE)}>
      <CardFrame fill padding={`${CARD_PAD_Y}px ${PAD_X}px`}>
        {props.groups.map((g, gi) => <Row key={gi} group={g} first={firsts[gi]} divider={gi > 0} local={local} fps={fps} k={k} minPx={minPx} />)}
      </CardFrame>
    </SafeArea>
  );
};
