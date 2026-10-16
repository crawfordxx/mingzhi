// 世界层：相机（只有 1x / 1.5x / 2x 三档整数像素变焦）、像素化油画、Seedance 花园循环、前景视差、字幕地砖
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F } from './theme';
import { PxImg, useV } from './px';
import { clamp, seeded } from './anim';

export const WORLD_W = 3240;
export type Cam = { x: number; y: number; z: number };

/** 相机视口：横版铺满 1920×1080；竖版是画面下部 1080×1080 的窗口（y 760 起），上方留给 HUD 与文字 */
export const WorldView: React.FC<{ cam: Cam; camVx?: number; children: React.ReactNode; style?: React.CSSProperties; worldW?: number }> = ({ cam, camVx, children, style, worldW = WORLD_W }) => {
  const { v } = useV();
  const VW = v ? 1080 : 1920;
  const VH = 1080;
  const z = cam.z;
  const half = VW / 2 / z;
  const cx = v ? clamp(camVx ?? cam.x, half, worldW - half) : cam.x;
  const tx = Math.round(VW / 2 - cx * z);
  const ty = Math.round(VH / 2 - cam.y * z);
  return (
    <div style={{ position: 'absolute', left: 0, top: v ? 760 : 0, width: VW, height: VH, overflow: 'hidden', ...style }}>
      <div style={{ position: 'absolute', left: 0, top: 0, width: worldW, height: 1200, transformOrigin: '0 0', transform: `translate(${tx}px,${ty}px) scale(${z})` }}>{children}</div>
      {v ? <i style={{ position: 'absolute', left: 0, top: 0, width: VW, height: 6, background: C.ink, zIndex: 60 }} /> : null}
    </div>
  );
};

/** 像素化油画：color 8px 一格（405×135），raw 16px 一格（203×68，原片态） */
export const WorldImg: React.FC<{ kind: 'color' | 'raw'; style?: React.CSSProperties }> = ({ kind, style }) =>
  kind === 'raw'
    ? <PxImg src="px/world-raw.png" style={{ left: 0, top: 0, width: 3248, height: 1088, ...style }} />
    : <PxImg src="px/world-color.png" style={{ left: 0, top: 0, width: 3240, height: 1080, ...style }} />;

/** Seedance 图生视频（首尾同帧）降采样后的 32 帧循环，覆盖世界 x 704–2624；7.5fps 步进 */
export const GardenAnim: React.FC<{ f: number; style?: React.CSSProperties }> = ({ f, style }) => {
  const i = Math.floor(f / 4) % 32;
  return <PxImg src={`px/garden/g${String(i).padStart(2, '0')}.png`} style={{ left: 704, top: 0, width: 1920, height: 1080, ...style }} />;
};

/** 前景叶子（视差 1.4），放在相机外层，按相机 x 自行平移 */
export const Foreground: React.FC<{ camX: number; dy?: number }> = ({ camX, dy = 420 }) => {
  const { v } = useV();
  const VW = v ? 1080 : 1920;
  return (
    <div style={{ position: 'absolute', left: 0, top: v ? 760 : 0, width: VW, height: 1080, overflow: 'hidden', zIndex: 30, pointerEvents: 'none' }}>
      <PxImg src="px/fg-foliage.png" style={{ left: Math.round(-(camX - VW / 2) * 1.4 + 200), top: dy, width: 3240, height: 1080 }} />
    </div>
  );
};

export const tileBase: React.CSSProperties = {
  position: 'absolute', width: 60, height: 60, display: 'grid', placeItems: 'center',
  font: `36px/1 ${F.pz}`, color: C.ink, WebkitFontSmoothing: 'none',
  outline: `3px solid ${C.ink}`, outlineOffset: -3,
};
export const TILE = {
  text: { background: '#fff', boxShadow: `inset 6px 6px 0 #fff, inset -6px -6px 0 ${C.w4}` },
  raw: { background: '#c9ccd2', boxShadow: 'inset 6px 6px 0 #d8dade, inset -6px -6px 0 #a9adb5' },
  dim: { background: '#f1f1f1', color: '#b9b9b9', boxShadow: 'inset -6px -6px 0 #e4e4e4', outlineColor: '#cfcfcf' },
  dimraw: { background: '#b4b8bf', color: 'transparent', boxShadow: 'inset -6px -6px 0 #a7abb3', outlineColor: '#9ca0a8' },
} as const;

/** 一块地砖：text = 字幕；raw = 原始音频波形（柱高随帧 2 帧跳动） */
export const Tile: React.FC<{ x: number; y?: number; ch: string; kind: keyof typeof TILE; f?: number; flip?: number; seed?: number }> = ({ x, y = 840, ch, kind, f = 0, flip, seed = 1 }) => {
  const r = seeded(seed * 7919 + Math.floor(f / 4) % 2);
  const barH = 6 + Math.round(r() * 7) * 6;
  const t = flip ?? 1; // 翻牌进度：0 = 波形面，1 = 字幕面（中途 rotateX）
  const showText = kind !== 'raw' && t >= 0.5;
  const style = { ...tileBase, ...(showText ? TILE[kind] : TILE.raw), left: x, top: y, transform: t > 0 && t < 1 ? `perspective(240px) rotateX(${t < 0.5 ? t * 180 : (1 - t) * 180}deg)` : undefined };
  return (
    <div style={style}>
      {showText ? (ch === '…' ? <span style={{ display: 'flex', gap: 6 }}>{[0, 1, 2].map((k) => <i key={k} style={{ width: 6, height: 6, background: C.ink, display: 'block' }} />)}</span> : ch) : <i style={{ position: 'absolute', left: 24, top: 30 - barH / 2, width: 12, height: barH, background: '#5d626b' }} />}
    </div>
  );
};

/** 地砖下方的砖土 */
export const Soil: React.FC<{ raw?: boolean; y?: number; x?: number; w?: number }> = ({ raw, y = 960, x = -240, w = 3800 }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: 160,
    background: raw
      ? `linear-gradient(${C.ink},${C.ink}) 0 0/100% 3px no-repeat, repeating-linear-gradient(90deg,transparent 0 57px,#9da1a8 57px 60px), repeating-linear-gradient(180deg,#b7bac0 0 27px,#a7abb2 27px 30px)`
      : `linear-gradient(${C.ink},${C.ink}) 0 0/100% 3px no-repeat, repeating-linear-gradient(90deg,transparent 0 57px,#cfcfcf 57px 60px), repeating-linear-gradient(180deg,${C.w3} 0 27px,#d6d6d6 27px 30px)` }} />
);

/** 一行连续字幕砖（世界坐标），用于第二行淡砖与第二幕地面 */
export const TileRow: React.FC<{ text: string; x0: number; y?: number; kind: keyof typeof TILE; from?: number; to?: number }> = ({ text, x0, y = 840, kind, from = -120, to = 3400 }) => (
  <>
    {[...text].map((ch, i) => {
      const x = x0 + i * 60;
      return x < from || x > to ? null : <Tile key={i} x={x} y={y} ch={ch} kind={kind} />;
    })}
  </>
);

export const Fill: React.FC<{ color: string; style?: React.CSSProperties }> = ({ color, style }) => <AbsoluteFill style={{ background: color, ...style }} />;

/** 世界坐标 → 画面坐标（与 WorldView 同一套相机数学，用于把世界里的物体交接给画面层的 UI） */
export function w2s(px: number, py: number, cam: Cam, v: boolean, camVx?: number, worldW = WORLD_W) {
  const VW = v ? 1080 : 1920;
  const half = VW / 2 / cam.z;
  const cx = v ? clamp(camVx ?? cam.x, half, worldW - half) : cam.x;
  const tx = Math.round(VW / 2 - cx * cam.z);
  const ty = Math.round(540 - cam.y * cam.z);
  return { x: px * cam.z + tx, y: py * cam.z + ty + (v ? 760 : 0) };
}
