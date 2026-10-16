import React from 'react';
import { AbsoluteFill, Img, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { kenBurnsAt, kenBurnsRects, shotAt, visualLayout } from '../../src/compose/layout.js';
import type { Broll, Shot } from '../../src/storyboard/schema.js';
import { shotStartFrame } from '../templates/ShotVideo.js';

/** 素材底色：极深的暖黑（素材加载前或透明处不露米色） */
export const BROLL_BG = '#0B0B0A';
/** 字幕可读性保护：画面下部柔和压暗（字幕中心 y=1400 处约 35%），顶部轻压一层给平台状态栏 */
export const CAPTION_SHADE = 'linear-gradient(180deg, rgba(0, 0, 0, 0.22) 0%, rgba(0, 0, 0, 0) 9%, rgba(0, 0, 0, 0) 56%, rgba(0, 0, 0, 0.34) 73%, rgba(0, 0, 0, 0.56) 100%)';

const focalPosition = (b: Broll): string => `${(b.focal.x * 100).toFixed(2)}% ${(b.focal.y * 100).toFixed(2)}%`;

/** 静图：按主体焦点铺满容器，再按 Ken Burns 裁框（未给时由焦点计算）在镜头内 inOut 推近；裁框不出画所以不露边 */
const KenBurnsPhoto: React.FC<{ broll: Broll; local: number; dur: number }> = ({ broll, local, dur }) => {
  const r = kenBurnsAt(broll.kenBurns ?? kenBurnsRects(broll.focal), dur > 0 ? local / dur : 1);
  return (
    <AbsoluteFill style={{ overflow: 'hidden' }}>
      <Img src={staticFile(broll.file)} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', objectPosition: focalPosition(broll),
        transformOrigin: '0 0', transform: `scale(${1 / r.w}) translate(${-r.x * 100}%, ${-r.y * 100}%)` }} />
    </AbsoluteFill>
  );
};

/** 视频：静音、按焦点铺满，从镜头画面起点开始播放（local 为画面起点后的秒数） */
const BrollVideo: React.FC<{ broll: Broll; local: number }> = ({ broll, local }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  return (
    <Sequence from={shotStartFrame(frame, local, fps)} layout="none">
      <AbsoluteFill style={{ overflow: 'hidden' }}>
        <OffthreadVideo src={staticFile(broll.file)} muted style={{ width: '100%', height: '100%', objectFit: 'cover', objectPosition: focalPosition(broll) }} />
      </AbsoluteFill>
    </Sequence>
  );
};

/** 素材铺满所在容器（全屏、上半屏或浮层小窗共用） */
export const BrollMedia: React.FC<{ broll: Broll; local: number; dur: number }> = ({ broll, local, dur }) => (
  <AbsoluteFill style={{ background: BROLL_BG }}>
    {broll.kind === 'video' ? <BrollVideo broll={broll} local={local} /> : <KenBurnsPhoto broll={broll} local={local} dur={dur} />}
  </AbsoluteFill>
);

/**
 * 全屏素材层：place=over 画全屏插入（盖在人像之上，人声继续），place=under 画画中画的底（人像小窗在其上）。
 * shots 为画面时间轴（visualShots 之后，全屏插入已晚 2 帧切入）；带字幕区柔和压暗
 */
export const BrollLayer: React.FC<{ shots: Shot[]; sec: number; place: 'over' | 'under' }> = ({ shots, sec, place }) => {
  const hit = shotAt(shots, sec);
  const broll = hit?.shot.broll;
  if (!hit || !broll || visualLayout(hit.shot) !== (place === 'over' ? 'broll' : 'pip')) return null;
  return (
    <AbsoluteFill>
      <BrollMedia broll={broll} local={sec - hit.shot.start} dur={hit.shot.end - hit.shot.start} />
      <AbsoluteFill style={{ background: CAPTION_SHADE }} />
    </AbsoluteFill>
  );
};
