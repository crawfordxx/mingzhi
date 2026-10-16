// S01 · 标志降采样（0–3.0s）：矢量 logo 四步降到 24×22 格，蓝底收进 HUD 的 logo（共享元素归位）
import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { C, F } from '../kit/theme';
import { Sprite, useV, type SpriteName } from '../kit/px';
import { prog, expoOut, camInOut, lerp } from '../kit/anim';

const STEPS: { at: number; name: SpriteName | 'svg'; label: string }[] = [
  { at: 0, name: 'svg', label: 'SVG' },
  { at: 12, name: 'ele-step64', label: '64 PX' },
  { at: 27, name: 'ele-step40', label: '40 PX' },
  { at: 42, name: 'ele-flat', label: '24 PX' },
];

export const Open: React.FC<{ f: number }> = ({ f }) => {
  const { v, W, H } = useV();
  const cur = [...STEPS].reverse().find((s) => f >= s.at)!;
  const ew = 432, eh = 396;
  const cx = W / 2, cy = v ? 820 : 490;
  const L = cx - ew / 2, Tp = cy - eh / 2;
  const blink = f >= 66 && f < 70;
  // 收束到 HUD logo 位置
  const c = prog(f, 78, 14, camInOut);
  const tgt = v ? { x: 40, y: 26, s: 40 } : { x: 40, y: 15, s: 34 };
  const inset = `inset(${lerp(0, tgt.y, c)}px ${lerp(0, W - tgt.x - tgt.s, c)}px ${lerp(0, H - tgt.y - tgt.s, c)}px ${lerp(0, tgt.x, c)}px round ${lerp(0, 8, c)}px)`;
  const k = lerp(1, tgt.s / ew * 1.1, c);
  const move = `translate(${lerp(0, tgt.x + tgt.s / 2 - cx, c)}px,${lerp(0, tgt.y + tgt.s / 2 - cy, c)}px) scale(${k})`;
  const gridA = prog(f, 45, 9);
  const textA = 1 - c;
  return (
    <AbsoluteFill style={{ clipPath: inset, zIndex: 90 }}>
      <AbsoluteFill style={{ background: C.hero }} />
      <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, transform: move, transformOrigin: `${cx}px ${cy}px` }}>
        <div style={{ position: 'absolute', inset: 0, opacity: gridA * 0.9, backgroundImage: 'linear-gradient(rgba(255,255,255,.12) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.12) 1px,transparent 1px)', backgroundSize: '18px 18px', backgroundPosition: `${(L % 18) - 1}px ${(Tp % 18) - 1}px`, WebkitMaskImage: `radial-gradient(ellipse ${v ? 60 : 34}% ${v ? 30 : 46}% at 50% ${(cy / H) * 100}%,#000 40%,transparent 100%)` }} />
        {cur.name === 'svg'
          ? <Img src={staticFile('logo-mark.svg')} style={{ position: 'absolute', left: L - 6, top: Tp - 14, width: ew + 12, height: eh + 30, filter: 'brightness(0) invert(1)', opacity: prog(f, 0, 6) }} />
          : <Sprite name={blink && cur.name === 'ele-flat' ? 'ele-flat' : cur.name} x={L} y={Tp} anchor="top" cell={cur.name === 'ele-flat' ? 18 : cur.name === 'ele-step64' ? ew / 64 : ew / 40} />}
        {blink ? <i style={{ position: 'absolute', left: L + 19 * 18, top: Tp + 3 * 18, width: 36, height: 36, background: '#FAFAFA' }} /> : null}
      </div>
      <div style={{ position: 'absolute', left: 0, top: v ? 1240 : 830, width: W, display: 'flex', justifyContent: 'center', gap: v ? 40 : 72, opacity: textA }}>
        {STEPS.map((s, i) => (
          <div key={i} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 14, opacity: f >= s.at ? 1 : 0.25, transform: `translateY(${f >= s.at ? 0 : 8}px)` }}>
            {s.name === 'svg'
              ? <Img src={staticFile('logo-mark.svg')} style={{ width: 92, height: 82, filter: 'brightness(0) invert(1)' }} />
              : <Sprite name={s.name} x={0} y={0} anchor="top" cell={s.name === 'ele-flat' ? 3.75 : s.name === 'ele-step64' ? 90 / 64 : 90 / 40} style={{ position: 'relative' }} />}
            <span style={{ font: `12px/1 ${F.px}`, color: cur === s ? '#fff' : 'rgba(255,255,255,.6)' }}>{s.label}</span>
          </div>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 80, top: 72, font: `600 22px/1 ${F.zh}`, color: '#fff', display: 'flex', gap: 14, alignItems: 'baseline', opacity: textA * prog(f, 4, 10, expoOut) }}>
        明知AI剪辑 <span style={{ font: `300 italic 20px/1 ${F.serif}`, opacity: 0.8 }}>(Mingzhi)</span>
      </div>
      <div style={{ position: 'absolute', right: 80, top: v ? 120 : 76, font: `14px/1 ${F.px}`, color: 'rgba(255,255,255,.8)', opacity: textA * prog(f, 8, 10, expoOut) }}>OPEN SOURCE · MIT</div>
    </AbsoluteFill>
  );
};
