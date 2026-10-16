import React from 'react';
import { AbsoluteFill, Img, staticFile, useVideoConfig } from 'remotion';
import { OUTRO_LOGO_SEC, type OutroProps } from '../../src/compose/ending.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';
import { Reveal, easeAt, fitFontSize, springAt } from './parts.js';

const LOGO_PX = 240;
const LOGO_RADIUS = 56;
/** 文字最宽、字号范围（px） */
const TEXT_W = CANVAS.width - 2 * 120;
const TEXT_BASE_PX = 46;
const TEXT_MIN_PX = 28;
const TEXT_GAP = 56;
/** 内容中心略高于画布中线，视觉上居中（下方是平台字幕与操作区） */
const CENTER_Y = 900;
/** 底色淡入时长、文字相对 logo 弹出的延迟与淡入时长（秒） */
const VEIL_SEC = 0.35;
const TEXT_DELAY = 0.3;
const TEXT_SEC = 0.45;

/**
 * 品牌片尾：整屏米色底从最后一句后的定格画面上淡入，产品 logo 弹出（OUTRO_LOGO_SEC，logo 音对准它），
 * 文字随后上浮淡入；没有文字时只放 logo。sec 为整片时间轴上的秒，片尾开始前不画
 */
export const Outro: React.FC<{ outro: OutroProps; sec: number }> = ({ outro, sec }) => {
  const { fps } = useVideoConfig();
  const local = sec - outro.startSec;
  if (local < 0) return null;
  const px = fitFontSize(outro.text, TEXT_W, TEXT_BASE_PX, TEXT_MIN_PX);
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ background: THEME.stage, opacity: easeAt(local, 0, VEIL_SEC) }} />
      <div style={{ position: 'absolute', left: 0, right: 0, top: CENTER_Y, transform: 'translateY(-50%)', display: 'flex', flexDirection: 'column', alignItems: 'center', fontFamily: THEME.font }}>
        <Reveal p={springAt(local, OUTRO_LOGO_SEC, fps, { damping: 13, mass: 0.7 })} dy={0} from={0.6}>
          <Img src={staticFile(outro.logo)} style={{ width: LOGO_PX, height: LOGO_PX, borderRadius: LOGO_RADIUS, boxShadow: THEME.shadow, display: 'block' }} />
        </Reveal>
        {outro.text ? (
          <Reveal p={easeAt(local, OUTRO_LOGO_SEC + TEXT_DELAY, TEXT_SEC)} dy={18} style={{ marginTop: TEXT_GAP, fontSize: px, fontWeight: 700, letterSpacing: '0.1em', color: THEME.ink, whiteSpace: 'nowrap' }}>
            {outro.text}
          </Reveal>
        ) : null}
      </div>
    </AbsoluteFill>
  );
};
