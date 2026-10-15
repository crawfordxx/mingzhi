// 第三幕（S09–S11，27.5–39.0s）：一句话改 → 只重渲第 4 段 → 存档 v2、双版本对比
import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { C, F, STEP_S } from '../kit/theme';
import { Hero, useV, type Pose } from '../kit/px';
import { WorldView, WorldImg, GardenAnim, Foreground, TileRow, Soil, type Cam } from '../kit/world';
import { Panel, Kicker, Big, Win, CutFrame, Portrait, Locks, Cursor, Confetti } from '../kit/ui';
import { prog, inOut, expoOut, overshoot, camInOut, follow, lerp, arc, clamp } from '../kit/anim';
import { SAMPLE } from '../timeline';

const GY = 840;
// 打字脚本：3f/字符，「了」多打一次 → 停 5f → 退格（预写，确定性）
const TYPED: { f: number; chip: string; text: string }[] = (() => {
  const out: { f: number; chip: string; text: string }[] = [];
  let f = 876; let chip = ''; let text = '';
  for (const ch of '@00:14') { chip += ch; out.push({ f, chip, text }); f += 3; }
  f += 3;
  for (const ch of '这张卡太弱了了') { text += ch; out.push({ f, chip, text }); f += 3; }
  f += 5; text = text.slice(0, -1); out.push({ f, chip, text });
  return out;
})();
const typedAt = (f: number) => { let cur = { f: 0, chip: '', text: '' }; for (const t of TYPED) if (f >= t.f) cur = t; return cur; };
const TYPE_END = TYPED[TYPED.length - 1].f;

const REPLY = ['明白，', '只改第 4 段', '这张卡，', '其余镜头', '原样复用。'];
const REPLY_AT = [975, 979, 986, 991, 997];

function camC(f: number): Cam { return { x: lerp(2140, 2260, prog(f, 1050, 20, follow)), y: 540, z: 1 }; }

export const Act3: React.FC<{ f: number }> = ({ f }) => {
  const { v } = useV();
  const cam = camC(f);
  const L = v ? {
    win: { x: 360, y: 150, w: 360, h: 620 }, box: { x: 40, y: 1500, w: 1000, h: 260 }, heroBox: { x: 640, y: 1506 }, cur0: { x: 900, y: 1300 },
    reply: { x: 40, y: 160, w: 1000, h: 230 }, strip: { W: 80, G: 10, cols: 11, T: 930, L0: 50 }, cap: { x: 60, y: 450 },
    v1: { x: 210, y: 150 }, v2: { x: 570, y: 150 }, ww: 300, wh: 600, pill: { x: 330, y: 778 }, save: { x: 40, y: 880, w: 520 },
  } : {
    win: { x: 1180, y: 96, w: 396, h: 640 }, box: { x: 96, y: 790, w: 1728, h: 220 }, heroBox: { x: 980, y: 796 }, cur0: { x: 1560, y: 1000 },
    reply: { x: 96, y: 150, w: 1080, h: 200 }, strip: { W: 72, G: 10, cols: 22, T: 600, L0: 63 }, cap: { x: 1260, y: 160 },
    v1: { x: 1000, y: 150 }, v2: { x: 1400, y: 150 }, ww: 318, wh: 655, pill: { x: 1196, y: 96 }, save: { x: 96, y: 120, w: 380 },
  };
  const S = L.strip;
  const segH = Math.round(S.W * 16 / 9);
  const segPos = (i: number) => ({ x: S.L0 + (i % S.cols) * (S.W + S.G), y: S.T + Math.floor(i / S.cols) * (segH + 60) });
  const hot = segPos(SAMPLE.hotIndex);

  // 目标卡（S09 窗口里的上半屏卡片）
  const cardRect = { x: L.win.x + 12 + (L.win.w - 24) * 0.05, y: L.win.y + 44 + (L.win.h - 56) * 0.05, w: (L.win.w - 24) * 0.9, h: v ? 92 : 100 };
  const curT = prog(f, 835, 24, camInOut);
  const c0 = L.cur0, c2 = { x: cardRect.x + cardRect.w * 0.7, y: cardRect.y + cardRect.h * 0.55 };
  const c1 = { x: (c0.x + c2.x) / 2 + 160, y: (c0.y + c2.y) / 2 + 80 };
  const jit = (k: number) => Math.sin(f * 1.7 + k) * 2 * (1 - curT);
  const cur = { x: (1 - curT) ** 2 * c0.x + 2 * (1 - curT) * curT * c1.x + curT * curT * c2.x + jit(1), y: (1 - curT) ** 2 * c0.y + 2 * (1 - curT) * curT * c1.y + curT * curT * c2.y + jit(2) };
  const press = f >= 860 && f < 866 ? Math.sin(((f - 860) / 6) * Math.PI) : 0;

  // RPG 框：S08 地平线升起成上边框 → S09 打字 → FLIP 到上方变回复框
  const boxGrow = prog(f, 826, 10, expoOut);
  const flip = prog(f, 940, 18, camInOut);
  const box = {
    x: lerp(L.box.x, L.reply.x, flip), y: lerp(L.box.y, L.reply.y, flip),
    w: lerp(L.box.w, L.reply.w, flip), h: lerp(L.box.h, L.reply.h, flip) * (flip > 0 ? 1 : boxGrow),
  };
  const boxOut = prog(f, 1040, 12);
  const typed = typedAt(f);
  const caretOn = f < TYPE_END + 3 || Math.floor((f - TYPE_END) / 8) % 2 === 0;
  const isReply = f >= 950;

  // 英雄：站在对话框上 → 跳到第 4 段 → S11 落到存档旗下
  let hero: { x: number; y: number; pose: Pose; cell: number } | null = null;
  if (f >= 830 && f < 945) hero = { x: L.heroBox.x, y: box.y + 6, pose: f >= 932 && f < 940 ? 'cheer' : 'stand', cell: 6 };
  else if (f >= 945 && f < 968) { const t = (f - 945) / 23; hero = { x: lerp(L.heroBox.x, hot.x + S.W / 2 - 65, t), y: lerp(L.heroBox.y, hot.y + 3, t) - arc(t, 200), pose: 'jump', cell: 5 }; }
  else if (f >= 968 && f < 1046) hero = { x: hot.x + S.W / 2 - 65, y: hot.y + 3, pose: f < 972 ? 'squash' : 'stand', cell: 5 };

  const haze = f < 958 ? 0.16 : f < 1050 ? lerp(0.16, 0.5, prog(f, 958, 17)) : lerp(0.5, 0, prog(f, 1050, 15));
  const s10Out = prog(f, 1040, 14);
  const flyT = prog(f, 1045, 20, camInOut);
  // S11
  const v1In = prog(f, 1066, 12, expoOut);
  const flagUp = prog(f, 1080, 10, expoOut);
  const flagPop = prog(f, 1090, 10, overshoot);
  const wave = Math.floor(f / 4) % 2;
  const heroS11: { x: number; y: number; pose: Pose } | null = f < 1065 ? null
    : f < 1080 ? { x: 1630, y: lerp(-150, GY, ((f - 1065) / 15) ** 2), pose: 'fall' }
    : f < 1084 ? { x: 1630, y: GY, pose: 'squash' }
    : f >= 1100 && f < 1142 ? { x: 1630, y: GY - arc(((f - 1100) % 21) / 21, 90), pose: 'cheer' }
    : { x: 1630, y: GY, pose: 'stand' };
  const dip = prog(f, 1150, 16);
  const toCinema = prog(f, 1150, 22, camInOut);
  const cinemaWin = v ? { x: 540 - 150, y: 560, w: 300, h: 533 } : { x: 964 - 131, y: 272, w: 262, h: 466 };

  const v1Frame = <CutFrame w={L.ww - 24} h={L.wh - 56 - 76} title={SAMPLE.cardTitle} caption={SAMPLE.captionAt14} size={v ? 22 : 24} />;
  const v2Frame = <CutFrame w={L.ww - 24} h={L.wh - 56 - 76} title={SAMPLE.cardTitle} sub={SAMPLE.cardSub} caption={SAMPLE.captionAt14} size={v ? 24 : 26} />;
  const bar = (blue: boolean, note: string) => (
    <div style={{ position: 'absolute', left: 0, bottom: 0, width: '100%', height: 76, background: '#fff' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '12px 12px 0' }}>
        <i style={{ width: 30, height: 30, borderRadius: 15, background: '#111', display: 'block', position: 'relative' }}><i style={{ position: 'absolute', left: 11, top: 9, borderLeft: '10px solid #fff', borderTop: '6px solid transparent', borderBottom: '6px solid transparent' }} /></i>
        <div style={{ flex: 1, height: 3, background: '#e6e6e6', position: 'relative' }}><b style={{ position: 'absolute', left: `${(14 / 122) * 100}%`, top: -5, width: 13, height: 13, borderRadius: 7, background: blue ? C.hero : '#111' }} /></div>
      </div>
      <div style={{ padding: '10px 14px 0', font: `13px/1 ${F.zh}`, color: '#777', display: 'flex', justifyContent: 'space-between' }}><span>分镜卡 · 第 4/22 段</span><span style={{ color: blue ? C.b5 : '#999' }}>{note}</span></div>
    </div>
  );
  const compareWin = (which: 1 | 2, x: number, y: number, extra?: React.CSSProperties) => (
    <div style={{ position: 'absolute', left: 0, top: 0, ...extra }}>
      <Win x={x} y={y} w={L.ww} h={L.wh} title={`v${which} — 00:14 分镜卡`} z={30}>
        <div style={{ position: 'absolute', inset: 0 }}>{which === 1 ? v1Frame : v2Frame}{bar(which === 2, which === 2 ? '只重渲这一段' : '原版')}</div>
      </Win>
    </div>
  );

  return (
    <AbsoluteFill>
      <WorldView cam={cam} camVx={2000}>
        <WorldImg kind="color" />
        <GardenAnim f={f} />
        <TileRow text={SAMPLE.ground2} x0={600} kind="text" />
        <TileRow text={SAMPLE.line2 + SAMPLE.line2} x0={600} y={GY + 60} kind="dim" />
        <Soil />
        {/* 存档旗（世界里） */}
        {f >= 1078 ? (
          <>
            <div style={{ position: 'absolute', left: 1882, top: GY - 510 * flagUp, width: 12, height: 510 * flagUp, background: '#fff', outline: `3px solid ${C.ink}`, zIndex: 14 }} />
            <div style={{ position: 'absolute', left: 1870, top: GY - 510 * flagUp - 30, width: 36, height: 36, background: C.hero, outline: `3px solid ${C.ink}`, clipPath: STEP_S, zIndex: 15 }} />
            {f >= 1090 ? <div style={{ position: 'absolute', left: 1894, top: GY - 510 + 16, width: 228, height: 114, background: C.hero, outline: `3px solid ${C.ink}`, outlineOffset: -3, boxShadow: `inset 0 6px 0 #4d80ff, inset 0 -9px 0 ${C.heroD}`, zIndex: 14, display: 'grid', placeItems: 'center', transformOrigin: '0 50%', transform: `scaleX(${flagPop}) skewY(${wave ? 3 : -2}deg)` }}><span style={{ font: `52px/1 ${F.px}`, color: '#fff' }}>v2</span></div> : null}
          </>
        ) : null}
        {heroS11 ? <Hero x={heroS11.x} y={heroS11.y} pose={heroS11.pose} f={f} /> : null}
      </WorldView>
      {f >= 1060 ? <Foreground camX={v ? 2000 : cam.x} dy={440} /> : null}
      {v ? <div style={{ position: 'absolute', left: 0, top: 1840, width: 1080, height: 80, background: '#d6d6d6' }} /> : null}
      <AbsoluteFill style={{ background: `rgba(255,255,255,${haze})`, zIndex: 31 }} />

      {/* S09 分镜窗（v1） */}
      {f < 975 ? (
        <div style={{ position: 'absolute', inset: 0, zIndex: 40, opacity: 1 - prog(f, 958, 10) }}>
          <Win x={L.win.x} y={L.win.y} w={L.win.w} h={L.win.h} title="v1 — 00:14 分镜卡">
            <CutFrame w={L.win.w - 24} h={L.win.h - 56} title={SAMPLE.cardTitle} caption={SAMPLE.captionAt14} size={v ? 24 : 26} />
          </Win>
          {f >= 864 ? <Locks x={cardRect.x} y={cardRect.y} w={cardRect.w} h={cardRect.h} a={prog(f, 864, 8, expoOut)} /> : null}
          {f >= 866 ? <span style={{ position: 'absolute', left: v ? L.win.x - 10 : L.win.x - 160, top: v ? L.win.y + L.win.h + 10 : cardRect.y + 20, background: C.hero, color: '#fff', font: `600 20px/1 ${F.zh}`, padding: '10px 16px', clipPath: STEP_S, transform: `scale(${prog(f, 866, 8, overshoot)})`, zIndex: 41 }}>@00:14 · 第 4 段</span> : null}
          {f >= 832 && f < 900 ? <Cursor x={cur.x} y={cur.y} press={press} ripple={f - 863} /> : null}
        </div>
      ) : null}

      {/* RPG 框：你说 → 明知回复 */}
      {f >= 826 && f < 1056 ? (
        <div style={{ position: 'absolute', left: box.x, top: box.y + (boxOut * -40), width: box.w, height: box.h, background: '#fff', outline: `6px solid ${C.ink}`, outlineOffset: -6, zIndex: 50, opacity: 1 - boxOut }}>
          <div style={{ position: 'absolute', left: 30, top: -27, background: C.ink, color: '#fff', font: `16px/1 ${F.px}`, padding: '10px 14px 9px', opacity: boxGrow }}>{isReply ? 'MINGZHI' : 'YOU'}<span style={{ font: `600 17px/1 ${F.zh}`, marginLeft: 8 }}>{isReply ? '明知' : '你说'}</span></div>
          {!isReply ? (
            <div style={{ position: 'absolute', left: 56, top: v ? 74 : 62, right: 56, opacity: boxGrow * (1 - prog(f, 942, 6)) }}>
              <div style={{ display: 'flex', alignItems: 'center', font: `48px/1 ${F.pz}`, color: '#141414', WebkitFontSmoothing: 'none', whiteSpace: 'nowrap' }}>
                {typed.chip ? <span style={{ display: 'inline-flex', background: C.b1, color: C.b6, padding: '6px 12px', marginRight: 16 }}>{typed.chip}</span> : null}
                {typed.text}
                <span style={{ display: 'inline-block', width: 14, height: 52, background: C.hero, marginLeft: 4, opacity: caretOn ? 1 : 0 }} />
              </div>
              <div style={{ position: 'absolute', left: 0, top: v ? 120 : 108, font: `500 18px/1 ${F.zh}`, color: C.t3 }}>用一句话改 · 不用剪辑软件</div>
              <div style={{ position: 'absolute', right: 0, top: v ? 120 : 108, font: `14px/1 ${F.px}`, color: C.b5, background: f >= 932 && f < 938 ? C.b1 : 'transparent', padding: 4 }}>ENTER ▸</div>
            </div>
          ) : (
            <div style={{ position: 'absolute', inset: 0, opacity: prog(f, 952, 6) }}>
              <Img src={staticFile('logo-180.png')} style={{ position: 'absolute', left: 44, top: (box.h - 132) / 2, width: 132, height: 132, borderRadius: 14 }} />
              <div style={{ position: 'absolute', left: 210, top: v ? 52 : 44, right: 40, font: `36px/1.45 ${F.pz}`, color: '#141414', WebkitFontSmoothing: 'none' }}>
                {REPLY.map((c, i) => (f >= REPLY_AT[i] ? <span key={i}>{c}{i === 2 ? <br /> : null}</span> : null))}
              </div>
            </div>
          )}
        </div>
      ) : null}
      {hero ? <Hero x={hero.x} y={hero.y} pose={hero.pose} f={f} cell={hero.cell} style={{ zIndex: 55 }} /> : null}

      {/* S10 分镜条：只有第 4 段重渲 */}
      {f >= 960 && f < 1068 ? (
        <div style={{ position: 'absolute', inset: 0, zIndex: 45 }}>
          {Array.from({ length: SAMPLE.shots }, (_, i) => {
            const p = segPos(i), isHot = i === SAMPLE.hotIndex;
            const a = prog(f, 962 + i, 8, expoOut);
            const out = isHot ? 0 : prog(f, 1040 + (i % 5), 10);
            const scan = prog(f, 1000, 30);
            if (isHot && flyT > 0) return null;
            return (
              <div key={i} style={{ position: 'absolute', left: p.x, top: p.y - (1 - a) * 40, width: S.W, height: segH, opacity: a * (1 - out), background: isHot ? '#fffdf6' : '#eceef2', outline: `${isHot ? 6 : 4}px solid ${isHot ? C.hero : '#b9bec8'}`, outlineOffset: isHot ? -6 : -4, overflow: 'hidden', boxShadow: isHot ? '0 0 0 6px #fff, 0 18px 40px rgba(1,77,249,.35)' : undefined }}>
                <div style={{ position: 'absolute', left: 8, top: 10, width: S.W - 16, height: 26, background: '#fff', borderRadius: 4, boxShadow: `0 2px 0 ${isHot ? C.b2 : '#d6d6d6'}` }}>
                  <i style={{ position: 'absolute', left: 6, top: 8, width: isHot ? 44 : 32, height: 5, background: isHot ? '#111' : '#9aa0aa' }} /><i style={{ position: 'absolute', left: 6, top: 17, width: 24, height: 4, background: isHot ? '#888' : '#c2c6cc' }} />
                </div>
                {isHot ? (
                  <>
                    <Portrait x={4} y={segH / 2} w={S.W - 8} h={(segH / 2 - 4) * scan} />
                    <div style={{ position: 'absolute', left: 4, top: segH / 2 + (segH / 2 - 4) * scan, width: S.W - 8, height: (segH / 2 - 4) * (1 - scan), backgroundImage: `linear-gradient(${C.b2} 2px,transparent 2px),linear-gradient(90deg,${C.b2} 2px,transparent 2px)`, backgroundSize: '12px 12px', backgroundColor: '#fff' }} />
                    {scan < 1 ? <i style={{ position: 'absolute', left: 0, top: segH / 2 + (segH / 2 - 4) * scan - 3, width: '100%', height: 6, background: C.hero }} /> : null}
                  </>
                ) : <Portrait x={4} y={segH / 2} w={S.W - 8} h={segH / 2 - 4} preset={['02-studio', '02-studio', '02-studio'][i % 3]} style={{ filter: 'grayscale(1) contrast(.8) brightness(1.08)', opacity: 0.75 }} />}
              </div>
            );
          })}
          {Array.from({ length: SAMPLE.shots }, (_, i) => {
            const p = segPos(i), isHot = i === SAMPLE.hotIndex;
            const a = prog(f, 1004 + i, 6) * (1 - prog(f, 1040, 8));
            return <div key={`l${i}`} style={{ position: 'absolute', left: p.x - 10, width: S.W + 20, top: p.y + segH + 14, textAlign: 'center', opacity: a }}><span style={{ display: 'inline-block', padding: '6px 6px 5px', font: `${v ? 10 : 9}px/1 ${F.px}`, background: isHot ? C.hero : 'rgba(255,255,255,.9)', color: isHot ? '#fff' : '#5d626b' }}>{isHot ? 'RENDER' : 'REUSE'}</span></div>;
          })}
          {flyT > 0 ? (() => {
            const x = lerp(hot.x, L.v2.x, flyT), y = lerp(hot.y, L.v2.y, flyT), w = lerp(S.W, L.ww, flyT), hh = lerp(segH, L.wh, flyT);
            return <div style={{ position: 'absolute', left: x, top: y, width: w, height: hh, background: '#fffdf6', outline: `6px solid ${C.hero}`, outlineOffset: -6, borderRadius: lerp(0, 22, flyT), opacity: 1 - prog(f, 1062, 6), boxShadow: '0 30px 60px rgba(0,0,0,.25)' }} />;
          })() : null}
          <div style={{ position: 'absolute', left: L.cap.x, top: L.cap.y, opacity: inOut(f, 990, 10, 1040, 8) }}>
            <Kicker p="RE-RENDER" size={v ? 1.2 : 1} />
            <Big size={v ? 84 : 72} style={{ marginTop: 16 }}>{v ? '只重渲这一段' : <>只重渲<br />这一段</>}</Big>
          </div>
        </div>
      ) : null}

      {/* S11 双版本对比 + 存档 */}
      {f >= 1060 && f < 1172 ? (
        <div style={{ position: 'absolute', inset: 0, zIndex: 46 }}>
          {compareWin(1, L.v1.x, L.v1.y, { transform: `translateX(${(1 - v1In) * -600}px)`, opacity: v1In * (1 - dip) })}
          {f >= 1062 ? compareWin(2, lerp(L.v2.x, cinemaWin.x, toCinema), lerp(L.v2.y, cinemaWin.y, toCinema), { opacity: prog(f, 1062, 6) * (1 - prog(f, 1168, 4)), transformOrigin: `${L.v2.x}px ${L.v2.y}px`, transform: `scale(${lerp(1, cinemaWin.w / L.ww, toCinema)})` }) : null}
          {f >= 1066 && toCinema === 0 ? <Locks x={L.v2.x + 12 + (L.ww - 24) * 0.05} y={L.v2.y + 44 + (L.wh - 56 - 76) * 0.05} w={(L.ww - 24) * 0.9} h={v ? 100 : 108} a={prog(f, 1070, 8, expoOut)} /> : null}
          <div style={{ position: 'absolute', left: L.pill.x, top: L.pill.y, background: '#fff', borderRadius: 999, padding: '12px 24px', font: `500 19px/1 ${F.zh}`, boxShadow: '0 8px 20px rgba(0,0,0,.12)', opacity: prog(f, 1084, 8) * (1 - dip), transform: `translateY(${(1 - prog(f, 1084, 10, expoOut)) * 12}px)`, whiteSpace: 'nowrap' }}>同步播放 · 只有 <b style={{ color: C.b5 }}>1 段</b>不同</div>
          <Panel x={L.save.x} y={L.save.y} w={L.save.w} a={inOut(f, 1092, 12, 1150, 8)} pad="24px 32px 28px">
            <Kicker p="SAVE" size={v ? 1.1 : 1}>每一版都存档</Kicker>
            <Big size={72} style={{ marginTop: 14 }}>存档 v2</Big>
            <div style={{ marginTop: 16, font: `500 21px/1 ${F.zh}`, color: C.t2 }}>可对比 · 可回退 · 可导出</div>
          </Panel>
          <Confetti f={f} start={1100} n={18} box={v ? [600, 1050, 420, 240] : [540, 300, 420, 200]} seed={11} z={39} />
        </div>
      ) : null}
      {dip > 0 ? <AbsoluteFill style={{ background: `rgba(18,10,4,${dip * 0.88})`, zIndex: 45 }} /> : null}
    </AbsoluteFill>
  );
};
