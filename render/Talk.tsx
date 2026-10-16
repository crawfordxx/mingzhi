import React from 'react';
import { AbsoluteFill, Freeze, useCurrentFrame } from 'remotion';
import { CANVAS, type TalkProps } from '../src/storyboard/schema.js';
import { captionSec, grainOn, visualShots } from '../src/compose/layout.js';
import { frameClock } from '../src/compose/frame-clock.js';
import { PaletteContext } from './palette.js';
import { DEFAULT_PALETTE } from '../src/compose/palette.js';
import { PersonLayer } from './layers/PersonLayer.js';
import { BrollLayer } from './layers/BrollLayer.js';
import { GrainLayer } from './layers/GrainLayer.js';
import { personRegionAt } from './layers/person-region.js';
import { CardLayer } from './layers/CardLayer.js';
import { CaptionLayer } from './layers/CaptionLayer.js';
import { AudioLayer } from './layers/AudioLayer.js';
import { Outro } from './templates/Outro.js';
import { CAPTION_STYLES, DEFAULT_CAPTION_STYLE } from '../src/captions/styles.js';
import { useCaptionFont } from './fonts.js';

/**
 * 主合成：底色 → 画中画素材底 → 人像（全屏插入时仍在播放，人声继续）→ 全屏插入素材 → 卡片 → 颗粒与暗角（全片一层，人像、素材、卡片同一质感）→ 字幕 → 音频；所有动画由帧号驱动。
 * 画面各层用画面时间轴（全屏插入晚 2 帧切入，J-cut）；音频按原时间；字幕在 J-cut 的 2 帧里仍显示切点前的那句，与画面同帧切换。
 * 颗粒层按 grainOn：旧项目（未设置且没用 B-roll）不加；人物所在区域颗粒减弱到 1/3（人脸不起麻点）。
 * 配色：props.palette（分镜阶段从人物背景推导的片色）经 PaletteContext 给卡片、钩子与片尾；旧项目没有时用原配色。
 * 结尾：镜头只覆盖口播内容；之后是最后一句话后的留白（人像、素材、卡片整体定格在内容末帧、不出声）和品牌片尾（outro，盖在定格画面上淡入），片尾在颗粒层之下，质感一致
 */
export const Talk: React.FC<TalkProps> = (props) => {
  const frame = useCurrentFrame();
  const sec = frame / CANVAS.fps;
  const styleId = props.captionStyle ?? DEFAULT_CAPTION_STYLE;
  useCaptionFont(CAPTION_STYLES[styleId].family, props.captionFontFile ?? '');
  const shots = React.useMemo(() => visualShots(props.shots), [props.shots]);
  // 镜头的末帧：之后卡片与素材定格（留白与片尾）；人像（口播内容）的末帧：之后人像定格并静音。
  // 两者通常相同；提前到片尾前的 CTA 超出口播内容结尾时，人像先定格，CTA 继续动（规则见 frameClock，分段哈希同口径）
  const { shotFrames, personFrames, shotHeld, personHeld, visualSec, personSec } = frameClock(props, frame);
  // 留白与片尾期间画面层（人像、素材、卡片）整体定格在末帧，卡片与素材不瞬间消失，由片尾的底色淡入一起盖住
  const palette = props.palette ?? DEFAULT_PALETTE;
  return (
    <PaletteContext.Provider value={palette}>
    <AbsoluteFill style={{ background: palette.stage }}>
      <Freeze frame={Math.max(0, personFrames - 1)} active={personHeld}>
        <BrollLayer shots={shots} sec={personSec} place="under" />
        <PersonLayer {...props} shots={shots} sec={personSec} muted={personHeld} />
        <BrollLayer shots={shots} sec={personSec} place="over" />
      </Freeze>
      <Freeze frame={Math.max(0, shotFrames - 1)} active={shotHeld}>
        <CardLayer shots={shots} sec={visualSec} />
      </Freeze>
      {props.outro ? <Outro outro={props.outro} sec={sec} /> : null}
      {grainOn(props) ? <GrainLayer region={personRegionAt({ ...props, shots }, personSec)} /> : null}
      <CaptionLayer captions={props.captions} shots={shots} sec={captionSec(props.shots, sec)} styleId={styleId} />
      <AudioLayer bgm={props.bgm} sfx={props.sfx} />
    </AbsoluteFill>
    </PaletteContext.Provider>
  );
};
