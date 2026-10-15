import React from 'react';
import { Img, staticFile } from 'remotion';
import { captionAt, shotAt } from '../../src/compose/layout.js';
import type { Shot } from '../../src/storyboard/schema.js';
import type { TimedCaption } from '../../src/captions/lines.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { CAPTION_SIDE_MARGIN, CAPTION_STYLES, fitCaptionSize, splitHighlight, type CaptionStyle, type CaptionStyleId } from '../../src/captions/styles.js';
import { THEME } from '../theme.js';
import { useCaptionFont } from '../fonts.js';

/** 分屏时字幕中心压在分界线上，全屏时在 y≈1400 */
const FULL_CAPTION_Y = 1400;

/** 单条字幕的样式化文本（含自动缩字号、底框、关键数字染色），供成片与样式预览共用 */
export const CaptionText: React.FC<{ text: string; style: CaptionStyle }> = ({ text, style }) => {
  const { box, stroke, highlight } = style;
  const parts = highlight ? splitHighlight(text) : [{ text, hot: false }];
  return (
    <span style={{ fontFamily: `"${style.family}", ${THEME.font}`, fontSize: fitCaptionSize(text, style), fontWeight: style.weight, lineHeight: 1.25, color: style.color,
      ...(stroke ? { WebkitTextStroke: `${stroke.width}px ${stroke.color}`, paintOrder: 'stroke fill' } : {}),
      ...(box ? { background: box.color, borderRadius: box.radius, padding: `${box.padY}px ${box.padX}px`, boxDecorationBreak: 'clone' as const, WebkitBoxDecorationBreak: 'clone' as const } : {}) }}>
      {parts.map((p, i) => (p.hot ? <span key={i} style={{ color: highlight }}>{p.text}</span> : p.text))}
    </span>
  );
};

export const CaptionLayer: React.FC<{ captions: TimedCaption[]; shots: Shot[]; sec: number; styleId: CaptionStyleId }> = ({ captions, shots, sec, styleId }) => {
  const cap = captionAt(captions, sec);
  if (!cap) return null;
  const layout = shotAt(shots, sec)?.shot.layout ?? 'full';
  const centerY = layout === 'split' ? CANVAS.seam : FULL_CAPTION_Y;
  return (
    <div style={{ position: 'absolute', left: CAPTION_SIDE_MARGIN, right: CAPTION_SIDE_MARGIN, top: centerY, transform: 'translateY(-50%)', textAlign: 'center' }}>
      <CaptionText text={cap.text} style={CAPTION_STYLES[styleId]} />
    </div>
  );
};

/** 样式预览静帧：一行示例字幕，可选底图（相对 publicDir），供测试与 P5 预览 */
export const CaptionStill: React.FC<{ text: string; captionStyle: CaptionStyleId; captionFontFile: string; bg?: string }> = ({ text, captionStyle, captionFontFile, bg }) => {
  useCaptionFont(CAPTION_STYLES[captionStyle].family, captionFontFile);
  return (
  <div style={{ position: 'absolute', inset: 0, background: THEME.stage, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    {bg ? <Img src={staticFile(bg)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
    <div style={{ position: 'relative', textAlign: 'center', padding: `0 ${CAPTION_SIDE_MARGIN}px` }}>
      <CaptionText text={text} style={CAPTION_STYLES[captionStyle]} />
    </div>
  </div>
  );
};
