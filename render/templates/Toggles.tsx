import React from 'react';
import { interpolate, useVideoConfig } from 'remotion';
import { usePalette } from '../palette.js';
import { Cursor, cursorAt, type Click } from './cursor.js';
import { CONTENT_W, CardFrame, EXIT_SEC, Reveal, SafeArea, clampLines, fitFontSize, springAt, type TemplateProps } from './parts.js';

const PAD_X = 44;
const INNER_W = CONTENT_W - PAD_X * 2;
const ROW_H = 132;
const TRACK_W = 100;
const TRACK_H = 60;
const KNOB = 52;
const ON = '#34C759';
/** 第一个开关在镜头第几秒被点开，之后每个间隔多久 */
const FIRST_CLICK = 0.6;
const CLICK_GAP = 0.5;
/** 开关拨动动画约多久、最后一次拨完至少在出场前多久（秒） */
const SWITCH_SEC = 0.3;
const DONE_BEFORE_EXIT = 0.3;

/** k 次点击的时间：默认间隔 CLICK_GAP；镜头短时压缩间隔，让最后一次拨动在出场前完成 */
export function clickTimes(k: number, dur: number): number[] {
  const room = dur - EXIT_SEC - DONE_BEFORE_EXIT - SWITCH_SEC - FIRST_CLICK;
  const gap = k > 1 ? Math.max(0, Math.min(CLICK_GAP, room / (k - 1))) : 0;
  return Array.from({ length: k }, (_, j) => FIRST_CLICK + j * gap);
}
/** 光标从第一个开关右下方多远处滑进来 */
const CURSOR_FROM = { x: 150, y: 170 };

/** iOS 风格开关：p 为 0（关）→ 1（开） */
const Switch: React.FC<{ p: number }> = ({ p }) => {
  const k = Math.min(1, Math.max(0, p));
  const off = usePalette().track;
  return (
    <div style={{ position: 'relative', flex: 'none', width: TRACK_W, height: TRACK_H, borderRadius: TRACK_H / 2, background: off }}>
      <div style={{ position: 'absolute', inset: 0, borderRadius: TRACK_H / 2, background: ON, opacity: k }} />
      <div style={{ position: 'absolute', top: (TRACK_H - KNOB) / 2, left: (TRACK_H - KNOB) / 2 + p * (TRACK_W - TRACK_H), width: KNOB, height: KNOB, borderRadius: KNOB / 2,
        background: '#FFFFFF', boxShadow: '0 3px 8px rgba(0, 0, 0, 0.18), 0 0 0 0.5px rgba(0, 0, 0, 0.04)' }} />
    </div>
  );
};

/** 每个 on 行的点击：光标尖端落在开关右半边 */
function clicksFor(rows: { on: boolean }[], dur: number): (Click & { row: number })[] {
  const onRows = rows.map((r, i) => (r.on ? i : -1)).filter((i) => i >= 0);
  const times = clickTimes(onRows.length, dur);
  return onRows.map((row, j) => ({ row, x: INNER_W - TRACK_W * 0.3, y: row * ROW_H + ROW_H / 2 + 8, t: times[j] }));
}

/** 开关设置卡：小字标题 + 每行 label 与开关；on 的开关被光标依次点开；底部红色注释 */
export const Toggles: React.FC<TemplateProps<'toggles'>> = ({ props, local, dur }) => {
  const { fps } = useVideoConfig();
  const clicks = clicksFor(props.rows, dur);
  const clickOf = new Map(clicks.map((c) => [c.row, c.t]));
  const pal = usePalette();
  const divider = `2px solid ${pal.track}`;
  const cursor = clicks.length ? cursorAt(local, { x: clicks[0].x + CURSOR_FROM.x, y: clicks[0].y + CURSOR_FROM.y }, clicks) : null;
  return (
    <SafeArea>
      <CardFrame fill padding={`36px ${PAD_X}px 40px`}>
        {props.title ? (
          <Reveal p={springAt(local, 0.05, fps)} dy={12}>
            <div style={{ fontSize: fitFontSize(props.title, INNER_W, 30, 22), fontWeight: 600, color: pal.sub, paddingBottom: 22, borderBottom: divider, whiteSpace: 'nowrap' }}>{props.title}</div>
          </Reveal>
        ) : null}
        <div style={{ position: 'relative' }}>
          {props.rows.map((r, i) => {
            const t = clickOf.get(i);
            const p = t === undefined ? 0 : springAt(local, t, fps, { damping: 15, mass: 0.5 });
            return (
              <Reveal key={i} p={springAt(local, 0.1 + i * 0.07, fps)} dx={-30} dy={0}>
                <div style={{ height: ROW_H, boxSizing: 'border-box', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24, borderTop: i > 0 ? divider : 'none' }}>
                  <div style={{ fontSize: fitFontSize(r.label, INNER_W - TRACK_W - 24, 46, 28), fontWeight: 700, whiteSpace: 'nowrap' }}>{r.label}</div>
                  <div style={{ transform: `scale(${interpolate(p, [0, 0.5, 1], [1, 0.94, 1], { extrapolateRight: 'clamp' })})` }}><Switch p={p} /></div>
                </div>
              </Reveal>
            );
          })}
          {cursor ? <Cursor state={cursor} /> : null}
        </div>
        {props.footnote ? (
          <Reveal p={springAt(local, 0.2 + props.rows.length * 0.07, fps)} dy={10}>
            <div style={{ marginTop: 18, fontSize: fitFontSize(props.footnote, INNER_W, 31, 22, 2), fontWeight: 600, lineHeight: 1.4, color: pal.redText, ...clampLines(2) }}>{props.footnote}</div>
          </Reveal>
        ) : null}
      </CardFrame>
    </SafeArea>
  );
};
