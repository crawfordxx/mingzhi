// S08 · 呼吸字卡（25.0–27.5s）：不是剪辑软件。地平线最后抬起，变成下一镜 RPG 对话框的上边框
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F } from '../kit/theme';
import { Big } from '../kit/ui';
import { Hero, useV } from '../kit/px';
import { prog, expoOut, camInOut, lerp } from '../kit/anim';

export const Breath: React.FC<{ f: number }> = ({ f }) => {
  const { v, W } = useV();
  const bgA = 1 - prog(f, 818, 14);
  const textA = 1 - prog(f, 810, 8);
  const lineW = prog(f, 756, 18, expoOut);
  const lineY = v ? lerp(1300, 1500, prog(f, 815, 12, camInOut)) : lerp(840, 790, prog(f, 815, 12, camInOut));
  const drop = (start: number) => ({ transform: `translateY(${(1 - prog(f, start, 4, expoOut)) * -28}px)`, opacity: prog(f, start, 2) });
  const heroX = v ? 560 + 5 * (f - 750) : 1100 + 7.5 * (f - 750);
  return (
    <AbsoluteFill style={{ zIndex: 70 }}>
      <AbsoluteFill style={{ background: C.w1, opacity: bgA }} />
      <div style={{ position: 'absolute', left: 0, top: v ? 760 : 430, width: W, display: 'flex', justifyContent: 'center', opacity: textA }}>
        <Big size={v ? 108 : 120}><span style={{ display: 'inline-block', ...drop(752) }}>不是</span><span style={{ display: 'inline-block', ...drop(761) }}>剪辑软件。</span></Big>
      </div>
      <div style={{ position: 'absolute', left: 0, top: v ? 920 : 604, width: W, textAlign: 'center', font: `500 ${v ? 34 : 30}px/1 ${F.zh}`, color: C.t2, opacity: prog(f, 770, 8) * textA, transform: `translateY(${(1 - prog(f, 770, 10, expoOut)) * 10}px)` }}>没有时间线，没有轨道。</div>
      <div style={{ position: 'absolute', left: v ? 60 : 96, top: lineY, width: (W - (v ? 120 : 192)) * lineW, height: 6, background: C.ink }} />
      {f < 818 ? <Hero x={heroX} y={(v ? 1300 : 840)} pose="walk" f={f} cell={5} style={{ opacity: textA }} /> : null}
    </AbsoluteFill>
  );
};
