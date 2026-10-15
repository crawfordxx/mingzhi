// 第一幕（S02–S05，3.0–16.5s）：灰色原片关卡。落地 → 转录铺路 → 踩「直接」→ 踩「完成」→ 合缝，2:12 → 2:02
import React from 'react';
import { AbsoluteFill } from 'remotion';
import { C, F, STEP } from '../kit/theme';
import { Hero, useV, type Pose } from '../kit/px';
import { WorldView, WorldImg, Tile, Soil, tileBase, type Cam } from '../kit/world';
import { Panel, Kicker, Big, Pop, Burst, Dust, Trail, Term } from '../kit/ui';
import { prog, inOut, expoOut, camInOut, follow, lerp, arc, clamp, keys, rollText } from '../kit/anim';
import { T, SAMPLE } from '../timeline';

const GY = 840; // 地平线
const wave = (f: number) => (f < 196 ? -999 : 16 * (f - 196)); // 转录波前（世界 x）

// 地砖布局（原始 x），口误占 2 格
type Tok = { x0: number; ch?: string; bad?: string };
const TOKS: Tok[] = (() => {
  let x = 0;
  return SAMPLE.ground.map((t) => {
    const tok: Tok = typeof t === 'string' ? { x0: x, ch: t } : { x0: x, bad: t.bad };
    x += typeof t === 'string' ? 60 : 120;
    return tok;
  });
})();
const M1 = TOKS.find((t) => t.bad === '直接')!.x0; // 1320
const M2 = TOKS.find((t) => t.bad === '完成')!.x0; // 2700
const c1 = (f: number) => prog(f, 392, 12, follow); // 第一处合缝
const c2 = (f: number) => prog(f, 426, 18, follow); // 第二处合缝
const shift = (x0: number, f: number) => x0 - (x0 > M1 ? 120 * c1(f) : 0) - (x0 > M2 ? 120 * c2(f) : 0);

/** 英雄路径：返回脚底左上锚点（世界坐标）与姿势 */
export function heroA(f: number): { x: number; y: number; pose: Pose; s?: number } | null {
  if (f < 92) return null;
  if (f < 108) { const t = (f - 92) / 16; return { x: lerp(40, 360, t), y: lerp(40, GY, t * t), pose: 'fall', s: lerp(0.3, 1, t) }; }
  if (f < 114) return { x: 360, y: GY, pose: 'squash' };
  if (f < 150) return { x: 360, y: GY, pose: 'stand' };
  if (f < 340) return { x: 360 + 4 * (f - 150), y: GY, pose: 'walk' };
  if (f < 344) return { x: 1120, y: GY, pose: 'squash' };
  if (f < 370) { const t = (f - 344) / 26; return { x: lerp(1120, M1 - 18, t), y: lerp(GY, GY - 54, t) - arc(t, 240), pose: 'jump' }; }
  if (f < 374) return { x: M1 - 18, y: GY - 54 + 36 * prog(f, 370, 3), pose: 'squash' };
  if (f < 390) { const t = (f - 374) / 16; return { x: lerp(M1 - 18, 1500, t), y: lerp(GY - 18, GY, t) - arc(t, 120), pose: 'jump' }; }
  if (f < 394) return { x: 1500 - 120 * c1(f), y: GY, pose: 'squash' };
  if (f < 405) return { x: 1500 - 120 * c1(f), y: GY, pose: 'stand' };
  // ── 白闪切到第二只（时间跳跃）
  const m2 = M2 - 120;
  if (f < 412) { const t = (f - 405) / 7; return { x: m2 - 18, y: lerp(560, GY - 54, t * t), pose: 'fall' }; }
  if (f < 416) return { x: m2 - 18, y: GY - 54 + 36 * prog(f, 412, 3), pose: 'squash' };
  if (f < 432) { const t = (f - 416) / 16; return { x: lerp(m2 - 18, 2370, t), y: lerp(GY - 18, GY, t) - arc(t, 150), pose: 'jump' }; }
  if (f < 436) return { x: 2370, y: GY, pose: 'squash' };
  if (f >= 484 && f < 498) { const t = (f - 484) / 14; return { x: 2370, y: GY - arc(t, 60), pose: 'cheer' }; }
  return { x: 2370, y: GY, pose: 'stand' };
}

function camA(f: number): Cam {
  const hx = (g: number) => heroA(g)?.x ?? 360;
  if (f < 186) return { x: 960, y: 540, z: 1 };
  const s03 = (g: number): Cam => ({ x: hx(g) + 78 + 240, y: 640, z: 1.5 });
  const s04 = (g: number): Cam => {
    let sum = 0;
    for (let k = 0; k < 10; k++) sum += hx(g - k);
    return { x: clamp(sum / 10 + 378, 960, 2280), y: 540, z: 1 };
  };
  if (f < 196) { const t = prog(f, 186, 10, camInOut); const a = { x: 960, y: 540, z: 1 }, b = s03(196); return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }; }
  if (f < 300) return s03(f);
  if (f < 312) { const t = prog(f, 300, 12, camInOut); const a = s03(300), b = s04(312); return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), z: lerp(a.z, b.z, t) }; }
  if (f < 405) return s04(f);
  return { x: 2560, y: 780, z: 2 };
}

/** 口误小怪：转录波前经过时从字幕行里跳出来（留下坑），被踩扁后碎成像素落进坑 */
const Monster: React.FC<{ x0: number; text: string; f: number; stomp: number; close: (f: number) => number }> = ({ x0, text, f, stomp, close }) => {
  const x = shift(x0, f) + (x0 === M2 ? 0 : 0);
  const reveal = (x0 + 30) / 16 + 196; // 波前到达
  if (f < reveal) return null;
  const pop = prog(f, reveal + 4, 6, expoOut);
  const flat = prog(f, stomp, 3);
  const h = lerp(54, 18, flat);
  const shattered = f >= stomp + 6;
  const pitW = 120 - 120 * close(f) + (x0 > M1 && x0 !== M1 ? 0 : 0);
  const eyes = !shattered && flat < 0.5;
  const blink = Math.floor((f - reveal) / 30) % 4 === 3 && (f - reveal) % 30 < 4;
  return (
    <>
      {pitW > 1 ? <div style={{ position: 'absolute', left: x, top: GY, width: Math.max(0, pitW), height: 60, background: C.ink, zIndex: 9, overflow: 'hidden' }}><i style={{ position: 'absolute', left: 18, top: 18, width: 6, height: 6, background: '#5a3a1a', boxShadow: '30px 12px 0 #5a3a1a, 66px 24px 0 #3a2410, 84px 6px 0 #5a3a1a' }} /></div> : null}
      {!shattered ? (
        <div style={{ position: 'absolute', left: x, top: lerp(GY + 6, GY - h, pop), width: 120, height: h, background: C.cut, outline: `3px solid ${C.ink}`, outlineOffset: -3, boxShadow: `inset 6px 6px 0 ${C.cutL}, inset -6px -6px 0 ${C.cutD}`, display: 'grid', placeItems: 'center', font: `36px/1 ${F.pz}`, color: '#fff', WebkitFontSmoothing: 'none', zIndex: 12, overflow: 'visible' }}>
          {flat < 0.5 ? text : null}
          {eyes ? [33, 75].map((l) => <i key={l} style={{ position: 'absolute', left: l, top: blink ? -6 : -12, width: 12, height: blink ? 6 : 12, background: '#fff', outline: `3px solid ${C.ink}` }}>{blink ? null : <i style={{ position: 'absolute', left: 6, top: 6, width: 6, height: 6, background: C.ink }} />}</i>) : null}
          {eyes ? [12, 57, 102].map((l) => <i key={l} style={{ position: 'absolute', left: l, bottom: -6, width: 6, height: 6, background: C.ink }} />) : null}
        </div>
      ) : null}
      {shattered && f < stomp + 26 ? [[6, 0, 12], [48, 6, 12], [84, 0, 6], [30, 12, 6]].map(([dx, dy, s], i) => {
        const t = f - stomp - 6;
        return <i key={i} style={{ position: 'absolute', left: x + dx + (i - 1.5) * t * 0.8, top: GY - 12 + dy + 0.6 * t * t, width: s, height: s, background: C.cut, outline: `2px solid ${C.ink}`, zIndex: 8 }} />;
      }) : null}
      {f >= stomp + 6 && f < stomp + 40 ? <Pop x={x - 12} y={GY - 170} text={text} a={inOut(f, stomp + 6, 8, stomp + 34, 6, expoOut)} /> : null}
      {f >= stomp && f < stomp + 10 ? <Burst x={x + 60} y={GY - 24} f={f} /> : null}
    </>
  );
};

const Ground: React.FC<{ f: number }> = ({ f }) => {
  const W = wave(f);
  return (
    <>
      {TOKS.map((t, i) => {
        const x = shift(t.x0, f);
        if (t.bad) {
          if (W < t.x0 + 30) return [0, 60].map((d) => <Tile key={`${i}-${d}`} x={x + d} ch="" kind="raw" f={f} seed={i * 3 + d} />);
          return null; // 小怪接管
        }
        const flip = clamp((W - t.x0) / 96);
        return <Tile key={i} x={x} ch={t.ch!} kind="text" f={f} flip={flip} seed={i} />;
      })}
      {[...SAMPLE.line2].map((ch, i) => {
        const x0 = i * 60;
        const on = W - 60 > x0;
        return <div key={`b${i}`} style={{ ...tileBase, left: x0, top: GY + 60, ...(on ? { background: '#f1f1f1', color: '#b9b9b9', boxShadow: 'inset -6px -6px 0 #e4e4e4', outlineColor: '#cfcfcf' } : { background: '#b4b8bf', color: 'transparent', boxShadow: 'inset -6px -6px 0 #a7abb3', outlineColor: '#9ca0a8' }) }}>{ch}</div>;
      })}
      <Soil raw />
    </>
  );
};

export const Act1: React.FC<{ f: number }> = ({ f }) => {
  const { v } = useV();
  const cam = camA(f);
  const h = heroA(f);
  const whip = prog(f, 487, 10, (t) => t * t);
  const flashCut = f >= 403 && f < 408 ? [0.4, 1, 1, 0.6, 0.2][f - 403] : 0;
  const scoreA = inOut(f, 448, 12, 487, 4);
  const camVx = h ? h.x + 78 + 160 : 600;
  return (
    <AbsoluteFill style={{ transform: whip > 0 ? `translateX(${-whip * 900}px)` : undefined, filter: whip > 0 ? `blur(${whip * 14}px)` : undefined, background: v ? C.w1 : '#8e9299' }}>
      <WorldView cam={cam} camVx={f >= 405 ? 2440 : camVx}>
        <WorldImg kind="raw" />
        <div style={{ position: 'absolute', left: 0, top: 0, width: 3400, height: 1080, background: 'linear-gradient(180deg,rgba(40,44,52,.12),rgba(40,44,52,0) 40%)' }} />
        <Ground f={f} />
        <Monster x0={M1} text="直接" f={f} stomp={T.STOMP1} close={c1} />
        <Monster x0={M2} text="完成" f={f} stomp={T.STOMP2} close={c2} />
        {f >= 344 && f < 372 ? <Trail p0={[1180, 800]} p1={[1260, 540]} p2={[M1 + 40, 760]} t={(f - 344) / 26} n={11} /> : null}
        {f >= 426 && f < 446 ? [[0, 858, 42], [1, 876, 24], [2, 894, 54]].map(([i, y, w]) => <i key={i} style={{ position: 'absolute', left: shift(M2 + 120, f) + 12 + i * 6 + 7 * 60 + 12, top: y - 6, width: w * (1 - c2(f)), height: 6, background: '#fff', outline: `2px solid ${C.ink}`, zIndex: 13 }} />) : null}
        {f >= 444 && f < 448 ? <i style={{ position: 'absolute', left: M2 - 123, top: GY, width: 6, height: 60, background: '#fff', boxShadow: `0 0 0 3px ${C.hero}`, zIndex: 14 }} /> : null}
        {h ? <Hero x={h.x} y={h.y} pose={h.pose} f={f} style={h.s && h.s < 1 ? { transform: `scale(${h.s})`, transformOrigin: '0 100%' } : undefined} /> : null}
        <Dust x={372} y={GY - 18} t={(f - 108) / 10} />
        <Dust x={1512} y={GY - 18} t={(f - 390) / 10} />
        <Dust x={2382} y={GY - 18} t={(f - 432) / 10} />
      </WorldView>
      {v ? <div style={{ position: 'absolute', left: 0, top: 1840, width: 1080, height: 80, background: '#a7abb2' }} /> : null}

      {/* S02 文字 */}
      {f < 190 ? (
        <>
          <div style={{ position: 'absolute', left: v ? 60 : 96, top: v ? 168 : 92, zIndex: 50, opacity: inOut(f, 100, 10, 182), font: `14px/1 ${F.px}`, color: '#fff', background: C.ink, padding: '9px 12px 8px' }}>1-1<span style={{ font: `500 15px/1 ${F.zh}`, marginLeft: 10 }}>原片 · 书房</span></div>
          <div style={{ position: 'absolute', left: v ? 60 : 96, top: v ? 222 : 146, zIndex: 50, opacity: inOut(f, 104, 10, 182), display: 'flex', alignItems: 'center', gap: 12, font: `16px/1 ${F.px}`, color: '#fff', background: 'rgba(27,18,6,.55)', padding: '10px 14px' }}>
            <i style={{ width: 16, height: 16, background: Math.floor(f / 15) % 2 ? '#e2412c' : '#7a2318', display: 'block' }} />REC <span style={{ font: `500 17px/1 ${F.zh}`, marginLeft: 6 }}>talk.mp4</span><span style={{ opacity: 0.85, marginLeft: 6 }}>2:12</span>
          </div>
          <Panel x={v ? 60 : 1032} y={v ? 300 : 214} w={v ? 960 : 760} a={inOut(f, 114, 12, 182)}>
            <Kicker p="STAGE 1-1" size={v ? 1.2 : 1}>乱糟糟的原片，丢进来就行</Kicker>
            <Big size={v ? 108 : 96} style={{ marginTop: 22 }}>一条口播，</Big>
          </Panel>
        </>
      ) : null}

      {/* S03 文字 + 终端 */}
      {f >= 196 && f < 300 ? (
        <>
          <Panel x={v ? 60 : 96} y={v ? 168 : 120} w={v ? 960 : 600} a={inOut(f, 205, 12, 290)} pad="24px 32px 28px">
            <Kicker p="LOCAL ONLY" size={v ? 1.2 : 1}>字幕在你电脑上识别</Kicker>
            <Big size={v ? 84 : 72} style={{ marginTop: 16 }}>音频不出本机</Big>
          </Panel>
          <Term x={v ? 60 : 1180} y={v ? 450 : 110} w={v ? 960 : 640} a={inOut(f, 200, 10, 290)} shown={Math.floor(clamp((f - 206) / 9 + 1, 0, 4))} lines={[
            <><span style={{ color: '#8f8f8f' }}>$</span> mingzhi talk.mp4</>,
            <><span style={{ color: '#7fd18b' }}>✓</span> 抽音频　<span style={{ color: '#8f8f8f' }}>16kHz · 只在本机</span></>,
            <><span style={{ color: '#7fd18b' }}>✓</span> 识别　　<span style={{ color: '#8f8f8f' }}>本机模型 · 不上传</span></>,
            <><span style={{ color: '#9fb6ff' }}>▸</span> 转录　　<span style={{ color: '#8f8f8f' }}>逐字铺成地砖…</span><i style={{ display: 'inline-block', width: 9, height: 17, background: '#9fb6ff', verticalAlign: -3, marginLeft: 4 }} /></>,
          ]} />
        </>
      ) : null}

      {/* S04 文字 */}
      {f >= 310 && f < 405 ? (
        <Panel x={v ? 60 : 96} y={v ? 168 : 120} w={v ? 960 : 300} a={inOut(f, 312, 12, 398)} pad="22px 30px 26px">
          <Kicker p="STOMP" size={v ? 1.2 : 1}>AI 剪掉口误和气口</Kicker>
          <Big size={v ? 84 : 60} style={{ marginTop: 14 }}>踩掉口误</Big>
        </Panel>
      ) : null}

      {/* S05 计分牌 */}
      {f >= 448 ? (
        <div style={{ position: 'absolute', left: v ? 60 : 1000, top: (v ? 200 : 190) + (1 - scoreA) * 30, opacity: clamp(scoreA * 1.5), zIndex: 50 }}>
          <div style={{ background: C.hero, color: '#fff', padding: '26px 40px 30px', display: 'flex', flexDirection: 'column', gap: 14, boxShadow: `inset 0 -12px 0 ${C.heroD}`, clipPath: STEP, width: v ? 960 : undefined }}>
            <div style={{ font: `16px/1 ${F.px}`, opacity: 0.85 }}>TIME · 这条样片</div>
            <div style={{ font: `300 italic ${v ? 150 : 132}px/1 ${F.serif}`, letterSpacing: -2, whiteSpace: 'nowrap' }}>2:12 <span style={{ opacity: 0.6 }}>→</span> <span style={{ opacity: f < T.TIME_ROLL ? 0 : 1 }}>{rollText(f, '2:12', '2:02', T.TIME_ROLL, 12)}</span></div>
            <div style={{ font: `600 22px/1 ${F.zh}`, opacity: 0.92 }}>剪掉口误 2 处 · 缝自己合上</div>
          </div>
        </div>
      ) : null}
      {flashCut > 0 ? <AbsoluteFill style={{ background: '#fff', opacity: flashCut, zIndex: 95 }} /> : null}
    </AbsoluteFill>
  );
};
