import React from 'react';
import { Composition } from 'remotion';
import { CANVAS, type CardSpec, type Shot, type TalkProps } from '../src/storyboard/schema.js';
import { Talk } from './Talk.js';
import { CardStill } from './layers/CardLayer.js';
import { CaptionStill } from './layers/CaptionLayer.js';
import type { CaptionStyleId } from '../src/captions/styles.js';
import { Cover } from './Cover.js';
import type { Palette } from '../src/compose/palette.js';
import type { CoverProps } from '../src/cover/styles.js';

/** 单卡静帧：shot 给出时按成片画这个镜头的卡片区（整片自检量铺图卡片可读性），hideText 时文字透明，palette 为片色 */
type CardStillProps = { card: CardSpec; dur?: number; shot?: Shot; hideText?: boolean; palette?: Palette };
const EMPTY_COVER: CoverProps = { bg: '', person: '', style: 'bauhaus' };
const EMPTY: TalkProps = { person: '', personWidth: 1080, personHeight: 1920, subject: null, captions: [], shots: [], durationSec: 1 };

export const Root: React.FC = () => (
  <>
    <Composition id="Talk" component={Talk} width={CANVAS.width} height={CANVAS.height} fps={CANVAS.fps} durationInFrames={CANVAS.fps}
      defaultProps={EMPTY} calculateMetadata={({ props }: { props: TalkProps }) => ({ durationInFrames: Math.max(1, Math.round(props.durationSec * CANVAS.fps)) })} />
    <Composition id="CardStill" component={CardStill} width={CANVAS.width} height={CANVAS.seam} fps={CANVAS.fps} durationInFrames={CANVAS.fps * 2}
      defaultProps={{ card: { template: 'title', props: { title: '示例' } } as CardSpec } as CardStillProps}
      calculateMetadata={({ props }: { props: CardStillProps }) => ({ durationInFrames: Math.max(1, Math.round((props.dur ?? 2) * CANVAS.fps)) })} />
    <Composition id="CaptionStill" component={CaptionStill} width={CANVAS.width} height={600} fps={CANVAS.fps} durationInFrames={CANVAS.fps}
      defaultProps={{ text: '这是一行示例字幕', captionStyle: 'blade' as CaptionStyleId, captionFontFile: '' } as { text: string; captionStyle: CaptionStyleId; captionFontFile: string; bg?: string }} />
    <Composition id="Cover34" component={Cover} width={1080} height={1440} fps={CANVAS.fps} durationInFrames={1} defaultProps={EMPTY_COVER} />
    <Composition id="Cover43" component={Cover} width={1440} height={1080} fps={CANVAS.fps} durationInFrames={1} defaultProps={EMPTY_COVER} />
  </>
);
