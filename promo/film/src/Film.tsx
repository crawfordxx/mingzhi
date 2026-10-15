// 全片编排：按全局帧号挂各幕；相邻幕在转场处重叠渲染（时间轴见 timeline.ts / 导演稿 Part IV）
import React from 'react';
import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { Open } from './shots/Open';
import { Act1 } from './shots/Act1';
import { Act2 } from './shots/Act2';
import { Breath } from './shots/Breath';
import { Act3 } from './shots/Act3';
import { Cinema } from './shots/Cinema';
import { End } from './shots/End';
import { Hud } from './kit/hud';

export const Film: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ background: '#f7f7f7', overflow: 'hidden' }}>
      <style>{'canvas{image-rendering:pixelated}'}</style>
      {f >= 78 && f < 497 ? <Act1 f={f} /> : null}
      {f >= 487 && f < 752 ? <Act2 f={f} /> : null}
      {f >= 815 && f < 1178 ? <Act3 f={f} /> : null}
      {f >= 740 && f < 834 ? <Breath f={f} /> : null}
      {f >= 1160 && f < 1446 ? <Cinema f={f} /> : null}
      {f >= 1436 ? <End f={f} /> : null}
      {f < 96 ? <Open f={f} /> : null}
      <Hud f={f} />
    </AbsoluteFill>
  );
};
