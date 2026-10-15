import React from 'react';
import { Audio, Sequence, staticFile, useVideoConfig } from 'remotion';
import { dbAt, type SfxCue } from '../../src/audio/plan.js';
import { CANVAS, type TalkProps } from '../../src/storyboard/schema.js';

const dbToGain = (db: number): number => 10 ** (db / 20);

/** 音效在工作目录里的位置，与 src/compose/stage-assets.ts 的 sfxStagedPath 一致（渲染包里不引入 node 依赖，故不复用） */
const sfxSrc = (id: SfxCue['sfx']): string => staticFile(`audio/sfx/${id}.wav`);

/** 背景乐（按包络随人声压低；曲目比成片短时循环）+ 卡片音效 */
export const AudioLayer: React.FC<Pick<TalkProps, 'bgm' | 'sfx'>> = ({ bgm, sfx = [] }) => {
  const { durationInFrames } = useVideoConfig();
  // 只在曲目短于成片时循环（循环需要读取音频时长）；'extend' 让包络按整片时间走，而不是每圈重置
  const needLoop = bgm !== undefined && bgm.durationSec * CANVAS.fps < durationInFrames;
  return (
    <>
      {bgm && <Audio src={staticFile(bgm.file)} loop={needLoop} loopVolumeCurveBehavior="extend" volume={(f) => dbToGain(dbAt(bgm.keys, f / CANVAS.fps))} />}
      {sfx.map((cue, i) => (
        <Sequence key={`${i}-${cue.sfx}`} from={Math.round(cue.sec * CANVAS.fps)}>
          <Audio src={sfxSrc(cue.sfx)} volume={cue.volume} />
        </Sequence>
      ))}
    </>
  );
};
