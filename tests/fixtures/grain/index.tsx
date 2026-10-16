import React from 'react';
import { AbsoluteFill, Composition, Img, registerRoot, staticFile } from 'remotion';
import { GrainLayer } from '../../../render/layers/GrainLayer.js';
import type { PixelRegion } from '../../../render/layers/grain-field.js';

/** 颗粒层独立渲染用：默认中灰底（128）上只叠颗粒与暗角，便于量强度；传 bg（相对 publicDir）时铺一张图看观感 */
const GrainOn: React.FC<{ bg?: string; strength?: number; region?: PixelRegion | null }> = ({ bg, strength, region }) => (
  <AbsoluteFill style={{ background: '#808080' }}>
    {bg ? <Img src={staticFile(bg)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
    <GrainLayer {...(strength !== undefined ? { strength } : {})} region={region ?? null} />
  </AbsoluteFill>
);

const Root: React.FC = () => <Composition id="GrainTest" component={GrainOn} width={1080} height={1920} fps={30} durationInFrames={30} defaultProps={{} as { bg?: string; strength?: number; region?: PixelRegion | null }} />;

registerRoot(Root);
