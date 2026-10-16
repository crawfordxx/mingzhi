import React from 'react';
import { Composition } from 'remotion';
import './kit/fonts';
import { Film } from './Film';
import { T } from './timeline';

export const Root: React.FC = () => (
  <>
    <Composition id="Launch169" component={Film} durationInFrames={T.END} fps={30} width={1920} height={1080} />
    <Composition id="Launch916" component={Film} durationInFrames={T.END} fps={30} width={1080} height={1920} />
  </>
);
