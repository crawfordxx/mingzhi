// 本任务的占位实现；Task 3 换成模板注册表
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { shotAt } from '../../src/compose/layout.js';
import type { CardSpec, Shot } from '../../src/storyboard/schema.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

const Placeholder: React.FC<{ card: CardSpec }> = ({ card }) => (
  <div style={{ position: 'absolute', left: 90, right: 90, top: 300, padding: 48, background: THEME.card, borderRadius: THEME.radius, boxShadow: THEME.shadow, fontFamily: THEME.font, fontSize: 56, color: THEME.ink }}>
    {card.template}
  </div>
);

/** 分屏镜头在上半屏（0–960）画卡片区底色与卡片 */
export const CardLayer: React.FC<{ shots: Shot[]; sec: number }> = ({ shots, sec }) => {
  const hit = shotAt(shots, sec);
  if (!hit || hit.shot.layout !== 'split') return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam, background: THEME.stage, overflow: 'hidden' }}>
      {hit.shot.card ? <Placeholder card={hit.shot.card} /> : null}
    </div>
  );
};

/** 单卡静帧合成（1080×960） */
export const CardStill: React.FC<{ card: CardSpec }> = ({ card }) => (
  <AbsoluteFill style={{ background: THEME.stage }}>
    <Placeholder card={card} />
  </AbsoluteFill>
);
