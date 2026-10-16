import React from 'react';
import { interpolateColors, useVideoConfig } from 'remotion';
import { usePalette } from '../palette.js';
import { toRgba } from '../../src/qa/contrast.js';
import { CONTENT_W, CardFrame, Crumb, Reveal, SafeArea, clampLines, easeAt, fitFontSize, itemTimes, litIndex, springAt, type PropsOf, type TemplateProps } from './parts.js';

type Step = PropsOf<'flow'>['steps'][number];

const PAD_X = 52;
const INNER_W = CONTENT_W - PAD_X * 2;
const NODE = 116;
const LINE_H = 6;
const LABEL_TOP = 34;
/** 循环弧线的高度（从标签下方绕回第一步） */
const LOOP_H = 128;
/** 默认节奏：第一步 0.15 秒点亮，之后每 0.4 秒一步；连线画完用时 */
const FIRST = 0.15;
const STAGGER = 0.4;
const DRAW_SEC = 0.35;

/** 步骤标签基准字号：步数少时更大 */
const labelBase = (n: number): number => (n <= 3 ? 52 : n === 4 ? 44 : 38);

/** 第 i 步的中心 x（各步平分卡内宽度） */
const centerX = (i: number, n: number): number => (INNER_W * (i + 0.5)) / n;

/** 一步：圆形序号 + 标签 + 注释；lit 0→1 从灰色描边变成实心，当前步是强调色实心圆带同色光环。
 * 未点亮的步骤：圆环用片色 idle，序号与文字用 idleInk（对卡片 ≥ 4.5，未讲到也看得清），点亮靠实心圆与主文字色区分 */
const StepNode: React.FC<{ step: Step; i: number; n: number; lit: number; current: boolean }> = ({ step, i, n, lit, current }) => {
  const col = INNER_W / n;
  const labelPx = fitFontSize(step.label, col - 16, labelBase(n), 24, 2);
  const pal = usePalette();
  const on = current ? pal.accent : pal.ink;
  const fill = interpolateColors(lit, [0, 1], [pal.card, on]);
  return (
    <div style={{ position: 'absolute', left: centerX(i, n) - col / 2, top: 0, width: col, display: 'flex', flexDirection: 'column', alignItems: 'center', textAlign: 'center' }}>
      <div style={{ width: NODE, height: NODE, borderRadius: NODE / 2, boxSizing: 'border-box', border: `4px solid ${interpolateColors(lit, [0, 1], [pal.idle, on])}`, background: fill,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 50, fontWeight: 800, color: interpolateColors(lit, [0, 1], [pal.idleInk, current ? pal.accentInk : pal.card]),
        boxShadow: current ? `0 0 0 ${10 * lit}px ${toRgba(pal.accent, 0.18)}` : 'none', transform: `scale(${1 + (current ? 0.06 * lit : 0)})` }}>{i + 1}</div>
      <div style={{ marginTop: LABEL_TOP, padding: '0 8px', fontSize: labelPx, fontWeight: 800, lineHeight: 1.2, color: interpolateColors(lit, [0, 1], [pal.idleInk, pal.ink]), ...clampLines(2) }}>{step.label}</div>
      {step.note ? <div style={{ marginTop: 10, padding: '0 8px', fontSize: fitFontSize(step.note, col - 16, 32, 20, 2), fontWeight: 500, lineHeight: 1.3, color: pal.sub, ...clampLines(2) }}>{step.note}</div> : null}
    </div>
  );
};

/** 相邻两步之间的连线：轨道色底线 + 点亮时从左往右画出的主文字色线 */
const Link: React.FC<{ i: number; n: number; p: number }> = ({ i, n, p }) => {
  const x0 = centerX(i - 1, n) + NODE / 2 + 10;
  const x1 = centerX(i, n) - NODE / 2 - 10;
  const pal = usePalette();
  return (
    <div style={{ position: 'absolute', left: x0, top: NODE / 2 - LINE_H / 2, width: x1 - x0, height: LINE_H, borderRadius: LINE_H / 2, background: pal.track, overflow: 'hidden' }}>
      <div style={{ width: '100%', height: '100%', background: pal.ink, transform: `scaleX(${p})`, transformOrigin: 'left center' }} />
    </div>
  );
};

/** 循环：从最后一步下方绕回第一步的弧线（描边动画画出）+ 箭头 + 「循环迭代」小标签 */
const LoopBack: React.FC<{ n: number; top: number; p: number }> = ({ n, top, p }) => {
  const x0 = centerX(n - 1, n);
  const x1 = centerX(0, n);
  const d = `M ${x0} 0 C ${x0} ${LOOP_H}, ${x1} ${LOOP_H}, ${x1} 8`;
  const len = (x0 - x1) * 1.25 + LOOP_H * 1.6;
  const pal = usePalette();
  return (
    <div style={{ position: 'absolute', left: 0, top, width: INNER_W, height: LOOP_H }}>
      <svg width={INNER_W} height={LOOP_H} style={{ position: 'absolute', overflow: 'visible' }}>
        <path d={d} fill="none" stroke={pal.accent} strokeWidth={5} strokeLinecap="round" strokeDasharray={len} strokeDashoffset={len * (1 - p)} />
        <path d={`M ${x1 - 14} 24 L ${x1} 4 L ${x1 + 14} 24`} fill="none" stroke={pal.accent} strokeWidth={5} strokeLinecap="round" strokeLinejoin="round" opacity={p > 0.92 ? 1 : 0} />
      </svg>
      <div style={{ position: 'absolute', left: (x0 + x1) / 2 - 90, top: LOOP_H * 0.75 - 26, width: 180, height: 52, borderRadius: 26, background: pal.accent, color: pal.accentInk,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 28, fontWeight: 800, letterSpacing: '0.06em', opacity: Math.min(1, p * 1.5), transform: `scale(${0.8 + 0.2 * p})` }}>循环迭代</div>
    </div>
  );
};

/** 标签与注释占的高度（估算）：用于把循环弧线放在最长一列的下方 */
function labelsHeight(steps: Step[]): number {
  const n = steps.length;
  const col = INNER_W / n;
  return Math.max(...steps.map((s) => {
    const px = fitFontSize(s.label, col - 16, labelBase(n), 24, 2);
    const lines = Math.min(2, Math.ceil((s.label.length * px) / (col - 16)));
    return LABEL_TOP + lines * px * 1.2 + (s.note ? 10 + 2 * 32 * 1.3 : 0);
  }));
}

/** 估算内容高度（不含白卡内边距）：面包屑与标题 + 步骤轨道 + 循环弧线 */
export function estimateFlowHeight(props: PropsOf<'flow'>): number {
  const head = (props.crumb ? 50 : 0) + (props.title ? fitFontSize(props.title, INNER_W, 62, 36, 2) * 1.2 : 0);
  return head + (head > 0 ? 56 : 0) + NODE + labelsHeight(props.steps) + (props.loop ? LOOP_H + 24 : 0);
}

/** 流程图卡：2–5 步横向推进，随口播（reveal）或默认节奏逐步点亮、连线画出；loop 时最后绕回第一步 */
export const Flow: React.FC<TemplateProps<'flow'>> = ({ props, local, dur }) => {
  const { fps } = useVideoConfig();
  const n = props.steps.length;
  const times = itemTimes(props.reveal, n, (i) => FIRST + i * STAGGER, dur);
  const current = litIndex(times, local);
  const trackH = NODE + labelsHeight(props.steps);
  const height = trackH + (props.loop ? LOOP_H + 24 : 0);
  const loopP = props.loop ? easeAt(local, times[n - 1] + 0.3, 0.7) : 0;
  return (
    <SafeArea>
      <CardFrame fill padding={`52px ${PAD_X}px 56px`}>
        <Reveal p={springAt(local, 0.05, fps)} dy={16}>
          {props.crumb ? <Crumb text={props.crumb} size={28} maxWidth={INNER_W} /> : null}
          {props.title ? <div style={{ marginTop: props.crumb ? 16 : 0, fontSize: fitFontSize(props.title, INNER_W, 62, 36, 2), fontWeight: 800, lineHeight: 1.2, letterSpacing: '-0.01em', ...clampLines(2) }}>{props.title}</div> : null}
        </Reveal>
        <div style={{ position: 'relative', marginTop: props.title || props.crumb ? 56 : 0, width: INNER_W, height }}>
          {props.steps.slice(1).map((_, k) => <Link key={k} i={k + 1} n={n} p={easeAt(local, times[k + 1] - 0.05, DRAW_SEC)} />)}
          {props.steps.map((s, i) => <StepNode key={i} step={s} i={i} n={n} lit={easeAt(local, times[i], 0.3)} current={i === current && !(props.loop && loopP >= 1)} />)}
          {props.loop ? <LoopBack n={n} top={trackH + 12} p={loopP} /> : null}
        </div>
      </CardFrame>
    </SafeArea>
  );
};
