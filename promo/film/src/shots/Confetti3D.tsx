// 影院高潮的 3D 彩纸：three.js 渲染小立方体（有光照明暗、真实翻滚），以 1/4 分辨率渲染再 4 倍像素放大
import React, { useMemo } from 'react';
import { ThreeCanvas } from '@remotion/three';
import { seeded } from '../kit/anim';

const COLORS = ['#014DF9', '#ffffff', '#c8402a', '#e9c77a', '#85a0e0', '#5f6b1e', '#3361cc'];

const Cubes: React.FC<{ t: number }> = ({ t }) => {
  const items = useMemo(() => {
    const r = seeded(2026);
    return Array.from({ length: 140 }, () => ({
      x0: (r() - 0.5) * 22, y0: 6 + r() * 6, z0: (r() - 0.5) * 6,
      vx: (r() - 0.5) * 1.6, vy: 2 + r() * 3, rx: (r() - 0.5) * 8, ry: (r() - 0.5) * 8,
      s: 0.18 + r() * 0.22, c: COLORS[Math.floor(r() * COLORS.length)], delay: r() * 0.5,
    }));
  }, []);
  return (
    <>
      <ambientLight intensity={0.55} />
      <directionalLight position={[4, 8, 6]} intensity={1.4} />
      {items.map((p, i) => {
        const tt = Math.max(0, t - p.delay);
        const y = p.y0 + p.vy * tt * 0.4 - 2.2 * tt * tt;
        const x = p.x0 + p.vx * tt;
        return (
          <mesh key={i} position={[x, y - 4, p.z0]} rotation={[p.rx * tt, p.ry * tt, 0]} visible={tt > 0}>
            <boxGeometry args={[p.s, p.s, p.s * 0.35]} />
            <meshLambertMaterial color={p.c} />
          </mesh>
        );
      })}
    </>
  );
};

/** t = 秒（从爆开起算）；W×H 为画面尺寸 */
export const Confetti3D: React.FC<{ t: number; W: number; H: number }> = ({ t, W, H }) => {
  const k = 4;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: W / k, height: H / k, transform: `scale(${k})`, transformOrigin: '0 0', zIndex: 60, pointerEvents: 'none' }}>
      <ThreeCanvas width={W / k} height={H / k} camera={{ fov: 50, position: [0, 0, 14] }} gl={{ antialias: false, alpha: true }} style={{ imageRendering: 'pixelated' }}>
        <Cubes t={t} />
      </ThreeCanvas>
    </div>
  );
};
