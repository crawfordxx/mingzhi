import React from 'react';
import { AbsoluteFill, Easing, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { shotAt, visualLayout } from '../../src/compose/layout.js';
import { cardCarry, cardLead, carryStyle, drawsCard, wipeAt } from '../../src/compose/card-carry.js';
import type { Broll, CardSpec, Shot } from '../../src/storyboard/schema.js';
import { CANVAS } from '../../src/storyboard/schema.js';
import { THEME } from '../theme.js';
import { PaletteContext, stageBackground, usePalette } from '../palette.js';
import { DEFAULT_PALETTE, type Palette } from '../../src/compose/palette.js';
import { renderBackdrop, renderCard } from '../templates/index.js';
import { FLOAT_SCALE, GLASS, SolidGlassContext, SurfaceContext } from '../templates/parts.js';
import { BrollMedia } from './BrollLayer.js';
import { MediaBadge } from '../templates/MediaBadge.js';
import { splitShadeBackground } from './shade.js';

/** 进场：从下方 80px、0.94 缩放、透明度 0 弹入（约 0.5 秒收敛）；全片第一个镜头不从空白开始，内容第 0 帧就完整，只从 1.035 轻轻收回 */
const ENTER_DY = 80;
const ENTER_SCALE = 0.94;
const SETTLE_SCALE = 1.035;
/** 退场（在下一个镜头开头的交叉过渡里）：上移、略缩、变虚、淡出 */
const EXIT_DY = 28;
const EXIT_SCALE = 0.03;
const EXIT_BLUR = 8;

/** 交叉过渡的退场进度：缓入缓出 */
export const exitEase = (t: number): number => interpolate(t, [0, 1], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp', easing: Easing.inOut(Easing.cubic) });

type Motion = { enter: 'spring' | 'settle'; exit: number };

/** 卡片进出场：exit 为退场进度（0 未退场 → 1 完全退出） */
const CardMotion: React.FC<{ card: CardSpec; local: number; dur: number; motion: Motion; lead?: number }> = ({ card, local, dur, motion, lead = 0 }) => {
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.round(local * fps), fps, config: { damping: 16, mass: 0.7 } });
  const settle = motion.enter === 'settle';
  const e = motion.exit;
  const style: React.CSSProperties = {
    position: 'absolute', inset: 0,
    opacity: settle ? 1 : Math.min(1, s),
    transform: settle
      ? `translateY(${-e * EXIT_DY}px) scale(${interpolate(s, [0, 1], [SETTLE_SCALE, 1]) - e * EXIT_SCALE})`
      : `translateY(${interpolate(s, [0, 1], [ENTER_DY, 0]) - e * EXIT_DY}px) scale(${interpolate(s, [0, 1], [ENTER_SCALE, 1]) - e * EXIT_SCALE})`,
    filter: e > 0 ? `blur(${(e * EXIT_BLUR).toFixed(2)}px)` : undefined,
  };
  return <div style={style}>{renderCard(card, local + lead, dur + lead)}</div>;
};

/** 分屏上半屏素材图的压暗：顶部轻压给状态栏，下部渐暗托住贴底排的卡片信息与压在分界线上的字幕 */
const SPLIT_SHADE = 'linear-gradient(180deg, rgba(0, 0, 0, 0.3) 0%, rgba(0, 0, 0, 0) 20%, rgba(0, 0, 0, 0) 38%, rgba(10, 9, 8, 0.5) 72%, rgba(10, 9, 8, 0.78) 100%)';
/**
 * 浮层：整块卡片区（1080×960）缩到 0.64，像下三分之一字条一样压在人物胸前：卡片内容贴底排，底边约在 y=1242，
 * 整块（含钩子、图片的固定底）底边 1300，在 y=1400 的字幕上方；卡片向上长，最高不过 y≈780，不遮脸
 */
const FLOAT_BOTTOM = 1300;
const FLOAT_TOP = FLOAT_BOTTOM - CANVAS.seam * FLOAT_SCALE;
/** 从没有卡片的镜头（人物全屏等）切进分屏：卡片区连同完整的卡片在 3 帧内快速显出（不从空白弹入），人像在下面同时下移，不露米色空底 */
const FADE_IN_SEC = 0.1;
/** 浮层只有素材时的小窗：16:9 圆角，压在人物胸前、字幕上方（底边 1290 与画中画一致），脸始终露出 */
const FLOAT_MEDIA = { w: 720, h: 405, bottom: 1290, radius: 32 } as const;
const SEAM_BOX: React.CSSProperties = { position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam, overflow: 'hidden' };

/** 一个镜头在卡片层上的画法参数：local/dur 为镜头内时间，motion 为进出场，lead 为卡片内部时钟的提前量（见 cardLead） */
type Part = { shot: Shot; local: number; dur: number; motion: Motion; lead?: number };

/** 铺图变体（broll.legible）的压暗：中段起就压下去，卡片与直接压在图上的浅色字（面包屑、钩子标题）都落在深色上 */
const SPLIT_SHADE_LEGIBLE = 'linear-gradient(180deg, rgba(0, 0, 0, 0.42) 0%, rgba(0, 0, 0, 0.2) 20%, rgba(10, 9, 8, 0.4) 40%, rgba(10, 9, 8, 0.74) 62%, rgba(10, 9, 8, 0.88) 100%)';

/**
 * 分屏的底：有素材时素材铺满 + 渐变压暗（铺图变体压得更深），否则米色底 + 模板固定底（钩子黑底、图片）。
 * 画面角标（AI 生成、来源）画在压暗层之上：压暗是为了让文字看清，不能把必须标注的角标一起压暗
 */
const SplitBase: React.FC<Part> = ({ shot, local, dur }) => {
  const label = shot.broll?.label;
  const stage = stageBackground(usePalette());
  return (
    <div style={{ ...SEAM_BOX, background: stage }}>
      {shot.broll ? <>
        <BrollMedia broll={{ ...shot.broll, label: undefined }} local={local} dur={dur} />
        <AbsoluteFill style={{ background: splitShadeBackground(shot.broll.legible ? SPLIT_SHADE_LEGIBLE : SPLIT_SHADE, shot.broll) }} />
        {label ? <MediaBadge label={label} /> : null}
      </> : shot.card ? renderBackdrop(shot.card, local, dur) : null}
    </div>
  );
};

/** 分屏的卡片：有素材时贴底排在图上（白卡变玻璃；铺图变体用几乎不透明的玻璃） */
const SplitContent: React.FC<Part> = ({ shot, local, dur, motion, lead }) => (
  <div style={SEAM_BOX}>
    <SurfaceContext.Provider value={shot.broll ? (shot.broll.textTop ? 'imageTop' : 'image') : 'paper'}>
      <SolidGlassContext.Provider value={Boolean(shot.broll?.legible)}>
        {shot.card ? <CardMotion card={shot.card} local={local} dur={dur} motion={motion} lead={lead} /> : null}
      </SolidGlassContext.Provider>
    </SurfaceContext.Provider>
  </div>
);

/** 浮层只有素材：胸前圆角小窗，白色细描边与投影，从下方弹簧缩放入场 */
const FloatMedia: React.FC<{ broll: Broll; local: number; dur: number; exit: number }> = ({ broll, local, dur, exit }) => {
  const { fps } = useVideoConfig();
  const s = spring({ frame: Math.round(local * fps), fps, config: { damping: 18, mass: 0.8 } });
  return (
    <div style={{ position: 'absolute', left: (CANVAS.width - FLOAT_MEDIA.w) / 2, top: FLOAT_MEDIA.bottom - FLOAT_MEDIA.h, width: FLOAT_MEDIA.w, height: FLOAT_MEDIA.h, borderRadius: FLOAT_MEDIA.radius, overflow: 'hidden',
      boxShadow: '0 28px 72px rgba(0, 0, 0, 0.42), 0 6px 18px rgba(0, 0, 0, 0.22)', opacity: Math.min(s, 1), transform: `translateY(${interpolate(s, [0, 1], [36, 0]) - exit * EXIT_DY}px) scale(${interpolate(s, [0, 1], [0.92, 1])})` }}>
      <BrollMedia broll={broll} local={local} dur={dur} />
      <div style={{ position: 'absolute', inset: 0, borderRadius: FLOAT_MEDIA.radius, boxShadow: 'inset 0 0 0 3px rgba(255, 255, 255, 0.92)' }} />
    </div>
  );
};

/** 浮层：人物全屏，顶部浮一张紧凑卡片（白卡变玻璃）；带固定底的模板（钩子、图片）连底一起放进圆角小窗；没有卡片时在胸前浮素材小窗 */
const FloatCard: React.FC<Part> = ({ shot, local, dur, motion, lead }) => {
  if (!shot.card) return shot.broll ? <FloatMedia broll={shot.broll} local={local} dur={dur} exit={motion.exit} /> : null;
  const backdrop = renderBackdrop(shot.card, local, dur);
  const frame: React.CSSProperties = backdrop ? { borderRadius: THEME.radius / FLOAT_SCALE, overflow: 'hidden', boxShadow: GLASS.boxShadow } : {};
  return (
    <div style={{ position: 'absolute', left: 0, top: FLOAT_TOP, width: CANVAS.width, height: CANVAS.seam, transform: `scale(${FLOAT_SCALE})`, transformOrigin: 'top center', ...frame }}>
      {backdrop}
      <SurfaceContext.Provider value={backdrop ? 'paper' : 'float'}>
        <CardMotion card={shot.card} local={local} dur={dur} motion={motion} lead={lead} />
      </SurfaceContext.Provider>
    </div>
  );
};

/** 全屏只叠 cta：不画卡片区底色，胶囊由模板自己放在画布上方（顶边 y=CTA_TOP=230，中心约 280） */
const FullCta: React.FC<Part> = ({ shot, local, dur, motion }) => (
  shot.card ? <div style={{ position: 'absolute', left: 0, top: 0, width: CANVAS.width, height: CANVAS.seam }}><CardMotion card={shot.card} local={local} dur={dur} motion={motion} /></div> : null
);

/** 一个镜头的完整画法（底 + 卡片）；全屏插入、画中画与不带 cta 的全屏不画 */
const WholeShot: React.FC<Part> = (p) => {
  const layout = visualLayout(p.shot);
  if (layout === 'split') return <><SplitBase {...p} /><SplitContent {...p} /></>;
  if (layout === 'overlay') return <FloatCard {...p} />;
  return layout === 'full' && p.shot.card?.template === 'cta' ? <FullCta {...p} /> : null;
};

/** 擦除时上一张卡顺着擦除方向被推走的距离、新卡从反方向滑入的距离（px）：两层速度不同，有纵深 */
const WIPE_PUSH = 90;
const WIPE_SLIDE = 160;
/** 擦除边缘的强调色细条宽度（px），只在擦除中段最亮 */
const WIPE_EDGE = 6;

/** 擦除的裁切：只留 [from, to] 这一段（横向从左往右、竖向从上往下的比例） */
const clipOf = (axis: 'x' | 'y', from: number, to: number): string =>
  axis === 'x' ? `inset(0 ${(1 - to) * 100}% 0 ${from * 100}%)` : `inset(${from * 100}% 0 ${(1 - to) * 100}% 0)`;
const shift = (axis: 'x' | 'y', px: number): string => (axis === 'x' ? `translateX(${px}px)` : `translateY(${px}px)`);

/**
 * 遮罩擦除：一道边缘沿阅读方向扫过卡片区，边缘之前是新卡（从反方向滑入落位），之后是旧卡（被同向推走），边缘上一道强调色细条。
 * 裁切在外层（不随位移走），位移在内层，所以画面上两张卡以边缘为界、任何一帧都不叠加
 */
const CardWipe: React.FC<{ prev: Part; cur: Part; t: number; axis: 'x' | 'y' }> = ({ prev, cur, t, axis }) => {
  const pal = usePalette();
  const p = wipeAt(t);
  const size = axis === 'x' ? CANVAS.width : CANVAS.seam;
  const edge: React.CSSProperties = axis === 'x'
    ? { left: p * size - WIPE_EDGE / 2, top: 0, width: WIPE_EDGE, height: CANVAS.seam }
    : { top: p * size - WIPE_EDGE / 2, left: 0, height: WIPE_EDGE, width: CANVAS.width };
  return (
    <>
      <div style={{ ...SEAM_BOX, clipPath: clipOf(axis, p, 1) }}><div style={{ ...SEAM_BOX, transform: shift(axis, p * WIPE_PUSH) }}><WholeShot {...prev} /></div></div>
      <div style={{ ...SEAM_BOX, clipPath: clipOf(axis, 0, p) }}><div style={{ ...SEAM_BOX, transform: shift(axis, -(1 - p) * WIPE_SLIDE) }}><WholeShot {...cur} /></div></div>
      <div style={{ position: 'absolute', ...edge, background: pal.accent, opacity: Math.sin(Math.PI * p), boxShadow: `0 0 24px ${pal.accent}` }} />
    </>
  );
};

const partOf = (shots: Shot[], index: number, sec: number, motion: Motion): Part => ({ shot: shots[index], local: sec - shots[index].start, dur: shots[index].end - shots[index].start, motion, lead: cardLead(shots, index) });

/**
 * 卡片层（shots 为画面时间轴）：分屏画上半屏；浮层画顶部浮卡；全屏只叠加 cta；全屏插入与画中画不画卡片（素材层负责）。
 * 交叉过渡：上一镜头的卡片在本镜头开头 CARD_XFADE_SEC 内退场（叠在本镜头的底之上、本镜头卡片之下），本镜头卡片同时进场；
 * 结构差异大的相邻分屏卡片（carryStyle 为 wipe）改用遮罩擦除（CardWipe），两张卡的文字任何一帧都不叠在一起
 */
export const CardLayer: React.FC<{ shots: Shot[]; sec: number }> = ({ shots, sec }) => {
  const hit = shotAt(shots, sec);
  if (!hit) return null;
  const carry = cardCarry(shots, sec);
  const cur = partOf(shots, hit.index, sec, { enter: hit.index === 0 ? 'settle' : 'spring', exit: 0 });
  if (!carry) {
    if (!drawsCard(hit.shot)) return null;
    if (!cur.lead) return <WholeShot {...cur} />;
    return <div style={{ position: 'absolute', inset: 0, opacity: exitEase(cur.local / FADE_IN_SEC) }}><WholeShot {...cur} motion={{ enter: 'settle', exit: 0 }} /></div>;
  }
  const style = carryStyle(shots, hit.index);
  if (style.kind === 'wipe') return <CardWipe prev={partOf(shots, carry.index, sec, { enter: 'settle', exit: 0 })} cur={{ ...cur, motion: { enter: 'settle', exit: 0 } }} t={carry.t} axis={style.axis} />;
  const e = exitEase(carry.t);
  const prev = partOf(shots, carry.index, sec, { enter: carry.index === 0 ? 'settle' : 'spring', exit: e });
  const split = visualLayout(hit.shot) === 'split';
  return (
    <>
      {split ? <SplitBase {...cur} /> : null}
      <div style={{ position: 'absolute', inset: 0, opacity: 1 - e }}><WholeShot {...prev} /></div>
      {split ? <SplitContent {...cur} /> : <WholeShot {...cur} />}
    </>
  );
};

/** 隐去全部文字（整片自检量铺图卡片的文字对比度：与正常静帧逐像素相减得到文字像素与背后的底色）；!important 盖过模板的行内颜色 */
const HIDE_TEXT = '* { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }';

/**
 * 单卡静帧合成（1080×960）：不做进出场，直接画模板在当前帧的状态；镜头时长取合成时长（可由 inputProps.dur 指定）；palette 为这条片的片色（缺省原配色）。
 * 给了 shot 时按成片的画法画这个镜头的卡片区（分屏素材做底、卡片排在图上）；hideText 时文字透明
 */
export const CardStill: React.FC<{ card: CardSpec; dur?: number; shot?: Shot; hideText?: boolean; palette?: Palette }> = ({ card, shot, hideText, palette }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const local = frame / fps;
  const dur = durationInFrames / fps;
  const pal = palette ?? DEFAULT_PALETTE;
  return (
    <PaletteContext.Provider value={pal}>
      <AbsoluteFill style={{ background: pal.stage }}>
        {hideText ? <style>{HIDE_TEXT}</style> : null}
        {shot ? <CardLayer shots={[{ ...shot, start: 0, end: dur }]} sec={local} /> : <>{renderBackdrop(card, local, dur)}{renderCard(card, local, dur)}</>}
      </AbsoluteFill>
    </PaletteContext.Provider>
  );
};
