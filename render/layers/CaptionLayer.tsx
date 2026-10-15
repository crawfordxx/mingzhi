import React from 'react';
import { captionAt, shotAt } from '../../src/compose/layout.js';
import type { Shot } from '../../src/storyboard/schema.js';
import type { TimedCaption } from '../../src/captions/lines.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';

/** 分屏时字幕中心压在分界线上，全屏时在 y≈1400 */
const FULL_CAPTION_Y = 1400;
/** 字号与描边（描边约为字号的 15%） */
const CAPTION_PX = 58;
const CAPTION_STROKE_PX = 9;

export const CaptionLayer: React.FC<{ captions: TimedCaption[]; shots: Shot[]; sec: number }> = ({ captions, shots, sec }) => {
  const cap = captionAt(captions, sec);
  if (!cap) return null;
  const layout = shotAt(shots, sec)?.shot.layout ?? 'full';
  const centerY = layout === 'split' ? CANVAS.seam : FULL_CAPTION_Y;
  return (
    <div style={{ position: 'absolute', left: 60, right: 60, top: centerY, transform: 'translateY(-50%)', textAlign: 'center',
      fontFamily: THEME.font, fontSize: CAPTION_PX, fontWeight: 800, lineHeight: 1.25, color: '#FFFFFF',
      WebkitTextStroke: `${CAPTION_STROKE_PX}px #000000`, paintOrder: 'stroke fill' }}>
      {cap.text}
    </div>
  );
};
