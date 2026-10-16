// 第二幕（S06–S07，16.5–25.0s）：9:16 传送门转出样片真实背景「极简工作室」，世界上色（花园是 Seedance 循环）→ 顶出分镜卡
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F } from '../kit/theme';
import { Hero, PxImg, Sprite, useV, type Pose } from '../kit/px';
import { WorldView, WorldImg, GardenAnim, Foreground, TileRow, Soil, w2s, type Cam } from '../kit/world';
import { Panel, Kicker, Big, Win, Card, Hl, Portrait, Locks, Trail, Dust } from '../kit/ui';
import { prog, inOut, expoOut, overshoot, camInOut, follow, lerp, arc, clamp } from '../kit/anim';
import { SAMPLE } from '../timeline';

const GY = 840;
const PRESETS = ['01-study', '02-studio', '03-cafe', '04-night-window', '05-tech-dark', '06-japanese', '07-balcony', '08-library', '09-rooftop', '10-concrete'];
const PORTAL = { x: 1640, y: 188, w: 360, h: 640 };
const BLOCKS = [1480, 1660, 1840];
const BLOCK_Y = 430;

function camB(f: number): Cam {
  return { x: lerp(1780, 2140, prog(f, 612, 18, follow)), y: 540, z: 1 };
}

function heroB(f: number): { x: number; y: number; pose: Pose; s?: number; clip?: boolean } | null {
  if (f < 575) return { x: 1300 + 3 * (f - 497), y: GY, pose: 'walk' };
  if (f < 578) return { x: 1534, y: GY, pose: 'squash' };
  if (f < 600) { const t = (f - 578) / 22; return { x: lerp(1534, 1742, t), y: lerp(GY, 640, t) - arc(t, 170), pose: 'jump', s: f >= 592 ? lerp(1, 0.5, (f - 592) / 8) : 1, clip: f >= 594 }; }
  if (f < 630) return null;
  if (f < 645) { const t = (f - 630) / 15; return { x: 1444, y: lerp(-180, GY, t * t), pose: 'fall' }; }
  if (f < 650) return { x: 1444, y: GY, pose: 'squash' };
  if (f < 652) return { x: 1444, y: GY, pose: 'stand' };
  if (f < 664) { const t = (f - 652) / 12; return { x: 1444, y: GY - arc(t, 189), pose: 'jump' }; }
  if (f < 668) return { x: 1444, y: GY, pose: 'squash' };
  if (f < 680) return { x: lerp(1444, 1624, (f - 668) / 12), y: GY, pose: 'walk' };
  if (f < 692) { const t = (f - 680) / 12; return { x: 1624, y: GY - arc(t, 189), pose: 'jump' }; }
  if (f < 696) return { x: 1624, y: GY, pose: 'squash' };
  return { x: 1624, y: GY, pose: 'stand' };
}

/** 背景预设转轮：快滚两圈后停在样片实际用的「极简工作室」，急刹 overshoot 6px */
const Reel: React.FC<{ f: number; w: number; h: number }> = ({ f, w, h }) => {
  const ph = Math.round(w * 16 / 9);
  const total = (2 * 10 + 1) * ph;
  const t = prog(f, 509, 39, (x) => 1 - Math.pow(1 - x, 3));
  const settle = f >= 548 ? Math.sin(prog(f, 548, 8) * Math.PI) * 6 * (1 - prog(f, 548, 8)) : 0;
  const off = t * total + settle;
  const speed = f < 548 ? total * 3 * Math.pow(1 - t, 2) / 39 : 0;
  const base = Math.floor(off / ph);
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: '#111' }}>
      {[-1, 0, 1].map((k) => {
        const idx = (((base + k) % 10) + 10) % 10;
        return <PxImg key={k} src={`px/preset-${PRESETS[idx]}.png`} style={{ left: 0, top: (base + k) * ph - off + (h - ph) / 2, width: w, height: ph, filter: speed > 30 ? 'brightness(.75)' : undefined }} />;
      })}
      {speed > 30 ? Array.from({ length: 7 }, (_, i) => <i key={i} style={{ position: 'absolute', left: 18 + i * 46, top: ((f * 37 + i * 91) % h), width: 6, height: Math.min(160, speed * 0.6), background: 'rgba(255,255,255,.5)' }} />) : null}
      <div style={{ position: 'absolute', left: 22, bottom: 20, font: `600 19px/1 ${F.zh}`, color: '#fff', textShadow: '0 2px 6px rgba(0,0,0,.6)', opacity: prog(f, 550, 6) }}>
        极简工作室 <span style={{ font: `13px/1 ${F.px}`, marginLeft: 8, opacity: 0.85 }}>02/10</span>
      </div>
    </div>
  );
};

export const Act2: React.FC<{ f: number }> = ({ f }) => {
  const { v } = useV();
  const cam = camB(f);
  const h = heroB(f);
  const whipIn = 1 - prog(f, 487, 10, (t) => 1 - (1 - t) * (1 - t));
  // 上色：先是门那边（右），英雄跳进门后整片
  const R = f < 562 ? 2000 : lerp(2000, 3300, prog(f, 562, 16, expoOut));
  const L = f < 600 ? 2000 : lerp(2000, 0, prog(f, 600, 18, expoOut));
  const colorOn = R > 2001;
  const rise = prog(f, 497, 12, expoOut);
  const through = prog(f, 606, 22, camInOut);
  const camVx = h ? h.x + 78 + 120 : 1900;
  const winA = prog(f, 638, 12, expoOut);
  const WIN = v ? { x: 690, y: 152, w: 340, h: 600 } : { x: 1300, y: 110, w: 396, h: 704 };
  const SW = WIN.w - 24, SH = WIN.h - 56;
  const slot = (i: number) => ({ x: WIN.x + 12 + 14, y: WIN.y + 44 + 22 + i * (v ? 118 : 132) });
  const blockScreen = (i: number) => w2s(BLOCKS[i] + 42, BLOCK_Y, cam, v, camVx);
  const flight = (i: number, start: number) => {
    const t = prog(f, start, 18, camInOut);
    const a = blockScreen(i), b = slot(i);
    const p1 = { x: (a.x + b.x) / 2, y: Math.min(a.y, b.y) - 220 };
    const x = (1 - t) ** 2 * a.x + 2 * (1 - t) * t * p1.x + t * t * b.x;
    const y = (1 - t) ** 2 * a.y + 2 * (1 - t) * t * p1.y + t * t * b.y;
    return { x, y, t, rot: lerp(-8, 0, t), s: lerp(0.6, 1, t) * (t >= 1 ? 1 + 0.03 * Math.sin(prog(f, start + 18, 4) * Math.PI) : 1) };
  };
  const cards = [
    { start: 660, title: <><Hl>FDE岗位</Hl>基本定性，<Hl>生命周期</Hl>可能会很长</>, size: v ? 20 : 22 },
    { start: 688, title: SAMPLE.cardTitle, size: v ? 22 : 24 },
  ];
  const wash = prog(f, 734, 16, (t) => t * t);
  return (
    <AbsoluteFill style={{ transform: whipIn > 0 ? `translateX(${whipIn * 900}px)` : undefined, filter: whipIn > 0 ? `blur(${whipIn * 14}px)` : undefined, background: v ? C.w1 : '#8e9299' }}>
      <WorldView cam={cam} camVx={camVx}>
        <WorldImg kind="raw" />
        <div style={{ position: 'absolute', left: 0, top: 0, width: 3300, height: 1088, clipPath: `inset(0 ${3300 - R}px 0 ${L}px)`, opacity: colorOn ? 1 : 0 }}>
          <WorldImg kind="color" />
          <GardenAnim f={f} />
        </div>
        {colorOn && f < 620 ? [L, R].filter((x) => x > 4 && x < 3290).map((x, i) => <i key={i} style={{ position: 'absolute', left: x - 3, top: 0, width: 6, height: 1088, background: '#fff', opacity: 0.85, zIndex: 3 }} />) : null}
        <TileRow text={SAMPLE.ground2} x0={600} kind="text" />
        <TileRow text={SAMPLE.line2 + SAMPLE.line2} x0={600} y={GY + 60} kind="dim" />
        <Soil />
        {/* 传送门：9:16 产品浮窗 */}
        {f < 630 ? (
          <div style={{ position: 'absolute', left: PORTAL.x, top: PORTAL.y, width: PORTAL.w, height: PORTAL.h, zIndex: 20, transformOrigin: '50% 100%', transform: `scaleY(${rise}) scale(${1 + through * 2.2})`, opacity: 1 - prog(f, 616, 12) }}>
            <Win x={0} y={0} w={PORTAL.w} h={PORTAL.h} title="背景 — 10 种预设" z={1}>
              <Reel f={f} w={PORTAL.w - 24} h={PORTAL.h - 56} />
            </Win>
            {f >= 509 ? <Locks x={0} y={0} w={PORTAL.w} h={PORTAL.h} a={prog(f, 509, 8, expoOut)} /> : null}
          </div>
        ) : null}
        {/* 卡片砖 */}
        {f >= 625 ? BLOCKS.map((bx, i) => {
          const hit = [658, 686, 99999][i];
          const used = f >= hit;
          const bump = f >= hit && f < hit + 6 ? -Math.sin(((f - hit) / 6) * Math.PI) * 14 : 0;
          return <Sprite key={i} name={used ? 'block-used' : 'block'} x={bx} y={BLOCK_Y + bump} anchor="top" cell={7} style={{ zIndex: 20, opacity: prog(f, 625 + i * 3, 6) }} />;
        }) : null}
        {[658, 686].map((hit, i) => f >= hit && f < hit + 10 ? [[-12, -30, 12], [72, -36, 12], [30, -54, 6]].map(([dx, dy, s], k) => <i key={`${i}${k}`} style={{ position: 'absolute', left: BLOCKS[i] + dx + (k - 1) * (f - hit) * 2, top: BLOCK_Y + dy - (f - hit) * 3 + 0.4 * (f - hit) ** 2, width: s, height: s, background: C.hero, outline: `3px solid ${C.ink}`, zIndex: 21 }} />) : null)}
        {f >= 578 && f < 602 ? <Trail p0={[1600, 800]} p1={[1660, 520]} p2={[1820, 640]} t={(f - 578) / 22} n={9} /> : null}
        {h ? <Hero x={h.x} y={h.y} pose={h.pose} f={f} style={{ ...(h.s && h.s < 1 ? { transform: `scale(${h.s})`, transformOrigin: '50% 50%' } : {}), ...(h.clip ? { clipPath: `inset(0 0 0 ${clamp((f - 594) / 6) * 60}%)` } : {}) }} /> : null}
        <Dust x={1456} y={GY - 18} t={(f - 645) / 10} />
      </WorldView>
      {f >= 630 ? <Foreground camX={v ? camVx : cam.x} dy={430} /> : null}
      {v ? <div style={{ position: 'absolute', left: 0, top: 1840, width: 1080, height: 80, background: '#d6d6d6' }} /> : null}

      {/* S06 文字 */}
      {f >= 550 && f < 616 ? (
        <Panel x={v ? 60 : 1290} y={v ? 168 : 190} w={v ? 960 : 520} a={inOut(f, 556, 12, 608)}>
          <Kicker p="STAGE 1-2" size={v ? 1.2 : 1}>抠像 · 换背景（10 种预设）</Kicker>
          <Big size={v ? 84 : 72} style={{ marginTop: 20 }}>换个世界</Big>
          <div style={{ marginTop: 26, display: 'flex', alignItems: 'baseline', gap: 14, font: `600 22px/1 ${F.zh}`, color: C.t2 }}>
            合成 <span style={{ font: `300 italic 64px/1 ${F.serif}`, color: C.b6 }}>5.8s</span><span style={{ font: `300 italic 26px/1 ${F.serif}`, color: C.t3 }}>(原来 35s)</span>
          </div>
        </Panel>
      ) : null}

      {/* S07：9:16 分镜窗在画面层组装 */}
      {f >= 636 ? (
        <div style={{ position: 'absolute', left: 0, top: 0, transform: `translateX(${(1 - winA) * 700}px)`, zIndex: 45 }}>
          <Win x={WIN.x} y={WIN.y} w={WIN.w} h={WIN.h} title="v1 — 自动分镜">
            {[0, 1].map((i) => <div key={i} style={{ position: 'absolute', left: 14, top: 22 + i * (v ? 118 : 132), width: SW - 28, height: v ? 100 : 112, border: `4px dashed ${C.b3}`, borderRadius: 10, display: 'grid', placeItems: 'center', font: `13px/1 ${F.px}`, color: C.b5, opacity: f >= cards[i].start + 18 ? 0 : 1 }}>NEXT CARD</div>)}
            <Portrait x={0} y={SH / 2} w={SW} h={SH / 2} caption={SAMPLE.captions[0]} />
            <i style={{ position: 'absolute', left: 0, top: SH / 2 - 3, width: '100%', height: 6, background: C.hero }} />
          </Win>
        </div>
      ) : null}
      {f >= 636 ? cards.map((c, i) => {
        if (f < c.start - 2) return null;
        const fl = flight(i, c.start);
        return <Card key={i} x={fl.x} y={fl.y} w={SW - 28} title={c.title} size={c.size} style={{ zIndex: 46, transform: `rotate(${fl.rot}deg) scale(${fl.s})`, transformOrigin: '0 0', padding: '18px 20px' }} />;
      }) : null}
      {f >= 646 && f < 744 ? (
        <Panel x={v ? 40 : 96} y={v ? 168 : 120} w={v ? 610 : 520} a={inOut(f, 650, 12, 736)}>
          <Kicker p="POWER UP" size={v ? 1.1 : 1}>上半屏信息卡 · 下半屏人像</Kicker>
          <Big size={72} style={{ marginTop: 20 }}>自动分镜</Big>
        </Panel>
      ) : null}
      {wash > 0 ? <AbsoluteFill style={{ background: `radial-gradient(circle at ${v ? 860 : 1500}px ${v ? 450 : 460}px, #fff ${wash * 140}%, rgba(255,255,255,${wash}) ${wash * 160 + 10}%)`, opacity: Math.min(1, wash * 1.3), zIndex: 96 }} /> : null}
    </AbsoluteFill>
  );
};
