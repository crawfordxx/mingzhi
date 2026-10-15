// 像素构件：精灵 PNG 按整数倍放大；小象英雄的姿势与帧步进（on 4s = 7.5fps）
import React from 'react';
import { Img, staticFile, useVideoConfig } from 'remotion';
import SPRITES from './sprites.json';

export type SpriteName = keyof typeof SPRITES;
const PIX: React.CSSProperties = { imageRendering: 'pixelated', display: 'block', position: 'absolute' };

export const spriteSize = (name: SpriteName, cell = 6) => {
  const [w, h] = SPRITES[name] as number[];
  return { w: w * cell, h: h * cell };
};

/** 以左下角（脚底）为锚点放置精灵 */
export const Sprite: React.FC<{ name: SpriteName; x: number; y: number; cell?: number; style?: React.CSSProperties; anchor?: 'feet' | 'top' }> = ({ name, x, y, cell = 6, style, anchor = 'feet' }) => {
  const { w, h } = spriteSize(name, cell);
  return <Img src={staticFile(`sprites/${name}.png`)} style={{ ...PIX, left: x, top: anchor === 'feet' ? y - h : y, width: w, height: h, ...style }} />;
};

/** 像素化图片（世界、预设、剪影） */
export const PxImg: React.FC<{ src: string; style: React.CSSProperties }> = ({ src, style }) => (
  <Img src={staticFile(src)} style={{ ...PIX, ...style }} />
);

export type Pose = 'stand' | 'walk' | 'jump' | 'squash' | 'cheer' | 'blink' | 'fall';
/** 姿势 → 当前帧的精灵名与竖直偏移；walk 按 4 帧一步循环，idle 每 75 帧眨眼一次 */
export function heroSprite(pose: Pose, f: number): { name: SpriteName; dy: number } {
  if (pose === 'walk') {
    const i = Math.floor(f / 4) % 4;
    return [{ name: 'ele-walk1' as SpriteName, dy: 0 }, { name: 'ele-stand' as SpriteName, dy: -6 }, { name: 'ele-walk2' as SpriteName, dy: 0 }, { name: 'ele-stand' as SpriteName, dy: -6 }][i];
  }
  if (pose === 'jump' || pose === 'fall') return { name: 'ele-jump', dy: 0 };
  if (pose === 'squash') return { name: 'ele-squash', dy: 0 };
  if (pose === 'cheer') return { name: 'ele-cheer', dy: 0 };
  if (pose === 'blink') return { name: 'ele-blink', dy: 0 };
  return { name: f % 75 < 4 ? 'ele-blink' : 'ele-stand', dy: 0 };
}

export const Hero: React.FC<{ x: number; y: number; pose: Pose; f: number; cell?: number; style?: React.CSSProperties; flip?: boolean }> = ({ x, y, pose, f, cell = 6, style, flip }) => {
  const { name, dy } = heroSprite(pose, f);
  return <Sprite name={name} x={Math.round(x / cell) * cell} y={Math.round((y + dy * cell / 6) / cell) * cell} cell={cell} style={{ zIndex: 22, transform: flip ? 'scaleX(-1)' : undefined, ...style }} />;
};

/** 版式：16:9 横版 / 9:16 竖版 */
export function useV() {
  const { width, height } = useVideoConfig();
  return { v: height > width, W: width, H: height };
}
