import React from 'react';
import { AbsoluteFill, Img, staticFile, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { balanceLines, tokenize, type Token } from './headline.js';
import { CONTENT_W, Reveal, SafeArea, clampLines, fitFontSize, fitScale, lineCount, maxFontSize, springAt, type PropsOf, type TemplateProps } from './parts.js';

const HEADLINE_PX = 76;
const HEADLINE_MIN_PX = 50;
const LINE_HEIGHT = 1.2;
/** 断行时每行按 94% 行宽排，弥补字宽估算误差 */
const LINE_MARGIN = 0.94;
const INDEX_PILL_W = 132;
const INDEX_PILL_H = 58;
const KICKER_PAD_X = 26;
const KICKER_LINE_H = 1.3;
const KICKER_W = CONTENT_W - INDEX_PILL_W - 24 - KICKER_PAD_X * 2;
const HEADLINE_TOP = 40;
/** 每行标题下方给遮罩留的余量（字号的比例） */
const LINE_PAD = 0.08;
const STAT_TOP = 36;
const STAT_LINE_H = 1.35;
const STAT_PAD_X = 26;
const STAT_TEXT_W = CONTENT_W - STAT_PAD_X * 2 - 4;
const LIME_SOFT = 'rgba(212, 242, 60, 0.12)';

/** 钩子卡底：全黑；有图时铺图（缓慢推近）并压暗 55%；不随卡片进出场移动 */
export const HookBackdrop: React.FC<TemplateProps<'hook'>> = ({ props, local }) => (
  <AbsoluteFill style={{ background: THEME.hookBg }}>
    {props.image ? (
      <>
        <Img src={staticFile(props.image)} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1 + Math.min(local / 8, 1) * 0.05})` }} />
        <AbsoluteFill style={{ background: 'rgba(14, 15, 12, 0.55)' }} />
      </>
    ) : (
      <div style={{ position: 'absolute', right: -30, bottom: -190, transform: `translateY(${-local * 8}px)`, fontFamily: THEME.font, fontSize: 680, fontWeight: 800, lineHeight: 1,
        letterSpacing: '-0.06em', color: 'transparent', WebkitTextStroke: '2px rgba(212, 242, 60, 0.16)' }}>{props.index}</div>
    )}
    <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(14, 15, 12, 0.55) 0%, rgba(14, 15, 12, 0) 60%)' }} />
  </AbsoluteFill>
);

/** 顶行：左侧荧光胶囊 kicker，右侧描边胶囊 index / total */
const TopRow: React.FC<{ kicker?: string; index: number; total: number; p: number }> = ({ kicker, index, total, p }) => {
  const px = kicker ? kickerPx(kicker) : 28;
  return (
    <Reveal p={p} dy={-16} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
      {kicker ? (
        <div style={{ background: THEME.hookLime, color: THEME.hookBg, fontSize: px, fontWeight: 700, lineHeight: KICKER_LINE_H, padding: `10px ${KICKER_PAD_X}px`, borderRadius: 30, maxWidth: KICKER_W + KICKER_PAD_X * 2,
          boxSizing: 'border-box', overflowWrap: 'anywhere', ...clampLines(2) }}>{kicker}</div>
      ) : <div />}
      <div style={{ flex: 'none', width: INDEX_PILL_W, height: INDEX_PILL_H, borderRadius: INDEX_PILL_H / 2, border: `2.5px solid ${THEME.hookLime}`, color: THEME.hookLime,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 700, letterSpacing: '0.06em', boxSizing: 'border-box' }}>
        {index} / {total}
      </div>
    </Reveal>
  );
};

/** 一行标题：遮罩（只裁下边）内从下方滑上来；估算失准时这一行自动折行，不会被裁掉 */
const HeadlineLine: React.FC<{ tokens: Token[]; px: number; p: number }> = ({ tokens, px, p }) => (
  <div style={{ clipPath: 'inset(-50% -50% 0 -50%)', paddingBottom: px * LINE_PAD }}>
    <div style={{ transform: `translateY(${(1 - p) * 110}%)`, overflowWrap: 'anywhere' }}>
      {tokens.map((t, i) => <span key={i} style={t.hot ? { color: THEME.hookLime } : undefined}>{t.text}</span>)}
    </div>
  </div>
);

/** 标题字号：最多 3 行，76px 起往下缩，不小于 50px */
const headlinePx = (text: string): number => Math.max(HEADLINE_MIN_PX, Math.min(HEADLINE_PX, maxFontSize(text, CONTENT_W, 3)));

/** 均衡断行后的标题各行（渲染与估高共用） */
const headlineLines = (text: string, highlight: string[]): Token[][] => balanceLines(tokenize(text, highlight), (CONTENT_W * LINE_MARGIN) / headlinePx(text));
const kickerPx = (kicker: string): number => fitFontSize(kicker, KICKER_W, 28, 22, 2);
const statText = (stat: { value: string; label: string }): string => `${stat.value} · ${stat.label}`;
const statPx = (stat: { value: string; label: string }): number => fitFontSize(statText(stat), STAT_TEXT_W, 30, 20, 2);

/** 估算钩子卡内容高度：顶行（kicker 最多 2 行）+ 实际断出的标题行 + stat（最多 2 行） */
export function estimateHookHeight(props: PropsOf<'hook'>): number {
  const kicker = props.kicker ? Math.min(2, lineCount(props.kicker, KICKER_W, kickerPx(props.kicker))) * kickerPx(props.kicker) * KICKER_LINE_H + 20 : 0;
  const px = headlinePx(props.headline);
  // 每个均衡行里若有断不开的长片段，渲染时会再折行，按折后的行数计
  const rows = headlineLines(props.headline, props.highlight).reduce((n, l) => n + lineCount(l.map((t) => t.text).join(''), CONTENT_W, px), 0);
  const headline = HEADLINE_TOP + rows * px * (LINE_HEIGHT + LINE_PAD);
  const stat = props.stat ? STAT_TOP + Math.min(2, lineCount(statText(props.stat), STAT_TEXT_W, statPx(props.stat))) * statPx(props.stat) * STAT_LINE_H + 24 : 0;
  return Math.max(INDEX_PILL_H, kicker) + headline + stat;
}

const Headline: React.FC<{ text: string; highlight: string[]; local: number; fps: number }> = ({ text, highlight, local, fps }) => {
  const px = headlinePx(text);
  const lines = headlineLines(text, highlight);
  return (
    <div style={{ marginTop: HEADLINE_TOP, fontSize: px, fontWeight: 800, lineHeight: LINE_HEIGHT, color: '#FFFFFF', letterSpacing: '-0.01em' }}>
      {lines.map((l, i) => <HeadlineLine key={i} tokens={l} px={px} p={springAt(local, 0.12 + i * 0.1, fps, { damping: 22, mass: 0.8 })} />)}
    </div>
  );
};

/** 数据小胶囊：value · label；最宽不超过内容区，放不下一行时折成两行 */
const Stat: React.FC<{ value: string; label: string; p: number }> = ({ value, label, p }) => {
  const px = statPx({ value, label });
  return (
    <Reveal p={p} dy={20} style={{ marginTop: STAT_TOP, display: 'flex' }}>
      <div style={{ maxWidth: CONTENT_W, boxSizing: 'border-box', padding: `10px ${STAT_PAD_X}px`, borderRadius: 30, border: '2px solid rgba(212, 242, 60, 0.55)',
        background: LIME_SOFT, color: THEME.hookLime, fontSize: px, fontWeight: 600, lineHeight: STAT_LINE_H }}>
        <span style={{ overflowWrap: 'anywhere', ...clampLines(2) }}>
          <span style={{ fontWeight: 800 }}>{value}</span>
          <span style={{ opacity: 0.6, margin: '0 0.45em' }}>·</span>
          {label}
        </span>
      </div>
    </Reveal>
  );
};

/** 钩子卡：开头 2–3 张，深色底 + 荧光黄绿高亮 */
export const Hook: React.FC<TemplateProps<'hook'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const lines = headlineLines(props.headline, props.highlight).length;
  const statDelay = 0.2 + lines * 0.1;
  return (
    <SafeArea scale={fitScale(estimateHookHeight(props))}>
      <TopRow kicker={props.kicker} index={props.index} total={props.total} p={springAt(local, 0, fps)} />
      <Headline text={props.headline} highlight={props.highlight} local={local} fps={fps} />
      {props.stat ? <Stat value={props.stat.value} label={props.stat.label} p={springAt(local, statDelay, fps)} /> : null}
    </SafeArea>
  );
};
