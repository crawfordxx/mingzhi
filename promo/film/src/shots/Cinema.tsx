// S12 成片通关 · 影院（39.0–44.5s，高潮 41.5s）+ S13 结算格（44.5–48.0s）
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F, STEP } from '../kit/theme';
import { Hero, PxImg, useV } from '../kit/px';
import { Big, CutFrame, Hl } from '../kit/ui';
import { prog, inOut, expoOut, camInOut, lerp, arc, clamp, rollText } from '../kit/anim';
import { T, SAMPLE } from '../timeline';
import { Confetti3D } from './Confetti3D';

const PLAY = [
  { at: 1170, title: SAMPLE.cardTitle, sub: SAMPLE.cardSub, cap: SAMPLE.captions[7] },
  { at: 1200, title: SAMPLE.cardTitle, sub: SAMPLE.cardSub, cap: SAMPLE.captions[8] },
  { at: 1230, title: SAMPLE.cardList, sub: '都是乙方身份', cap: '那相似点呢很明显' },
  { at: 1275, title: <><Hl>FDE岗位</Hl>基本定性，<Hl>生命周期</Hl>可能会很长</>, sub: undefined, cap: SAMPLE.captions[0] },
];

export const Cinema: React.FC<{ f: number }> = ({ f }) => {
  const { v, W, H } = useV();
  const fadeIn = prog(f, 1160, 16);
  const dolly = prog(f, 1182, 48, camInOut);
  const dip = prog(f, 1318, 20);
  const collapse = prog(f, 1424, 14, camInOut);
  // 画面坐标：银幕中心
  const img = v ? { w: 2880, h: 1920, l: -906, t: 54 } : { w: 1920, h: 1280, l: 0, t: -60 };
  const sc = v ? { x: 540, y: 900 } : { x: 964, y: 504 };
  const win = v ? { w: 300, h: 533 } : { w: 262, h: 466 };
  const sBack = 1 + 0.32 * dolly, sFront = 1 + 0.62 * dolly;
  const play = [...PLAY].reverse().find((p) => f >= p.at) ?? PLAY[0];
  const climax = f >= T.CLIMAX;
  const slam = (i: number) => prog(f, T.CLIMAX + i * 2, 4, expoOut);
  const hero = { x: v ? 640 : 1230, y: v ? 1520 : 820 };
  const heroPose = f >= T.CLIMAX ? 'cheer' : 'stand';
  const heroY = f >= T.CLIMAX ? hero.y - arc(((f - T.CLIMAX) % 21) / 21, 70) : hero.y;
  const s13 = f >= T.S13 - 4;
  return (
    <AbsoluteFill style={{ opacity: fadeIn, zIndex: 47 }}>
      <AbsoluteFill style={{ filter: dip > 0 ? `blur(${dip * 8}px) brightness(${1 - dip * 0.45}) saturate(${1 - dip * 0.2})` : undefined, background: '#1a0e06' }}>
        {/* 后层：墙与银幕 + 银幕上放映的成片 */}
        <div style={{ position: 'absolute', inset: 0, transformOrigin: `${sc.x}px ${sc.y}px`, transform: `scale(${sBack})` }}>
          <PxImg src="px/cinema.png" style={{ left: img.l, top: img.t, width: img.w, height: img.h }} />
          <div style={{ position: 'absolute', left: sc.x - win.w * 1.4, top: sc.y - win.h * 0.75, width: win.w * 2.8, height: win.h * 1.5, background: 'radial-gradient(closest-side, rgba(255,246,222,.9), rgba(255,246,222,0))', opacity: 0.75 + 0.1 * Math.sin(f / 9) }} />
          <div style={{ position: 'absolute', left: sc.x - win.w / 2, top: sc.y - win.h / 2, width: win.w, height: win.h, borderRadius: 4, overflow: 'hidden', boxShadow: '0 0 0 6px rgba(255,250,235,.95), 0 0 120px rgba(255,240,200,.8)' }}>
            <CutFrame w={win.w} h={win.h} title={play.title} sub={play.sub} caption={play.cap} size={Math.round(win.w / 12)} />
            <div style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 34, background: 'linear-gradient(rgba(0,0,0,0),rgba(0,0,0,.55))', display: 'flex', alignItems: 'flex-end', padding: '0 10px 8px', font: `9px/1 ${F.px}`, color: '#fff', gap: 8 }}>
              <span>FINISHED CUT · 9:16</span>
              <i style={{ flex: 1, height: 3, background: 'rgba(255,255,255,.35)', position: 'relative', marginBottom: 2 }}><b style={{ position: 'absolute', left: 0, top: 0, height: 3, width: `${clamp((f - 1170) / 400) * 100}%`, background: '#fff' }} /></i>
            </div>
          </div>
        </div>
        {/* 前层：座椅（只取画面下部），推得更快 = 视差 */}
        <div style={{ position: 'absolute', inset: 0, transformOrigin: `${sc.x}px ${sc.y}px`, transform: `scale(${sFront})` }}>
          <PxImg src="px/cinema.png" style={{ left: img.l, top: img.t, width: img.w, height: img.h, WebkitMaskImage: 'linear-gradient(180deg, transparent 0%, transparent 70%, #000 78%)' }} />
          <Hero x={hero.x} y={heroY} pose={heroPose} f={f} />
          {climax ? [[-30, -100, 12], [180, -140, 6], [-10, -170, 6], [170, -60, 12]].map(([dx, dy, s], i) => <i key={i} style={{ position: 'absolute', left: hero.x + dx, top: hero.y + dy - (Math.floor(f / 4) % 2) * 6, width: s, height: s, background: '#fff', outline: `3px solid ${C.ink}`, zIndex: 23 }} />) : null}
        </div>
        {climax && f < 1340 ? <Confetti3D t={(f - T.CLIMAX) / 30} W={W} H={H} /> : null}
        {/* 高潮文字 */}
        {climax ? (
          <div style={{ position: 'absolute', left: v ? 60 : 96, top: v ? 170 : 150, zIndex: 65, opacity: 1 - prog(f, 1316, 8) }}>
            <div style={{ font: `${v ? 32 : 28}px/1 ${F.px}`, color: '#fff', textShadow: `4px 4px 0 ${C.ink}`, display: 'flex' }}>
              {[...'STAGE CLEAR'].map((ch, i) => <span key={i} style={{ display: 'inline-block', whiteSpace: 'pre', transform: `translateY(${(1 - slam(i)) * -30}px)`, opacity: slam(i) }}>{ch}</span>)}
            </div>
            <Big size={v ? 108 : 96} color="#fff" style={{ marginTop: 26, textShadow: `6px 6px 0 ${C.ink}`, whiteSpace: v ? 'nowrap' : 'normal' }}>
              <span style={{ display: 'inline-block', opacity: prog(f, T.CLIMAX + 5, 3), transform: `translateY(${(1 - prog(f, T.CLIMAX + 5, 4, expoOut)) * -24}px)` }}>成片，</span>{v ? null : <br />}
              <span style={{ display: 'inline-block', opacity: prog(f, T.CLIMAX + 13, 3), transform: `translateY(${(1 - prog(f, T.CLIMAX + 13, 4, expoOut)) * -24}px)` }}>通关。</span>
            </Big>
            <div style={{ marginTop: 28, font: `500 ${v ? 28 : 24}px/1.4 ${F.zh}`, color: '#fff', textShadow: '0 2px 8px rgba(0,0,0,.6)', opacity: prog(f, T.CLIMAX + 21, 8) }}>一条可以直接发布的 9:16</div>
          </div>
        ) : null}
      </AbsoluteFill>

      {/* S13 结算格 */}
      {s13 ? <Bento f={f} v={v} collapse={collapse} /> : null}
    </AbsoluteFill>
  );
};

const Cell: React.FC<{ a: number; style?: React.CSSProperties; children: React.ReactNode }> = ({ a, style, children }) => (
  <div style={{ background: '#fff', position: 'relative', padding: '28px 30px', clipPath: STEP, opacity: clamp(a * 1.5), transform: `translateY(${(1 - a) * 24}px)`, ...style }}>{children}</div>
);
const H6: React.FC<{ children: React.ReactNode }> = ({ children }) => <div style={{ font: `13px/1 ${F.px}`, color: C.b5, marginBottom: 18 }}>{children}</div>;
const N: React.FC<{ children: React.ReactNode; size?: number; color?: string }> = ({ children, size = 76, color = C.t1 }) => <div style={{ font: `300 italic ${size}px/1 ${F.serif}`, color, letterSpacing: -1, whiteSpace: 'nowrap' }}>{children}</div>;
const P: React.FC<{ children: React.ReactNode }> = ({ children }) => <div style={{ marginTop: 14, font: `18px/1.4 ${F.zh}`, color: C.t2 }}>{children}</div>;

const Bento: React.FC<{ f: number; v: boolean; collapse: number }> = ({ f, v, collapse }) => {
  const a = (i: number) => prog(f, 1346 + i * 6, 12, expoOut);
  const yenStart = 1346 + 4 * 6 + 15;
  const pips = Math.floor(clamp((f - (1346 + 18)) / 4, 0, 7));
  const box = v ? { x: 40, y: 170, w: 1000, h: 1540 } : { x: 150, y: 150, w: 1620, h: 820 };
  const cx = box.x + box.w / 2, cy = box.y + box.h / 2;
  return (
    <div style={{ position: 'absolute', left: box.x, top: box.y, width: box.w, height: box.h, display: 'grid', gap: 18, zIndex: 70,
      gridTemplateColumns: v ? '1fr 1fr' : '1.25fr 1fr 1fr', gridTemplateRows: v ? '72px 1.3fr 1fr 1fr' : '72px 1fr 1fr',
      transformOrigin: `${cx - box.x}px ${cy - box.y}px`, transform: `scale(${lerp(1, 0.06, collapse)})`, filter: collapse > 0 ? `blur(${collapse * 6}px)` : undefined, opacity: 1 - prog(f, 1434, 4) }}>
      <div style={{ gridColumn: v ? '1/3' : '1/4', display: 'flex', alignItems: 'center', gap: 22, color: '#fff', opacity: prog(f, 1340, 8), flexWrap: 'wrap' }}>
        <span style={{ font: `22px/1 ${F.px}` }}>RESULT</span><span style={{ font: `600 24px/1 ${F.zh}`, opacity: 0.9 }}>样片成绩单</span><span style={{ font: `13px/1 ${F.px}`, opacity: 0.7 }}>ALL REAL NUMBERS</span>
      </div>
      <Cell a={a(4)} style={v ? { gridColumn: '1/3', padding: '40px 44px' } : { gridRow: '2/4', padding: '44px 48px' }}>
        <H6>COST</H6>
        <div style={{ font: `600 26px/1 ${F.zh}`, color: C.t2 }}>这条 2:12 样片全程实花</div>
        <N size={v ? 200 : 196} color={C.hero}><span style={{ opacity: f < yenStart ? 0 : 1 }}>¥{rollText(f, '0.00', '3.76', yenStart, 15)}</span></N>
        <P>开源免费，在你电脑上运行 · 模型按量付费</P>
      </Cell>
      <Cell a={a(0)}><H6>TIME</H6><N>2:12 <span style={{ color: C.b5 }}>→</span> 2:02</N><P>剪掉口误 2 处</P></Cell>
      <Cell a={a(1)}><H6>BACKGROUND</H6><N>5.8s <span style={{ fontSize: 34, color: C.t3 }}>(原来 35s)</span></N><P>抠像换背景合成 · 另一次实测</P></Cell>
      <Cell a={a(2)}><H6>RE-RENDER</H6><N>61s <span style={{ color: C.b5 }}>→</span> 1.8s</N><P>改节奏只重渲改动的段 · 另一次实测</P></Cell>
      <Cell a={a(3)}><H6>CHECK</H6>
        <div style={{ display: 'flex', alignItems: 'flex-end', gap: 22 }}>
          <div style={{ display: 'flex', gap: 8 }}>{Array.from({ length: 7 }, (_, i) => <b key={i} style={{ width: 26, height: 64, background: i < pips ? C.b5 : C.b1, display: 'block' }} />)}</div>
          <N size={64}>7/7</N>
        </div>
        <P>成片硬检查全过</P>
      </Cell>
    </div>
  );
};
