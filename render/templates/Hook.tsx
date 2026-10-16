import React from 'react';
import { AbsoluteFill, Img, staticFile, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { balanceLines, tokenize, type Token } from './headline.js';
import { HookGraphic } from './HookGraphic.js';
import { ShotVideo } from './ShotVideo.js';
import { HOOK_MARK_SEC, HOOK_MARK_STAGGER, HOOK_MARK_START } from './timing.js';
import { CONTENT_W, SafeArea, clampLines, easeAt, fitFontSize, fitScale, lineCount, maxFontSize, springAt, type PropsOf, type TemplateProps } from './parts.js';

const HEADLINE_PX = 84;
const HEADLINE_MIN_PX = 50;
const LINE_HEIGHT = 1.2;
/** 断行时每行按 94% 行宽排，弥补字宽估算误差 */
const LINE_MARGIN = 0.94;
const INDEX_PILL_W = 132;
const INDEX_PILL_H = 58;
const KICKER_PAD_X = 26;
const KICKER_LINE_H = 1.3;
const KICKER_W = CONTENT_W - KICKER_PAD_X * 2;
const SOURCE_W = CONTENT_W - INDEX_PILL_W - 24;
const HEADLINE_TOP = 40;
/** 每行标题下方给高亮下划线留的余量（字号的比例） */
const LINE_PAD = 0.08;
const STAT_TOP = 30;
const STAT_PX = 150;
const STAT_LABEL_PX = 40;
const LIME_SOFT = 'rgba(212, 242, 60, 0.12)';

/** 钩子卡底：有视频时静音循环铺满、有图时铺图（缓慢推近），都压暗；没有素材时用本地图形兜底（动态几何 + 大号关键词）；不随卡片进出场移动 */
export const HookBackdrop: React.FC<TemplateProps<'hook'>> = ({ props, local }) => {
  if (!props.video && !props.image) return <HookGraphic props={props} local={local} />;
  return (
    <AbsoluteFill style={{ background: THEME.hookBg }}>
      {props.video ? <ShotVideo src={props.video} local={local} /> : (
        <Img src={staticFile(props.image ?? '')} style={{ width: '100%', height: '100%', objectFit: 'cover', transform: `scale(${1.04 + Math.min(local / 8, 1) * 0.05})` }} />
      )}
      <AbsoluteFill style={{ background: 'rgba(14, 15, 12, 0.5)' }} />
      <AbsoluteFill style={{ background: 'linear-gradient(180deg, rgba(14, 15, 12, 0.5) 0%, rgba(14, 15, 12, 0) 45%, rgba(14, 15, 12, 0.35) 100%)' }} />
    </AbsoluteFill>
  );
};

/** 来源背书小标签：荧光对勾 + 「出自」+ 来源（如「GitHub 3.5 万星项目」） */
const SourceTag: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ display: 'inline-flex', alignItems: 'center', gap: 12, maxWidth: SOURCE_W, height: INDEX_PILL_H, boxSizing: 'border-box', padding: '0 24px 0 16px', borderRadius: INDEX_PILL_H / 2,
    background: 'rgba(255, 255, 255, 0.08)', border: '2px solid rgba(212, 242, 60, 0.45)', color: '#F4F6EC', fontSize: fitFontSize(`出自 ${text}`, SOURCE_W - 90, 28, 20), fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden' }}>
    <svg width={30} height={30} viewBox="0 0 24 24" style={{ flex: 'none' }}>
      <circle cx={12} cy={12} r={11} fill={THEME.hookLime} />
      <path d="M6.8 12.4 L10.4 15.8 L17.4 8.6" fill="none" stroke={THEME.hookBg} strokeWidth={2.6} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
    <span style={{ opacity: 0.7 }}>出自</span>
    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text}</span>
  </div>
);

/** 顶行：左侧来源标签，右侧描边胶囊 index / total */
const TopRow: React.FC<{ source?: string; index: number; total: number }> = ({ source, index, total }) => (
  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 24 }}>
    {source ? <SourceTag text={source} /> : <div />}
    <div style={{ flex: 'none', width: INDEX_PILL_W, height: INDEX_PILL_H, borderRadius: INDEX_PILL_H / 2, border: `2.5px solid ${THEME.hookLime}`, color: THEME.hookLime,
      display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 30, fontWeight: 700, letterSpacing: '0.06em', boxSizing: 'border-box' }}>
      {index} / {total}
    </div>
  </div>
);

/** 一行标题：第 0 帧就完整可读，只从下方 14px 轻轻落位；高亮词荧光色，底下一道荧光条从左往右刷开 */
const HeadlineLine: React.FC<{ tokens: Token[]; px: number; p: number; mark: number }> = ({ tokens, px, p, mark }) => (
  <div style={{ paddingBottom: px * LINE_PAD, transform: `translateY(${(1 - Math.min(1, p)) * 14}px)`, overflowWrap: 'anywhere' }}>
    {tokens.map((t, i) => (t.hot ? (
      <span key={i} style={{ position: 'relative', color: THEME.hookLime, display: 'inline-block' }}>
        <span style={{ position: 'absolute', left: 0, right: 0, bottom: -px * 0.02, height: px * 0.1, borderRadius: px * 0.05, background: THEME.hookLime, transform: `scaleX(${mark})`, transformOrigin: 'left center' }} />
        {t.text}
      </span>
    ) : <span key={i}>{t.text}</span>))}
  </div>
);

/** 标题字号：最多 3 行，84px 起往下缩，不小于 50px */
const headlinePx = (text: string): number => Math.max(HEADLINE_MIN_PX, Math.min(HEADLINE_PX, maxFontSize(text, CONTENT_W, 3)));

/** 均衡断行后的标题各行（渲染与估高共用） */
const headlineLines = (text: string, highlight: string[]): Token[][] => balanceLines(tokenize(text, highlight), (CONTENT_W * LINE_MARGIN) / headlinePx(text));
const kickerPx = (kicker: string): number => fitFontSize(kicker, KICKER_W, 30, 22, 2);
const statPx = (value: string): number => fitFontSize(value, CONTENT_W * 0.62, STAT_PX, 64);
const statLabelPx = (label: string): number => fitFontSize(label, CONTENT_W, STAT_LABEL_PX, 24, 2);

/** 估算钩子卡内容高度：顶行 + kicker（最多 2 行）+ 实际断出的标题行 + 大数字与说明 */
export function estimateHookHeight(props: PropsOf<'hook'>): number {
  const kicker = props.kicker ? 24 + Math.min(2, lineCount(props.kicker, KICKER_W, kickerPx(props.kicker))) * kickerPx(props.kicker) * KICKER_LINE_H + 20 : 0;
  const px = headlinePx(props.headline);
  // 每个均衡行里若有断不开的长片段，渲染时会再折行，按折后的行数计
  const rows = headlineLines(props.headline, props.highlight).reduce((n, l) => n + lineCount(l.map((t) => t.text).join(''), CONTENT_W, px), 0);
  const headline = HEADLINE_TOP + rows * px * (LINE_HEIGHT + LINE_PAD);
  const stat = props.stat ? STAT_TOP + statPx(props.stat.value) * 1.05 + 12 + Math.min(2, lineCount(props.stat.label, CONTENT_W, statLabelPx(props.stat.label))) * statLabelPx(props.stat.label) * 1.3 : 0;
  return INDEX_PILL_H + kicker + headline + stat;
}

/** 荧光小胶囊（kicker：钩子的小标题） */
const Kicker: React.FC<{ text: string }> = ({ text }) => (
  <div style={{ marginTop: 24, display: 'flex' }}>
    <div style={{ background: THEME.hookLime, color: THEME.hookBg, fontSize: kickerPx(text), fontWeight: 700, lineHeight: KICKER_LINE_H, padding: `10px ${KICKER_PAD_X}px`, borderRadius: 30,
      maxWidth: CONTENT_W, boxSizing: 'border-box', overflowWrap: 'anywhere', ...clampLines(2) }}>{text}</div>
  </div>
);

/** 大数字：钩子的视觉主体之一（荧光色超大数字 + 白色说明），第 0 帧即完整，只做轻微的放大落位 */
const Stat: React.FC<{ value: string; label: string; p: number }> = ({ value, label, p }) => (
  <div style={{ marginTop: STAT_TOP }}>
    <div style={{ fontSize: statPx(value), fontWeight: 900, lineHeight: 1.05, letterSpacing: '-0.04em', color: THEME.hookLime, transform: `scale(${1.04 - 0.04 * Math.min(1, p)})`, transformOrigin: 'left bottom',
      whiteSpace: 'nowrap', textShadow: `0 0 60px ${LIME_SOFT}` }}>{value}</div>
    <div style={{ marginTop: 12, fontSize: statLabelPx(label), fontWeight: 600, lineHeight: 1.3, color: 'rgba(255, 255, 255, 0.82)', ...clampLines(2) }}>{label}</div>
  </div>
);

/** 钩子卡：开头 2–3 张，深色底（素材或本地图形）+ 来源背书 + 荧光高亮大标题 + 可选大数字；内容第 0 帧就完整，动效只做落位与高亮刷开 */
export const Hook: React.FC<TemplateProps<'hook'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const px = headlinePx(props.headline);
  const lines = headlineLines(props.headline, props.highlight);
  return (
    <SafeArea scale={fitScale(estimateHookHeight(props))}>
      <TopRow source={props.source} index={props.index} total={props.total} />
      {props.kicker ? <Kicker text={props.kicker} /> : null}
      <div style={{ marginTop: HEADLINE_TOP, fontSize: px, fontWeight: 800, lineHeight: LINE_HEIGHT, color: '#FFFFFF', letterSpacing: '-0.01em' }}>
        {lines.map((l, i) => <HeadlineLine key={i} tokens={l} px={px} p={springAt(local, i * 0.06, fps, { damping: 22, mass: 0.8 })} mark={easeAt(local, HOOK_MARK_START + i * HOOK_MARK_STAGGER, HOOK_MARK_SEC)} />)}
      </div>
      {props.stat ? <Stat value={props.stat.value} label={props.stat.label} p={springAt(local, 0.1, fps)} /> : null}
    </SafeArea>
  );
};
