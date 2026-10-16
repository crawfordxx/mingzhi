import React from 'react';
import { AbsoluteFill, useVideoConfig } from 'remotion';
import { BROLL_HOOK_FADE_SEC, BROLL_HOOK_MARK_SEC, BROLL_HOOK_MARK_START, BROLL_HOOK_RISE_SEC } from '../templates/timing.js';
import { easeAt, fitFontSize, springAt } from '../templates/parts.js';
import { usePalette } from '../palette.js';
import { THEME } from '../theme.js';

/** 钩子文字一行：最宽 920px，字号 112 起、最小 64；行心在画布 y≈30%（避开顶部平台栏与 y=1400 的字幕） */
const TEXT_W = 920;
const BASE_PX = 112;
const MIN_PX = 64;
const CENTER_Y = 580;

/**
 * 开头全屏素材上的钩子文字：一行粗体白字（深色投影保证叠在任何图上都看得清），下缘一条高亮条从左刷开。
 * 文字从第 0 帧就完整可见（第 0 帧要有内容），入场只有轻微上浮与放大；镜头结束前淡出。local/dur 为镜头内秒数与时长
 */
export const BrollHook: React.FC<{ text: string; local: number; dur: number }> = ({ text, local, dur }) => {
  const { fps } = useVideoConfig();
  const pal = usePalette();
  const px = fitFontSize(text, TEXT_W, BASE_PX, MIN_PX);
  const rise = springAt(local, 0, fps, { damping: 16, mass: 0.7 });
  const mark = easeAt(local, BROLL_HOOK_MARK_START, BROLL_HOOK_MARK_SEC);
  const fade = 1 - easeAt(local, dur - BROLL_HOOK_FADE_SEC, BROLL_HOOK_FADE_SEC);
  const lift = (1 - Math.min(1, rise)) * 28;
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <div style={{ position: 'absolute', left: 0, right: 0, top: CENTER_Y, transform: `translateY(calc(-50% + ${lift}px)) scale(${0.94 + 0.06 * Math.min(1, rise)})`,
        display: 'flex', justifyContent: 'center', fontFamily: THEME.font }}>
        <div style={{ position: 'relative', fontSize: px, fontWeight: 900, lineHeight: 1.1, letterSpacing: '-0.01em', color: '#FFFFFF', whiteSpace: 'nowrap',
          textShadow: '0 4px 28px rgba(0, 0, 0, 0.55), 0 2px 6px rgba(0, 0, 0, 0.6)' }}>
          <span style={{ position: 'absolute', left: -12, right: -12, bottom: -px * 0.06, height: px * 0.14, borderRadius: px * 0.07, background: pal.accent, opacity: 0.95,
            transform: `scaleX(${mark})`, transformOrigin: 'left center', zIndex: -1 }} />
          {text}
        </div>
      </div>
    </AbsoluteFill>
  );
};
