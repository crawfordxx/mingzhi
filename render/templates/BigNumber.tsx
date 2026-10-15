import React from 'react';
import { useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, Reveal, SafeArea, clampLines, easeAt, fitFontSize, maxFontSize, springAt, textEm, type TemplateProps } from './parts.js';

const NUMBER_PX = 150;
const COLS = 6;
const GAP = 14;
const CELL_W = (CONTENT_W - GAP * (COLS - 1)) / COLS;
const CELL_H = 68;
const SIDE_GAP = 36;
const SIDE_MIN_PX = 24;
const GREEN = THEME.badge['收益'];
/** 纯数字（可带千分位与小数）才做滚动 */
const PURE_NUMBER = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;

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
  const numPx = fitFontSize(value, CONTENT_W * 0.62, NUMBER_PX, 72);
  const sideW = CONTENT_W - textEm(value) * numPx * 0.95 - SIDE_GAP;
  const side = unit ? `${unit} · ${label}` : label;
  const stacked = maxFontSize(side, sideW, 2) < SIDE_MIN_PX;
  const sidePx = fitFontSize(side, stacked ? CONTENT_W : sideW, 40, SIDE_MIN_PX, 2);
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

const Cell: React.FC<{ text: string; hot: boolean; p: number }> = ({ text, hot, p }) => (
  <Reveal p={p} dy={16} from={0.94}>
    <div style={{ height: CELL_H, borderRadius: 16, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'center', textAlign: 'center', padding: '0 8px',
      background: hot ? '#F2FAF4' : THEME.card, border: hot ? `2.5px solid ${GREEN}` : '2.5px solid transparent', boxShadow: hot ? 'none' : '0 3px 10px rgba(40, 30, 20, 0.05)',
      color: hot ? GREEN : THEME.ink, fontSize: fitFontSize(text, CELL_W - 22, 25, 17, 2), fontWeight: hot ? 700 : 500, lineHeight: 1.2 }}>
      <span style={clampLines(2)}>{text}</span>
    </div>
  </Reveal>
);

/** 大数字卡：巨大数字 + 6 列标签网格（highlight 的格子绿色描边） */
export const BigNumber: React.FC<TemplateProps<'bigNumber'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const chips = props.chips ?? [];
  const hot = new Set(props.highlight ?? []);
  return (
    <SafeArea>
      <Reveal p={springAt(local, 0, fps)} dy={20}>
        <Header value={props.value} unit={props.unit} label={props.label} p={easeAt(local, 0.05, 0.6)} />
      </Reveal>
      {chips.length > 0 ? (
        <div style={{ marginTop: 52, display: 'grid', gridTemplateColumns: `repeat(${COLS}, 1fr)`, gap: GAP }}>
          {chips.map((c, i) => <Cell key={i} text={c} hot={hot.has(c)} p={springAt(local, 0.2 + i * 0.025, fps)} />)}
        </div>
      ) : null}
    </SafeArea>
  );
};
