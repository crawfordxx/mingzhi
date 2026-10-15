import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { shotAt } from '../../src/compose/layout.js';
import type { CardSpec, Shot } from '../../src/storyboard/schema.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';
import { renderBackdrop, renderCard } from '../templates/index.js';

/** 出场：镜头最后 0.25 秒淡出并上移 30px（进场由 spring 驱动，约 0.5 秒收敛） */
const EXIT_SEC = 0.25;
const ENTER_DY = 80;
const ENTER_SCALE = 0.94;
const EXIT_DY = 30;

/** 卡片进出场：从下方 80px、0.94 缩放、透明度 0 弹入；结尾淡出上移 */
const CardMotion: React.FC<{ shot: Shot & { card: CardSpec }; sec: number }> = ({ shot, sec }) => {
  const { fps } = useVideoConfig();
  const local = sec - shot.start;
  const s = spring({ frame: Math.round(local * fps), fps, config: { damping: 16, mass: 0.7 } });
  const exit = interpolate(shot.end - sec, [0, EXIT_SEC], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const style: React.CSSProperties = {
    position: 'absolute', inset: 0,
    opacity: Math.min(s, 1 - exit),
    transform: `translateY(${interpolate(s, [0, 1], [ENTER_DY, 0]) - exit * EXIT_DY}px) scale(${interpolate(s, [0, 1], [ENTER_SCALE, 1])})`,
  };
  return <div style={style}>{renderCard(shot.card, local)}</div>;
};

/** 分屏镜头在上半屏（0–960）画卡片区底色、模板固定底与卡片；底色不随镜头切换闪烁。全屏镜头只叠加 cta */
export const CardLayer: React.FC<{ shots: Shot[]; sec: number }> = ({ shots, sec }) => {
  const hit = shotAt(shots, sec);
  if (!hit) return null;
  const { shot } = hit;
  if (shot.layout === 'full') {
    // 全屏只叠 cta：不画卡片区底色，胶囊由模板自己放在画布上方 y=180
    if (shot.card?.template !== 'cta') return null;
    return (
      <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam }}>
        <CardMotion shot={{ ...shot, card: shot.card }} sec={sec} />
      </div>
    );
  }
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam, background: THEME.stage, overflow: 'hidden' }}>
      {shot.card ? renderBackdrop(shot.card, sec - shot.start) : null}
      {shot.card ? <CardMotion shot={{ ...shot, card: shot.card }} sec={sec} /> : null}
    </div>
  );
};

/** 单卡静帧合成（1080×960）：不做进出场，直接画模板在当前帧的状态 */
export const CardStill: React.FC<{ card: CardSpec }> = ({ card }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame / fps;
  return (
    <AbsoluteFill style={{ background: THEME.stage }}>
      {renderBackdrop(card, local)}
      {renderCard(card, local)}
    </AbsoluteFill>
  );
};
