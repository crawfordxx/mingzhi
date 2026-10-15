import React from 'react';
import { Composition } from 'remotion';
import { CANVAS, type CardSpec, type TalkProps } from '../src/storyboard/schema.js';
import { Talk } from './Talk.js';
import { CardStill } from './layers/CardLayer.js';
import { CaptionStill } from './layers/CaptionLayer.js';
import type { CaptionStyleId } from '../src/captions/styles.js';

const EMPTY: TalkProps = { person: '', personWidth: 1080, personHeight: 1920, subject: null, captions: [], shots: [], durationSec: 1 };

export const Root: React.FC = () => (
  <>
    <Composition id="Talk" component={Talk} width={CANVAS.width} height={CANVAS.height} fps={CANVAS.fps} durationInFrames={CANVAS.fps}
      defaultProps={EMPTY} calculateMetadata={({ props }: { props: TalkProps }) => ({ durationInFrames: Math.max(1, Math.round(props.durationSec * CANVAS.fps)) })} />
    <Composition id="CardStill" component={CardStill} width={CANVAS.width} height={CANVAS.seam} fps={CANVAS.fps} durationInFrames={CANVAS.fps * 2}
      defaultProps={{ card: { template: 'title', props: { title: '示例' } } as CardSpec } as { card: CardSpec; dur?: number }}
      calculateMetadata={({ props }: { props: { card: CardSpec; dur?: number } }) => ({ durationInFrames: Math.max(1, Math.round((props.dur ?? 2) * CANVAS.fps)) })} />
    <Composition id="CaptionStill" component={CaptionStill} width={CANVAS.width} height={600} fps={CANVAS.fps} durationInFrames={CANVAS.fps}
      defaultProps={{ text: '这是一行示例字幕', captionStyle: 'blade' as CaptionStyleId, captionFontFile: '' } as { text: string; captionStyle: CaptionStyleId; captionFontFile: string; bg?: string }} />
  </>
);
