import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, CardFrame, Reveal, SafeArea, SurfaceContext, clampLines, easeAt, fitFontSize, maxFontSize, springAt, textEm, type TemplateProps } from './parts.js';

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
const CELL_BG = '#F4F1EC';
const SIDE_GAP = 36;
const SIDE_MIN_PX = 24;
/** 右侧说明排不到这么大就改排到数字下方（大字更好读） */
const SIDE_STACK_PX = 36;
const GREEN = THEME.green;
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

/** 大数字 + 右侧 unit · label（右侧放不下时改到数字下方）；用隐藏的终值占位，滚动时右侧文字不跳 */
const Header: React.FC<{ value: string; unit?: string; label: string; p: number }> = ({ value, unit, label, p }) => {
  const numPx = fitFontSize(value, INNER_W * 0.62, NUMBER_PX, 80);
  const sideW = INNER_W - textEm(value) * numPx * 0.95 - SIDE_GAP;
  const side = unit ? `${unit} · ${label}` : label;
  const stacked = maxFontSize(side, sideW, 2) < SIDE_STACK_PX;
  // 允许折成两行换大字号（不为排成一行缩成小字）
  const sidePx = Math.max(SIDE_MIN_PX, Math.min(46, maxFontSize(side, (stacked ? INNER_W : sideW) * 0.94, 2)));
  return (
    <div style={{ display: 'flex', flexDirection: stacked ? 'column' : 'row', alignItems: stacked ? 'flex-start' : 'baseline', gap: stacked ? 18 : SIDE_GAP }}>
      <div style={{ position: 'relative', flex: 'none', fontSize: numPx, fontWeight: 800, lineHeight: 1, letterSpacing: '-0.045em', fontVariantNumeric: 'tabular-nums' }}>
        <span style={{ visibility: 'hidden' }}>{value}</span>
        <span style={{ position: 'absolute', left: 0, top: 0 }}>{countUp(value, p)}</span>
      </div>
      <div style={{ fontSize: sidePx, fontWeight: 700, lineHeight: 1.3, ...clampLines(2) }}>
        {unit ? <>{unit}<span style={{ color: THEME.faint, margin: '0 0.35em' }}>·</span>{label}</> : label}
      </div>
    </div>
  );
};

/** 没有标签格时：超大数字与单位同一行，说明在下方，左侧一道主题绿竖条 */
const SoloHeader: React.FC<{ value: string; unit?: string; label: string; p: number }> = ({ value, unit, label, p }) => {
  const unitPx = unit ? fitFontSize(unit, INNER_W * 0.3, 96, 40) : 0;
  const numPx = fitFontSize(value, INNER_W - (unit ? textEm(unit) * unitPx + SIDE_GAP : 0), SOLO_NUMBER_PX, 100);
  return (
    <div style={{ borderLeft: `10px solid ${GREEN}`, paddingLeft: 40 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: SIDE_GAP / 2 }}>
        <div style={{ position: 'relative', flex: 'none', fontSize: numPx, fontWeight: 800, lineHeight: 0.92, letterSpacing: '-0.05em', fontVariantNumeric: 'tabular-nums' }}>
          <span style={{ visibility: 'hidden' }}>{value}</span>
          <span style={{ position: 'absolute', left: 0, top: 0 }}>{countUp(value, p)}</span>
        </div>
        {unit ? <div style={{ fontSize: unitPx, fontWeight: 800, color: THEME.greenText, whiteSpace: 'nowrap' }}>{unit}</div> : null}
      </div>
      <div style={{ marginTop: 28, fontSize: fitFontSize(label, INNER_W - 50, 48, 28, 2), fontWeight: 700, lineHeight: 1.3, color: THEME.ink, ...clampLines(2) }}>{label}</div>
    </div>
  );
};

const Cell: React.FC<{ text: string; hot: boolean; p: number; w: number }> = ({ text, hot, p, w }) => (
  <Reveal p={p} dy={16} from={0.94}>
    <div style={{ height: CELL_H, borderRadius: 16, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 8px',
      background: hot ? THEME.tint.hot : CELL_BG, border: hot ? `2.5px solid ${GREEN}` : '2.5px solid transparent',
      color: hot ? THEME.greenText : THEME.ink, fontSize: fitFontSize(text, w - 20, w > 200 ? 34 : 28, 17, 2), fontWeight: hot ? 700 : 500, lineHeight: 1.2 }}>
      <span style={clampLines(2)}>{text}</span>
    </div>
  </Reveal>
);

/** 大数字卡：巨大数字 + 3–6 列标签网格（highlight 的格子绿色描边）；纸面上放进撑满卡片区的白卡，图上与浮层套玻璃卡 */
export const BigNumber: React.FC<TemplateProps<'bigNumber'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const paper = React.useContext(SurfaceContext) === 'paper';
  const chips = props.chips ?? [];
  const hot = new Set(props.highlight ?? []);
  const body = (
    <>
      <Reveal p={springAt(local, 0, fps)} dy={20}>
        {chips.length === 0 && paper
          ? <SoloHeader value={props.value} unit={props.unit} label={props.label} p={easeAt(local, COUNT_START, COUNT_SEC)} />
          : <Header value={props.value} unit={props.unit} label={props.label} p={easeAt(local, COUNT_START, COUNT_SEC)} />}
      </Reveal>
      {chips.length > 0 ? (
        <div style={{ marginTop: 52, display: 'grid', gridTemplateColumns: `repeat(${colsFor(chips.length)}, 1fr)`, gap: GAP }}>
          {chips.map((c, i) => <Cell key={i} text={c} hot={hot.has(c)} w={cellW(colsFor(chips.length))} p={springAt(local, 0.2 + i * 0.025, fps)} />)}
        </div>
      ) : null}
    </>
  );
  return paper ? <SafeArea><CardFrame fill padding={`56px ${FRAME_PAD_X}px`}>{body}</CardFrame></SafeArea> : <SafeArea glass>{body}</SafeArea>;
};
