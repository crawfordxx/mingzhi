import React from 'react';
import { useVideoConfig } from 'remotion';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';
import { Cursor, cursorAt, type Click } from './cursor.js';
import { Reveal, easeAt, fitFontSize, springAt, type TemplateProps } from './parts.js';

/** 胶囊行顶边在画布上的 y（全屏镜头的上方，避开平台状态栏；胶囊中心约 280，与参考片一致） */
export const CTA_TOP = 230;
const PILL_W = 280;
const PILL_H = 100;
const GAP = 60;
const CHECK_PX = 34;
/** 按动作文字取色：关注红、点赞橙、收藏金 */
const ACTION_COLORS: Record<string, string> = { 关注: '#F2334B', 点赞: '#FF7A2F', 收藏: '#F5A623' };
/** 其他动作按序号取备用色 */
const FALLBACK_COLORS = ['#2F6FE0', '#7B4FD6', '#2F9E58'];

export function ctaColor(action: string, index: number): string {
  return ACTION_COLORS[action] ?? FALLBACK_COLORS[index % FALLBACK_COLORS.length];
}
/** 第一次点击时间与间隔（秒） */
const FIRST_CLICK = 0.5;
const CLICK_GAP = 0.5;
const FLIP_SEC = 0.18;
const PRESS_SEC = 0.24;
/** 光标从第一个胶囊下方多远处滑进来 */
const CURSOR_FROM = { x: 70, y: 300 };

const CheckIcon: React.FC = () => (
  <svg width={CHECK_PX} height={CHECK_PX} viewBox="0 0 24 24" style={{ flex: 'none' }}>
    <path d="M4.5 12.5 L9.5 17.5 L19.5 6.5" fill="none" stroke="#FFFFFF" strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" />
  </svg>
);

/** 一个胶囊：白底灰字；被点后翻成彩底白字带 ✓，按下时轻微缩一下 */
const Pill: React.FC<{ text: string; color: string; flip: number; press: number }> = ({ text, color, flip, press }) => {
  const px = fitFontSize(text, PILL_W - 60 - CHECK_PX, 38, 24);
  const face: React.CSSProperties = { position: 'absolute', inset: 0, borderRadius: PILL_H / 2, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
    fontSize: px, fontWeight: 800, letterSpacing: '0.06em', whiteSpace: 'nowrap' };
  return (
    <div style={{ position: 'relative', width: PILL_W, height: PILL_H, transform: `scale(${1 - press * 0.08})`, boxShadow: '0 12px 30px rgba(0, 0, 0, 0.22)', borderRadius: PILL_H / 2 }}>
      <div style={{ ...face, background: 'rgba(250, 249, 247, 0.94)', color: '#55524D' }}>{text}</div>
      <div style={{ ...face, background: color, color: '#FFFFFF', opacity: flip }}><CheckIcon />{text}</div>
    </div>
  );
};

/** 三连 CTA：全屏镜头上方一排胶囊，光标依次点击，每个点完变成彩色 */
export const Cta: React.FC<TemplateProps<'cta'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const n = props.actions.length;
  const left0 = (CANVAS.width - n * PILL_W - (n - 1) * GAP) / 2;
  const clicks: Click[] = props.actions.map((_, i) => ({ x: left0 + i * (PILL_W + GAP) + PILL_W * 0.84, y: CTA_TOP + PILL_H * 0.66, t: FIRST_CLICK + i * CLICK_GAP }));
  const cursor = cursorAt(local, { x: clicks[0].x + CURSOR_FROM.x, y: clicks[0].y + CURSOR_FROM.y }, clicks);
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: THEME.font }}>
      {props.actions.map((a, i) => {
        const age = local - clicks[i].t;
        const press = age >= 0 && age < PRESS_SEC ? Math.sin((Math.PI * age) / PRESS_SEC) : 0;
        return (
          <Reveal key={i} p={springAt(local, 0.05 + i * 0.08, fps, { damping: 12, mass: 0.6 })} dy={-16} from={0.7}
            style={{ position: 'absolute', left: left0 + i * (PILL_W + GAP), top: CTA_TOP }}>
            <Pill text={a} color={ctaColor(a, i)} flip={easeAt(local, clicks[i].t, FLIP_SEC)} press={press} />
          </Reveal>
        );
      })}
      <Cursor state={cursor} />
    </div>
  );
};
