import React from 'react';
import { Img, interpolate, staticFile, useVideoConfig } from 'remotion';
import { THEME } from '../theme.js';
import { CONTENT_W, CardFrame, Reveal, SafeArea, clampLines, easeAt, fitFontSize, springAt, type TemplateProps } from './parts.js';

const WIN_H = 640;
const PAD_X = 30;
const BAR_W = CONTENT_W - PAD_X * 2;
const URL_H = 66;
const BLUE = '#1F6FEB';
const BLUE_TRACK = '#DCE7F8';
/** 有图时进度条走完的时长、图片滚动的时长与幅度 */
const LOAD_SEC = 0.6;
const SCROLL_SEC = 6;
const SCROLL_PCT = 3;
/** 无图时进度条渐近的上限与时间常数 */
const STALL_AT = 0.72;
const STALL_TAU = 1.4;

const LockIcon: React.FC = () => (
  <svg width={22} height={22} viewBox="0 0 24 24" style={{ flex: 'none' }}>
    <rect x={5} y={10.5} width={14} height={10} rx={2.5} fill="#7C8580" />
    <path d="M8.2 10.5 V8 a3.8 3.8 0 0 1 7.6 0 V10.5" fill="none" stroke="#7C8580" strokeWidth={2.2} />
  </svg>
);

/** 地址栏胶囊 + 下方蓝色进度条（progress 0→1，done 后淡出） */
const AddressBar: React.FC<{ url: string; progress: number; fade: number }> = ({ url, progress, fade }) => (
  <div style={{ padding: `24px ${PAD_X}px 0` }}>
    <div style={{ height: URL_H, borderRadius: URL_H / 2, background: THEME.url.bg, display: 'flex', alignItems: 'center', gap: 14, padding: '0 28px' }}>
      <LockIcon />
      <div style={{ fontSize: fitFontSize(url, BAR_W - 100, 29, 20), fontWeight: 500, color: THEME.url.fg, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{url}</div>
    </div>
    <div style={{ marginTop: 16, height: 6, borderRadius: 3, background: BLUE_TRACK, opacity: 1 - fade, overflow: 'hidden' }}>
      <div style={{ width: `${progress * 100}%`, height: '100%', borderRadius: 3, background: BLUE }} />
    </div>
  </div>
);

/** 有图时的进度：先冲到一半多、稍顿，再一口气走完（LOAD_SEC 时到 100%） */
const loadedAt = (local: number): number =>
  interpolate(local, [0.05, 0.3, 0.42, LOAD_SEC], [0, 0.58, 0.7, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/** 无图：转圈 + 标题 + 正在加载… */
const Loading: React.FC<{ title?: string; local: number }> = ({ title, local }) => (
  <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 22, paddingBottom: 30 }}>
    <svg width={104} height={104} viewBox="0 0 52 52" style={{ transform: `rotate(${local * 400}deg)` }}>
      <circle cx={26} cy={26} r={21} fill="none" stroke={BLUE} strokeWidth={4.5} strokeLinecap="round" strokeDasharray="92 200" />
    </svg>
    {title ? <div style={{ maxWidth: BAR_W - 80, textAlign: 'center', fontSize: fitFontSize(title, BAR_W - 80, 36, 26, 2), fontWeight: 700, lineHeight: 1.35, ...clampLines(2) }}>{title}</div> : null}
    <div style={{ fontSize: 28, fontWeight: 500, color: THEME.hint, letterSpacing: '0.04em' }}>正在加载…</div>
  </div>
);

/** 有图：进度条走完后淡入，铺满（顶部对齐），缓慢上滚 */
const Page: React.FC<{ image: string; local: number }> = ({ image, local }) => {
  const show = easeAt(local, LOAD_SEC, 0.3);
  const scroll = easeAt(local, LOAD_SEC, SCROLL_SEC);
  return (
    <div style={{ position: 'relative', flex: 1, marginTop: 20, overflow: 'hidden', borderTop: '2px solid #EFEDE9', opacity: show }}>
      <Img src={staticFile(image)} style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: `${100 + SCROLL_PCT}%`, objectFit: 'cover', objectPosition: 'top',
        transform: `translateY(${-scroll * SCROLL_PCT * 0.97}%) scale(${1.02 - show * 0.02})`, transformOrigin: 'top center' }} />
    </div>
  );
};

/** 浏览器卡：地址栏显示 url；有图时加载完显示网页截图，无图时一直转圈 */
export const Browser: React.FC<TemplateProps<'browser'>> = ({ props, local }) => {
  const { fps } = useVideoConfig();
  const progress = props.image ? loadedAt(local) : STALL_AT * (1 - Math.exp(-local / STALL_TAU));
  const fade = props.image ? easeAt(local, LOAD_SEC, 0.2) : 0;
  return (
    <SafeArea>
      <Reveal p={springAt(local, 0, fps)} dy={20}>
        <CardFrame padding="0" style={{ height: WIN_H, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <AddressBar url={props.url} progress={progress} fade={fade} />
          {props.image ? <Page image={props.image} local={local} /> : <Loading title={props.title} local={local} />}
        </CardFrame>
      </Reveal>
    </SafeArea>
  );
};
