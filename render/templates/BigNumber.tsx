import React from 'react';
import { useVideoConfig } from 'remotion';
import { usePalette } from '../palette.js';
import { CONTENT_W, CardFrame, Reveal, SafeArea, SurfaceContext, clampLines, easeAt, fitFontSize, maxFontSize, springAt, textEm, useMinPx, type TemplateProps } from './parts.js';

const NUMBER_PX = 260;
/** 没有标签格时数字是整张卡的主体：更大，说明排在下方 */
const SOLO_NUMBER_PX = 330;
/** 纸面上的白卡内边距；数字与标签格按卡内宽度排 */
const FRAME_PAD_X = 56;
const INNER_W = CONTENT_W - FRAME_PAD_X * 2;
/** 标签格列数：标签少时列少、格子大（最多 6 列） */
const colsFor = (n: number): number => (n <= 3 ? 3 : n <= 8 ? 4 : 6);
const cellW = (cols: number): number => (INNER_W - GAP * (cols - 1)) / cols;
const GAP = 14;
const CELL_H = 76;
const SIDE_GAP = 36;
const SIDE_MIN_PX = 24;
/** 右侧说明排不到这么大就改排到数字下方（大字更好读） */
const SIDE_STACK_PX = 36;
/** 数字滚动的开始时间与时长（秒）；音效触发点（src/audio/plan.ts）与之对拍 */
export const COUNT_START = 0.05;
export const COUNT_SEC = 0.6;
/** 纯数字（可带千分位与小数）才做滚动 */
export const PURE_NUMBER = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

/** 数字在 0.6 秒内从 0 滚到目标值；非纯数字直接显示；滚完显示原字符串（保留前导零等写法） */
export function countUp(value: string, p: number): string {
  if (!PURE_NUMBER.test(value) || p >= 1) return value;
  const decimals = value.split('.')[1]?.length ?? 0;
  const target = Number(value.replace(/,/g, ''));
  const grouped = value.includes(',');
  return (target * p).toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: grouped });
}

/**
 * 大数字右侧（或下方）说明的排法与字号：右侧放不下时改到数字下方；浮层（minPx > 0）一律排到下方，字号不低于 minPx。
 * 允许折成两行换大字号（不为排成一行缩成小字）
 */
export function headerSide(value: string, unit: string | undefined, label: string, minPx: number): { stacked: boolean; px: number } {
  const numPx = fitFontSize(value, INNER_W * 0.62, NUMBER_PX, 80);
  const sideW = INNER_W - textEm(value) * numPx * 0.95 - SIDE_GAP;
  const side = unit ? `${unit} · ${label}` : label;
  const stacked = minPx > 0 || maxFontSize(side, sideW, 2) < SIDE_STACK_PX;
  return { stacked, px: Math.max(minPx, SIDE_MIN_PX, Math.min(46, maxFontSize(side, (stacked ? INNER_W : sideW) * 0.94, 2))) };
}

/** 标签格的字号与列数（浮层最多 3 列，字号不低于 minPx） */
export const cellPx = (text: string, w: number, minPx: number): number => Math.max(minPx, fitFontSize(text, w - 20, w > 200 ? 34 : 28, 17, 2));
export const cellCols = (n: number, minPx: number): number => (minPx ? Math.min(3, colsFor(n)) : colsFor(n));
export const cellWidth = (cols: number): number => cellW(cols);

/** 大数字 + 右侧 unit · label（右侧放不下时改到数字下方）；用隐藏的终值占位，滚动时右侧文字不跳 */
const Header: React.FC<{ value: string; unit?: string; label: string; p: number; minPx: number }> = ({ value, unit, label, p, minPx }) => {
  const pal = usePalette();
  const numPx = fitFontSize(value, INNER_W * 0.62, NUMBER_PX, 80);
  const { stacked, px: sidePx } = headerSide(value, unit, label, minPx);
  return (
    <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'baseline', gap: stacked ? 18 : SIDE_GAP }}>
      <div style={{ position: 'relative', flex: 'none', fontSize: numPx, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.045em', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ visibility: 'hidden' }}>{value}</span>
        <span style={{ position: 'absolute', left: 0, top: 0 }}>{countUp(value, p)}</span>
      </div>
      <div style={{ fontSize: sidePx, fontWeight: 700, lineHeight: 1.3, ...clampLines(2) }}>
        {unit ? <>{unit}<span style={{ color: pal.faint, margin: '0 0.35em' }}>·</span>{label}</> : label}
      </div>
    </div>
  );
};

/** 没有标签格时：超大数字与单位同一行，说明在下方，左侧一道主题绿竖条 */
const SoloHeader: React.FC<{ value: string; unit?: string; label: string; p: number }> = ({ value, unit, label, p }) => {
  const pal = usePalette();
  const unitPx = unit ? fitFontSize(unit, INNER_W * 0.3, 96, 40) : 0;
  const numPx = fitFontSize(value, INNER_W - (unit ? textEm(unit) * unitPx + SIDE_GAP : 0), SOLO_NUMBER_PX, 100);
  return (
    <div style={{ borderLeft: `10px solid ${pal.green}`, paddingLeft: 40 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SIDE_GAP / 2 }}>
        <div style={{ position: 'relative', flex: 'none', fontSize: numPx, fontWeight: 800, lineHeight: 0.92, letterSpacing: '-0.05em', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ visibility: 'hidden' }}>{value}</span>
          <span style={{ position: 'absolute', left: 0, top: 0 }}>{countUp(value, p)}</span>
        </div>
        {unit ? <div style={{ fontSize: unitPx, fontWeight: 800, color: pal.greenText, whiteSpace: 'nowrap' }}>{unit}</div> : null}
      </div>
      <div style={{ marginTop: 28, fontSize: fitFontSize(label, INNER_W - 50, 48, 28, 2), fontWeight: 700, lineHeight: 1.3, color: pal.ink, ...clampLines(2) }}>{label}</div>
    </div>
  );
};

const Cell: React.FC<{ text: string; hot: boolean; p: number; w: number; minPx: number }> = ({ text, hot, p, w, minPx }) => {
  const pal = usePalette();
  return (
  <Reveal p={p} dy={16} from={0.94}>
    <div style={{ height: minPx ? undefined : CELL_H, minHeight: CELL_H, paddingTop: minPx ? 10 : 0, paddingBottom: minPx ? 10 : 0, borderRadius: 16, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 8px',
      background: hot ? pal.tint.hot : pal.inset, border: hot ? `2.5px solid ${pal.green}` : '2.5px solid transparent',
      color: hot ? pal.greenText : pal.ink, fontSize: cellPx(text, w, minPx), fontWeight: hot ? 700 : 500, lineHeight: 1.2 }}>
      <span style={clampLines(2)}>{text}</span>
    </div>
  </Reveal>
  );
};

/** 大数字卡：巨大数字 + 3–6 列标签网格（highlight 的格子绿色描边）；纸面上放进撑满卡片区的白卡，图上与浮层套玻璃卡 */
export const BigNumber: React.FC<TemplateProps<'bigNumber'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const paper = React.useContext(SurfaceContext) === 'paper';
  // 浮层整块缩小显示：说明与标签格的字号不低于浮层字号下限（缩放后 ≥ 28px），标签格最多 3 列
  const minPx = useMinPx();
  const chips = props.chips ?? [];
  const cols = cellCols(chips.length, minPx);
  const hot = new Set(props.highlight ?? []);
  const body = (
    <>
      <Reveal p={springAt(local, 0, fps)} dy={20}>
        {chips.length === 0 && paper
          ? <SoloHeader value={props.value} unit={props.unit} label={props.label} p={easeAt(local, COUNT_START, COUNT_SEC)} />
          : <Header value={props.value} unit={props.unit} label={props.label} p={easeAt(local, COUNT_START, COUNT_SEC)} minPx={minPx} />}
      </Reveal>
      {chips.length > 0 ? (
        <div style={{ marginTop: 52, display: 'grid', gridTemplateColumns: `repeat(${cols}, 1fr)`, gap: GAP }}>
          {chips.map((c, i) => <Cell key={i} text={c} hot={hot.has(c)} w={cellW(cols)} minPx={minPx} p={springAt(local, 0.2 + i * 0.025, fps)} />)}
        </div>
      ) : null}
    </>
  );
  return paper ? <SafeArea><CardFrame fill padding={`56px ${FRAME_PAD_X}px`}>{body}</CardFrame></SafeArea> : <SafeArea glass>{body}</SafeArea>;
};
