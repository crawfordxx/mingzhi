import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CANVAS, type TalkProps } from '../src/storyboard/schema.js';
import { captionSec, grainOn, visualShots } from '../src/compose/layout.js';
import { THEME } from './theme.js';
import { PersonLayer } from './layers/PersonLayer.js';
import { BrollLayer } from './layers/BrollLayer.js';
import { GrainLayer } from './layers/GrainLayer.js';
import { CardLayer } from './layers/CardLayer.js';
import { CaptionLayer } from './layers/CaptionLayer.js';
import { AudioLayer } from './layers/AudioLayer.js';
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE } from '../src/captions/styles.js';
import { useCaptionFont } from './fonts.js';

/**
 * 主合成：底色 → 画中画素材底 → 人像（全屏插入时仍在播放，人声继续）→ 全屏插入素材 → 卡片 → 颗粒与暗角（全片一层，人像、素材、卡片同一质感）→ 字幕 → 音频；所有动画由帧号驱动。
 * 画面各层用画面时间轴（全屏插入晚 2 帧切入，J-cut）；音频按原时间；字幕在 J-cut 的 2 帧里仍显示切点前的那句，与画面同帧切换。
 * 颗粒层按 grainOn：旧项目（未设置且没用 B-roll）不加
 */
export const Talk: React.FC<TalkProps> = (props) => {
  const frame = useCurrentFrame();
  const sec = frame / CANVAS.fps;
  const styleId = props.captionStyle ?? DEFAULT_CAPTION_STYLE;
  useCaptionFont(CAPTION_STYLES[styleId].family, props.captionFontFile ?? '');
  const shots = React.useMemo(() => visualShots(props.shots), [props.shots]);
  return (
    <AbsoluteFill style={{ background: THEME.stage }}>
      <BrollLayer shots={shots} sec={sec} place="under" />
      <PersonLayer {...props} shots={shots} sec={sec} />
      <BrollLayer shots={shots} sec={sec} place="over" />
      <CardLayer shots={shots} sec={sec} />
      {grainOn(props) ? <GrainLayer /> : null}
      <CaptionLayer captions={props.captions} shots={shots} sec={captionSec(props.shots, sec)} styleId={styleId} />
      <AudioLayer bgm={props.bgm} sfx={props.sfx} />
    </AbsoluteFill>
  );
};
