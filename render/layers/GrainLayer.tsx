import React, { useLayoutEffect, useRef } from 'react';
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from 'remotion';
import { GRAIN_SEED, GRAIN_STRENGTH, VIGNETTE, grainField, grainLift, type PixelRegion } from './grain-field.js';

export { GRAIN_SEED, GRAIN_STRENGTH, VIGNETTE } from './grain-field.js';

const vignetteGradient = (amount: number): string =>
  `radial-gradient(ellipse farthest-corner at 50% 50%, rgba(0,0,0,0) 45%, rgba(0,0,0,${(amount * 0.45).toFixed(3)}) 78%, rgba(0,0,0,${amount.toFixed(3)}) 100%)`;

/**
 * 质感层：单色细颗粒（只改亮度、不带颜色，1 像素 1 颗粒，按帧号确定性生成）+ 轻暗角。
 * region：人物区域（画布像素），区域内颗粒强度降到 1/3，边缘羽化；不传则全幅一样。
 * 叠在全片最上层、字幕之下；不拦截任何内容，不改变画面尺寸。
 */
export const GrainLayer: React.FC<{ strength?: number; vignette?: number; seed?: number; region?: PixelRegion | null }> = ({
  strength = GRAIN_STRENGTH, vignette = VIGNETTE, seed = GRAIN_SEED, region = null,
}) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const ref = useRef<HTMLCanvasElement>(null);
  const rx = region?.x, ry = region?.y, rw = region?.w, rh = region?.h;
  useLayoutEffect(() => {
    const ctx = ref.current?.getContext('2d');
    if (!ctx || strength <= 0) return;
    const r = rx === undefined || ry === undefined || rw === undefined || rh === undefined ? null : { x: rx, y: ry, w: rw, h: rh };
    ctx.putImageData(new ImageData(grainField(frame, width, height, { strength, seed, region: r }), width, height), 0, 0);
  }, [frame, width, height, strength, seed, rx, ry, rw, rh]);
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {strength > 0 ? (
        <>
          <AbsoluteFill style={{ background: `rgba(0,0,0,${grainLift(strength).toFixed(4)})` }} />
          <canvas ref={ref} width={width} height={height} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', mixBlendMode: 'plus-lighter' }} />
        </>
      ) : null}
      {vignette > 0 ? <AbsoluteFill style={{ background: vignetteGradient(vignette) }} /> : null}
    </AbsoluteFill>
  );
};
