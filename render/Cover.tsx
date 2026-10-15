import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { COVER_STYLES, type CoverProps, type PersonStyle } from '../src/cover/styles.js';

const FX_ID = 'cover-person-fx';
/** 放置区边缘距画布边小于 1% 视为贴边 */
const EDGE = 0.99;
/** 描边膨胀后先模糊再收紧 alpha，去掉放大抠像带来的锯齿 */
const OUTLINE_SOFTEN = 1.5;
/** 转灰度（Rec.601 亮度），保留 alpha */
const GRAY = '0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0.299 0.587 0.114 0 0  0 0 0 1 0';

const channels = (hex: string): number[] => {
  const n = parseInt(hex.slice(1, 7), 16);
  return [16, 8, 0].map((shift) => ((n >> shift) & 255) / 255);
};

/** 双色调：灰度后暗部映射到第一色、亮部映射到第二色；结果命名为 body */
const DuotonePrimitives: React.FC<{ colors: readonly [string, string] }> = ({ colors }) => {
  const [dark, light] = colors.map(channels);
  const table = (c: number): string => `${dark[c]} ${light[c]}`;
  return (
    <>
      <feColorMatrix in="SourceGraphic" type="matrix" values={GRAY} result="gray" />
      <feComponentTransfer in="gray" result="body">
        <feFuncR type="table" tableValues={table(0)} />
        <feFuncG type="table" tableValues={table(1)} />
        <feFuncB type="table" tableValues={table(2)} />
      </feComponentTransfer>
    </>
  );
};

/** 人物修饰的 SVG 滤镜：可选双色调；描边 = alpha 膨胀（平滑）后填色，垫在人物下面 */
const PersonFx: React.FC<{ fx: PersonStyle }> = ({ fx }) => (
  <svg width={0} height={0} style={{ position: 'absolute' }}>
    <filter id={FX_ID} colorInterpolationFilters="sRGB" x="-10%" y="-10%" width="120%" height="120%">
      {fx.duotone ? <DuotonePrimitives colors={fx.duotone} /> : <feOffset in="SourceGraphic" dx={0} dy={0} result="body" />}
      {fx.outline ? (
        <>
          <feMorphology in="SourceAlpha" operator="dilate" radius={fx.outline.px} result="dilated" />
          <feGaussianBlur in="dilated" stdDeviation={OUTLINE_SOFTEN} result="soft" />
          <feComponentTransfer in="soft" result="grown">
            <feFuncA type="linear" slope={3} intercept={-1} />
          </feComponentTransfer>
          <feFlood floodColor={fx.outline.color} result="ink" />
          <feComposite in="ink" in2="grown" operator="in" result="edge" />
        </>
      ) : null}
      <feMerge>
        {fx.outline ? <feMergeNode in="edge" /> : null}
        <feMergeNode in="body" />
      </feMerge>
    </filter>
  </svg>
);

/** 封面：底图铺满（标题已在底图里，不再叠字）；人物按放置区等比放入、底对齐（贴边的放置区随之贴边），按风格加描边/投影/双色调 */
export const Cover: React.FC<CoverProps> = ({ bg, person, style }) => {
  const { personSlot: slot, personStyle: fx } = COVER_STYLES[style];
  const svgFx = Boolean(fx.duotone || fx.outline);
  const filter = [svgFx ? `url(#${FX_ID})` : '', fx.shadow ? `drop-shadow(${fx.shadow})` : ''].filter(Boolean).join(' ');
  // 放置区贴着画布左/右边时人物也贴边，把原画面截断的一侧藏到画布外
  const align = slot.x + slot.w >= EDGE ? 'right' : slot.x <= 1 - EDGE ? 'left' : 'center';
  return (
    <AbsoluteFill style={{ background: '#FFFFFF' }}>
      {bg ? <Img src={staticFile(bg)} style={{ width: '100%', height: '100%', objectFit: 'cover' }} /> : null}
      {person ? (
        <>
          {svgFx ? <PersonFx fx={fx} /> : null}
          <div style={{ position: 'absolute', left: `${slot.x * 100}%`, top: `${slot.y * 100}%`, width: `${slot.w * 100}%`, height: `${slot.h * 100}%` }}>
            <Img src={staticFile(person)} style={{ width: '100%', height: '100%', objectFit: 'contain', objectPosition: `bottom ${align}`, ...(filter ? { filter } : {}) }} />
          </div>
        </>
      ) : null}
    </AbsoluteFill>
  );
};
