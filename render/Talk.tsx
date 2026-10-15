import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { CANVAS, type TalkProps } from '../src/storyboard/schema.js';
import { THEME } from './theme.js';
import { PersonLayer } from './layers/PersonLayer.js';
import { CardLayer } from './layers/CardLayer.js';
import { CaptionLayer } from './layers/CaptionLayer.js';
import { AudioLayer } from './layers/AudioLayer.js';

/** 主合成：底色 → 人像 → 卡片 → 字幕 → 音频；所有动画由帧号驱动 */
export const Talk: React.FC<TalkProps> = (props) => {
  const frame = useCurrentFrame();
  const sec = frame / CANVAS.fps;
  return (
    <AbsoluteFill style={{ background: THEME.stage }}>
      <PersonLayer {...props} sec={sec} />
      <CardLayer shots={props.shots} sec={sec} />
      <CaptionLayer captions={props.captions} shots={props.shots} sec={sec} />
      <AudioLayer bgm={props.bgm} sfx={props.sfx} />
    </AbsoluteFill>
  );
};
