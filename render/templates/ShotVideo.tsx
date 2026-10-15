import React from 'react';
import { AbsoluteFill, Loop, OffthreadVideo, Sequence, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';

/**
 * B-roll 视频的固定时长（秒）：Seedance 生成的素材统一是 4 秒、转成 30fps。
 * 不为此给分镜 schema 增加时长字段；若换用其他时长的视频，镜头里循环的接缝会错位。
 */
export const BROLL_VIDEO_SEC = 4;

/**
 * 卡片底上的视频：静音、铺满、镜头比素材长时循环。
 * 底不随镜头移动，所以帧数是全片的；用 Sequence 把起点对齐到镜头开头（local 为镜头内秒数），视频才从头播放。
 */
export const ShotVideo: React.FC<{ src: string; local: number }> = ({ src, local }) => {
  const { fps } = useVideoConfig();
  const frame = useCurrentFrame();
  const shotStart = Math.round(frame - local * fps);
  return (
    <Sequence from={shotStart} layout="none">
      <Loop durationInFrames={Math.round(BROLL_VIDEO_SEC * fps)} layout="none">
        <AbsoluteFill>
          <OffthreadVideo src={staticFile(src)} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
        </AbsoluteFill>
      </Loop>
    </Sequence>
  );
};
