import React from 'react';
import { AbsoluteFill, Img, staticFile, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { balanceLines, tokenize, type Token } from './headline.js';
import { CONTENT_W, Reveal, SafeArea, fitFontSize, maxFontSize, springAt, textEm, type TemplateProps } from './parts.js';

const HEADLINE_PX = 76;
const HEADLINE_MIN_PX = 50;
const LINE_HEIGHT = 1.2;
const INDEX_PILL_W = 132;
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
  const kickerW = CONTENT_W - INDEX_PILL_W - 24 - 52;
  const px = kicker ? fitFontSize(kicker, kickerW, 28, 22, 2) : 28;
  return (
    <Reveal p={p} dy={-16} style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 }}>
      {kicker ? (
        <div style={{ background: THEME.hookLime, color: THEME.hookBg, fontSize: px, fontWeight: 700, lineHeight: 1.3, padding: '10px 26px', borderRadius: 30, maxWidth: kickerW + 52 }}>{kicker}</div>
      ) : <div />}
      <div style={{ flex: 'none', width: INDEX_PILL_W, height: 58, borderRadius: 29, border: `2.5px solid ${THEME.hookLime}`, color: THEME.hookLime,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 700, letterSpacing: '0.06em', boxSizing: 'border-box' }}>
        {index} / {total}
      </div>
    </Reveal>
  );
};

/** 一行标题：遮罩内从下方滑上来 */
const HeadlineLine: React.FC<{ tokens: Token[]; px: number; p: number }> = ({ tokens, px, p }) => (
  <div style={{ overflow: 'hidden', paddingBottom: px * 0.08 }}>
    <div style={{ transform: `translateY(${(1 - p) * 110}%)`, whiteSpace: 'nowrap' }}>
      {tokens.map((t, i) => <span key={i} style={t.hot ? { color: THEME.hookLime } : undefined}>{t.text}</span>)}
    </div>
  </div>
);

/** 标题字号：最多 3 行，76px 起往下缩，不小于 50px */
const headlinePx = (text: string): number => Math.max(HEADLINE_MIN_PX, Math.min(HEADLINE_PX, maxFontSize(text, CONTENT_W, 3)));

const Headline: React.FC<{ text: string; highlight: string[]; local: number; fps: number }> = ({ text, highlight, local, fps }) => {
  const px = headlinePx(text);
  const lines = balanceLines(tokenize(text, highlight), CONTENT_W / px);
  return (
    <div style={{ marginTop: 40, fontSize: px, fontWeight: 800, lineHeight: LINE_HEIGHT, color: '#FFFFFF', letterSpacing: '-0.01em' }}>
      {lines.map((l, i) => <HeadlineLine key={i} tokens={l} px={px} p={springAt(local, 0.12 + i * 0.1, fps, { damping: 22, mass: 0.8 })} />)}
    </div>
  );
};

/** 数据小胶囊：value · label */
const Stat: React.FC<{ value: string; label: string; p: number }> = ({ value, label, p }) => {
  const text = `${value} · ${label}`;
  const px = fitFontSize(text, CONTENT_W - 60, 30, 20);
  return (
    <Reveal p={p} dy={20} style={{ marginTop: 36, display: 'flex' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 26px', borderRadius: 30, border: '2px solid rgba(212, 242, 60, 0.55)',
        background: LIME_SOFT, color: THEME.hookLime, fontSize: px, fontWeight: 600, whiteSpace: 'nowrap' }}>
        <span style={{ fontWeight: 800 }}>{value}</span>
        <span style={{ opacity: 0.6 }}>·</span>
        <span>{label}</span>
      </div>
    </Reveal>
  );
};

/** 钩子卡：开头 2–3 张，深色底 + 荧光黄绿高亮 */
export const Hook: React.FC<TemplateProps<'hook'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const lines = Math.ceil((textEm(props.headline) * headlinePx(props.headline)) / CONTENT_W);
  const statDelay = 0.2 + lines * 0.1;
  return (
    <SafeArea>
      <TopRow kicker={props.kicker} index={props.index} total={props.total} p={springAt(local, 0, fps)} />
      <Headline text={props.headline} highlight={props.highlight} local={local} fps={fps} />
      {props.stat ? <Stat value={props.stat.value} label={props.stat.label} p={springAt(local, statDelay, fps)} /> : null}
    </SafeArea>
  );
};
