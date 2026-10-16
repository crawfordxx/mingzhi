import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { shotAt, visualLayout } from '../../src/compose/layout.js';
import type { Broll, CardSpec, Shot } from '../../src/storyboard/schema.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';
import { renderBackdrop, renderCard } from '../templates/index.js';
import { EXIT_SEC, GLASS, SurfaceContext } from '../templates/parts.js';
import { BrollMedia } from './BrollLayer.js';

/** 出场：镜头最后 EXIT_SEC（0.25）秒淡出并上移 30px（进场由 spring 驱动，约 0.5 秒收敛） */
const ENTER_DY = 80;
const ENTER_SCALE = 0.94;
const EXIT_DY = 30;

/** 出场进度（0 未开始 → 1 完全淡出）：镜头最后 EXIT_SEC 秒；全片最后一个镜头（通常是 cta）一直停在画面上，不淡出 */
export function cardExit(shotEnd: number, sec: number, isLast: boolean): number {
  if (isLast) return 0;
  return interpolate(shotEnd - sec, [0, EXIT_SEC], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
}

/** 卡片进出场：从下方 80px、0.94 缩放、透明度 0 弹入；结尾淡出上移（末镜头除外） */
const CardMotion: React.FC<{ shot: Shot & { card: CardSpec }; sec: number; isLast: boolean }> = ({ shot, sec, isLast }) => {
  const { fps } = useVideoConfig();
  const local = sec - shot.start;
  const s = spring({ frame: Math.round(local * fps), fps, config: { damping: 16, mass: 0.7 } });
  const exit = cardExit(shot.end, sec, isLast);
  const style: React.CSSProperties = {
    position: 'absolute', inset: 0,
    opacity: Math.min(s, 1 - exit),
    transform: `translateY(${interpolate(s, [0, 1], [ENTER_DY, 0]) - exit * EXIT_DY}px) scale(${interpolate(s, [0, 1], [ENTER_SCALE, 1])})`,
  };
  return <div style={style}>{renderCard(shot.card, local, shot.end - shot.start)}</div>;
};

/** 分屏上半屏素材图的压暗：顶部轻压给状态栏，下部渐暗托住贴底排的卡片信息与压在分界线上的字幕 */
const SPLIT_SHADE = 'linear-gradient(180deg, rgba(0, 0, 0, 0.3) 0%, rgba(0, 0, 0, 0) 20%, rgba(0, 0, 0, 0) 38%, rgba(10, 9, 8, 0.5) 72%, rgba(10, 9, 8, 0.78) 100%)';
/** 浮层：整块卡片区（1080×960）缩到 0.64 后贴顶，内容上沿约在 y=128（避开平台顶栏）；紧凑卡大多只压住头顶头发，不遮脸 */
const FLOAT_SCALE = 0.64;
const FLOAT_TOP = 128 - 150 * FLOAT_SCALE;
/** 浮层只有素材时的小窗：16:9 圆角，压在人物胸前、字幕上方（底边 1290 与画中画一致），脸始终露出 */
const FLOAT_MEDIA = { w: 720, h: 405, bottom: 1290, radius: 32 } as const;

type Hit = { shot: Shot; sec: number; isLast: boolean };

/** 分屏：上半屏（0–960）画底与卡片。有素材时素材铺满 + 渐变压暗，卡片信息贴底排在图上（白卡变玻璃）；否则米色底 + 模板固定底。底不随镜头切换闪烁 */
const SplitCard: React.FC<Hit> = ({ shot, sec, isLast }) => {
  const local = sec - shot.start;
  const dur = shot.end - shot.start;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam, background: THEME.stage, overflow: 'hidden' }}>
      {shot.broll ? <><BrollMedia broll={shot.broll} local={local} dur={dur} /><AbsoluteFill style={{ background: SPLIT_SHADE }} /></> : shot.card ? renderBackdrop(shot.card, local, dur) : null}
      <SurfaceContext.Provider value={shot.broll ? 'image' : 'paper'}>
        {shot.card ? <CardMotion shot={{ ...shot, card: shot.card }} sec={sec} isLast={isLast} /> : null}
      </SurfaceContext.Provider>
    </div>
  );
};

/** 浮层只有素材：胸前圆角小窗，白色细描边与投影，从下方弹簧缩放入场 */
const FloatMedia: React.FC<{ broll: Broll; local: number; dur: number; isLast: boolean; end: number; sec: number }> = ({ broll, local, dur, isLast, end, sec }) => {
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.round(local * fps), fps, config: { damping: 18, mass: 0.8 } });
  const exit = cardExit(end, sec, isLast);
  return (
    <div style={{ position: 'absolute', left: (CANVAS.width - FLOAT_MEDIA.w) / 2, top: FLOAT_MEDIA.bottom - FLOAT_MEDIA.h, width: FLOAT_MEDIA.w, height: FLOAT_MEDIA.h, borderRadius: FLOAT_MEDIA.radius, overflow: 'hidden',
      boxShadow: '0 28px 72px rgba(0, 0, 0, 0.42), 0 6px 18px rgba(0, 0, 0, 0.22)', opacity: Math.min(s, 1 - exit), transform: `translateY(${interpolate(s, [0, 1], [36, 0]) - exit * EXIT_DY}px) scale(${interpolate(s, [0, 1], [0.92, 1])})` }}>
      <BrollMedia broll={broll} local={local} dur={dur} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: FLOAT_MEDIA.radius, boxShadow: 'inset 0 0 0 3px rgba(255, 255, 255, 0.92)' }} />
    </div>
  );
};

/** 浮层：人物全屏，顶部浮一张紧凑卡片（白卡变玻璃）；带固定底的模板（钩子、图片）连底一起放进圆角小窗；没有卡片时在胸前浮素材小窗 */
const FloatCard: React.FC<Hit> = ({ shot, sec, isLast }) => {
  const local = sec - shot.start;
  const dur = shot.end - shot.start;
  if (!shot.card) return shot.broll ? <FloatMedia broll={shot.broll} local={local} dur={dur} isLast={isLast} end={shot.end} sec={sec} /> : null;
  const backdrop = renderBackdrop(shot.card, local, dur);
  const frame: React.CSSProperties = backdrop ? { borderRadius: THEME.radius / FLOAT_SCALE, overflow: 'hidden', boxShadow: GLASS.boxShadow } : {};
  return (
    <div style={{ position: 'absolute', left: 0, top: FLOAT_TOP, width: CANVAS.width, height: CANVAS.seam, transform: `scale(${FLOAT_SCALE})`, transformOrigin: 'top center', ...frame }}>
      {backdrop}
      <SurfaceContext.Provider value={backdrop ? 'paper' : 'float'}>
        <CardMotion shot={{ ...shot, card: shot.card }} sec={sec} isLast={isLast} />
      </SurfaceContext.Provider>
    </div>
  );
};

/**
 * 卡片层（shots 为画面时间轴）：分屏画上半屏；浮层画顶部浮卡；全屏只叠加 cta；全屏插入与画中画不画卡片（素材层负责）
 */
export const CardLayer: React.FC<{ shots: Shot[]; sec: number }> = ({ shots, sec }) => {
  const hit = shotAt(shots, sec);
  if (!hit) return null;
  const { shot } = hit;
  const isLast = hit.index === shots.length - 1;
  const layout = visualLayout(shot);
  if (layout === 'split') return <SplitCard shot={shot} sec={sec} isLast={isLast} />;
  if (layout === 'overlay') return <FloatCard shot={shot} sec={sec} isLast={isLast} />;
  // 全屏只叠 cta：不画卡片区底色，胶囊由模板自己放在画布上方（顶边 y=CTA_TOP=230，中心约 280）
  if (layout !== 'full' || shot.card?.template !== 'cta') return null;
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam }}>
      <CardMotion shot={{ ...shot, card: shot.card }} sec={sec} isLast={isLast} />
    </div>
  );
};

/** 单卡静帧合成（1080×960）：不做进出场，直接画模板在当前帧的状态；镜头时长取合成时长（可由 inputProps.dur 指定） */
export const CardStill: React.FC<{ card: CardSpec; dur?: number }> = ({ card }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const local = frame / fps;
  const dur = durationInFrames / fps;
  return (
    <AbsoluteFill style={{ background: THEME.stage }}>
      {renderBackdrop(card, local, dur)}
      {renderCard(card, local, dur)}
    </AbsoluteFill>
  );
};
