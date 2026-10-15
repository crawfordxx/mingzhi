import React from 'react';
import { interpolate, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { Cursor, cursorAt, type Click } from './cursor.js';
import { CONTENT_W, CardFrame, Reveal, SafeArea, clampLines, fitFontSize, springAt, type TemplateProps } from './parts.js';

const PAD_X = 44;
const INNER_W = CONTENT_W - PAD_X * 2;
const ROW_H = 116;
const TRACK_W = 100;
const TRACK_H = 60;
const KNOB = 52;
const OFF = '#E4E2DE';
const ON = '#34C759';
const DIVIDER = '2px solid #EFEDE9';
/** 第一个开关在镜头第几秒被点开，之后每个间隔多久 */
const FIRST_CLICK = 0.6;
const CLICK_GAP = 0.5;
/** 光标从第一个开关右下方多远处滑进来 */
const CURSOR_FROM = { x: 150, y: 170 };

/** iOS 风格开关：p 为 0（关）→ 1（开） */
const Switch: React.FC<{ p: number }> = ({ p }) => {
  const k = Math.min(1, Math.max(0, p));
  return (
    <div style={{ position: 'relative', flex: 'none', width: TRACK_W, height: TRACK_H, borderRadius: TRACK_H / 2, background: OFF }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: TRACK_H / 2, background: ON, opacity: k }} />
      <div style={{ position: 'absolute', top: (TRACK_H - KNOB) / 2, left: (TRACK_H - KNOB) / 2 + p * (TRACK_W - TRACK_H), width: KNOB, height: KNOB, borderRadius: KNOB / 2,
        background: '#FFFFFF', boxShadow: '0 3px 8px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.04)' }} />
    </div>
  );
};

/** 每个 on 行的点击：光标尖端落在开关右半边 */
function clicksFor(rows: { on: boolean }[]): (Click & { row: number })[] {
  const onRows = rows.map((r, i) => (r.on ? i : -1)).filter((i) => i >= 0);
  return onRows.map((row, j) => ({ row, x: INNER_W - TRACK_W * 0.3, y: row * ROW_H + ROW_H / 2 + 8, t: FIRST_CLICK + j * CLICK_GAP }));
}

/** 开关设置卡：小字标题 + 每行 label 与开关；on 的开关被光标依次点开；底部红色注释 */
export const Toggles: React.FC<TemplateProps<'toggles'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const clicks = clicksFor(props.rows);
  const clickOf = new Map(clicks.map((c) => [c.row, c.t]));
  const cursor = clicks.length ? cursorAt(local, { x: clicks[0].x + CURSOR_FROM.x, y: clicks[0].y + CURSOR_FROM.y }, clicks) : null;
  return (
    <SafeArea>
      <CardFrame padding={`30px ${PAD_X}px 36px`}>
        {props.title ? (
          <Reveal p={springAt(local, 0.05, fps)} dy={12}>
            <div style={{ fontSize: fitFontSize(props.title, INNER_W, 26, 20), fontWeight: 600, color: THEME.sub, paddingBottom: 22, borderBottom: DIVIDER, whiteSpace: 'nowrap' }}>{props.title}</div>
          </Reveal>
        ) : null}
        <div style={{ position: 'relative' }}>
          {props.rows.map((r, i) => {
            const t = clickOf.get(i);
            const p = t === undefined ? 0 : springAt(local, t, fps, { damping: 15, mass: 0.5 });
            return (
              <Reveal key={i} p={springAt(local, 0.1 + i * 0.07, fps)} dx={-30} dy={0}>
                <div style={{ height: ROW_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, borderTop: i > 0 ? DIVIDER : 'none' }}>
                  <div style={{ fontSize: fitFontSize(r.label, INNER_W - TRACK_W - 24, 38, 26), fontWeight: 700, whiteSpace: 'nowrap' }}>{r.label}</div>
                  <div style={{ transform: `scale(${interpolate(p, [0, 0.5, 1], [1, 0.94, 1], { extrapolateRight: 'clamp' })})` }}><Switch p={p} /></div>
                </div>
              </Reveal>
            );
          })}
          {cursor ? <Cursor state={cursor} /> : null}
        </div>
        {props.footnote ? (
          <Reveal p={springAt(local, 0.2 + props.rows.length * 0.07, fps)} dy={10}>
            <div style={{ marginTop: 18, fontSize: fitFontSize(props.footnote, INNER_W, 27, 20, 2), fontWeight: 600, lineHeight: 1.4, color: THEME.red, ...clampLines(2) }}>{props.footnote}</div>
          </Reveal>
        ) : null}
      </CardFrame>
    </SafeArea>
  );
};
