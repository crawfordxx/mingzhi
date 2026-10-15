import React from 'react';
import { AbsoluteFill, Easing, Img, interpolate, staticFile, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, Reveal, SAFE, clampLines, fitFontSize, springAt, type TemplateProps } from './parts.js';

/** Ken Burns：多少秒内推近多少 */
const ZOOM_SEC = 6;
const ZOOM = 0.06;
const LABEL_PAD_X = 30;
const LABEL_TEXT_W = CONTENT_W - LABEL_PAD_X * 2;
/** 标签卡底边离卡片区底部的距离（避开压在分界线上的字幕） */
const LABEL_BOTTOM = 960 - SAFE.bottom + 50;

/** 图片底：铺满卡片区并缓慢推近；不随卡片进出场移动 */
export const PhotoBackdrop: React.FC<TemplateProps<'photo'>> = ({ props, local }) => {
  const zoom = interpolate(local, [0, ZOOM_SEC], [0, ZOOM], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.sin) });
  return (
    <AbsoluteFill style={{ background: '#111111' }}>
      <Img src={staticFile(props.image)} style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'center 30%', transform: `scale(${1 + zoom})` }} />
    </AbsoluteFill>
  );
};

/** 图片卡：左下角白色半透明标签卡（label 粗体、sublabel 灰字）；都没有时不画 */
export const Photo: React.FC<TemplateProps<'photo'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  if (!props.label && !props.sublabel) return null;
  return (
    <div style={{ position: 'absolute', left: SAFE.side, bottom: LABEL_BOTTOM, maxWidth: CONTENT_W, fontFamily: THEME.font, color: THEME.ink }}>
      <Reveal p={springAt(local, 0.15, fps)} dy={22}>
        <div style={{ padding: `22px ${LABEL_PAD_X}px 24px`, borderRadius: 24, background: 'rgba(255, 255, 255, 0.86)', backdropFilter: 'blur(14px)',
          boxShadow: '0 14px 36px rgba(0, 0, 0, 0.18)' }}>
          {props.label ? <div style={{ fontSize: fitFontSize(props.label, LABEL_TEXT_W, 40, 28), fontWeight: 800, lineHeight: 1.3, whiteSpace: 'nowrap' }}>{props.label}</div> : null}
          {props.sublabel ? (
            <div style={{ marginTop: props.label ? 8 : 0, fontSize: fitFontSize(props.sublabel, LABEL_TEXT_W, 27, 21, 2), fontWeight: 500, lineHeight: 1.4, color: THEME.sub, ...clampLines(2) }}>{props.sublabel}</div>
          ) : null}
        </div>
      </Reveal>
    </div>
  );
};
