// S14 · 片尾（48.0–53.0s）：结算格坍缩成蓝块 → 展开成 logo；「把一条口播，变成 finished cut.」+ GitHub + MIT，最后 1.5s 绝对静止
import React from 'react';
import { AbsoluteFill, Img, staticFile } from 'remotion';
import { C, F } from '../kit/theme';
import { useV } from '../kit/px';
import { prog, expoOut, overshoot, camInOut, lerp } from '../kit/anim';

export const End: React.FC<{ f: number }> = ({ f }) => {
  const { v, W, H } = useV();
  const bg = prog(f, 1436, 6);
  const logo = v ? { x: 540 - 170, y: 260, s: 340 } : { x: 1340, y: 300, s: 420 };
  const move = prog(f, 1438, 8, camInOut);
  const grow = prog(f, 1444, 16, overshoot);
  const sq = lerp(60, logo.s, grow);
  const sx = lerp(W / 2 - 30, logo.x + logo.s / 2 - sq / 2, move), sy = lerp(H / 2 - 30, logo.y + logo.s / 2 - sq / 2, move);
  const logoA = prog(f, 1452, 6);
  const line = (start: number) => ({ opacity: prog(f, start, 6), transform: `translateY(${(1 - prog(f, start, 10, expoOut)) * 26}px)` });
  const wipe = prog(f, 1466, 12, expoOut);
  const hx = v ? 60 : 160;
  return (
    <AbsoluteFill style={{ zIndex: 85 }}>
      <AbsoluteFill style={{ background: '#fff', opacity: bg }} />
      {f >= 1438 ? <div style={{ position: 'absolute', left: sx, top: sy, width: sq, height: sq, background: C.hero, borderRadius: lerp(4, logo.s * 0.22, grow), opacity: 1 - logoA }} /> : null}
      {f >= 1518 && f < 1523 ? <i style={{ position: 'absolute', left: logo.x + logo.s * 0.676, top: logo.y + logo.s * 0.27, width: logo.s * 0.075, height: logo.s * 0.045, background: '#FAFAFA', borderRadius: 4, zIndex: 2 }} /> : null}
      <Img src={staticFile('logo.svg')} style={{ position: 'absolute', left: logo.x, top: logo.y, width: logo.s, height: logo.s, borderRadius: logo.s * 0.22, opacity: logoA, boxShadow: `0 40px 80px rgba(1,77,249,${0.22 * logoA})` }} />
      <div style={{ position: 'absolute', left: hx, top: v ? 760 : 330, font: `600 ${v ? 92 : 104}px/1.22 ${F.zh}`, color: '#111', letterSpacing: -1 }}>
        <div style={line(1452)}>把一条口播，</div>
        <div style={{ ...line(1462), display: 'flex', alignItems: 'center', gap: 22, whiteSpace: 'nowrap' }}>变成
          <span style={{ position: 'relative', font: `200 italic ${v ? 104 : 118}px/1 ${F.serif}`, color: C.b6, padding: '0 26px 14px 18px' }}>
            <i style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${wipe * 100}%`, background: C.b1, zIndex: -1 }} />finished cut.
          </span>
        </div>
      </div>
      <div style={{ position: 'absolute', left: hx, top: v ? 1110 : 720, display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <span style={{ ...line(1478), background: '#111', color: '#fff', borderRadius: 999, padding: '20px 30px', font: `500 ${v ? 30 : 26}px/1 ${F.mono}` }}>github.com/crawfordxx/mingzhi</span>
        <span style={{ ...line(1484), background: C.w3, color: '#111', borderRadius: 999, padding: '20px 28px', font: `600 ${v ? 28 : 24}px/1 ${F.zh}` }}>MIT · 开源免费</span>
      </div>
      <div style={{ position: 'absolute', left: hx, top: v ? 1290 : 820, font: `400 ${v ? 26 : 22}px/1.5 ${F.zh}`, color: C.t2, ...line(1492) }}>在你的电脑上运行 · 音频不出本机 · 用一句话改</div>
      <div style={{ position: 'absolute', left: hx, top: v ? 110 : 120, display: 'flex', alignItems: 'center', gap: 12, font: `600 22px/1 ${F.zh}`, color: '#111', ...line(1456) }}>明知AI剪辑 <span style={{ font: `300 italic 20px/1 ${F.serif}`, color: C.t2 }}>(Mingzhi)</span></div>
      <div style={{ position: 'absolute', left: 0, top: H - 72, width: W, height: 1, background: C.w4, opacity: prog(f, 1496, 8) }} />
      <div style={{ position: 'absolute', left: hx, top: H - 50, font: `13px/1 ${F.px}`, color: C.t3, opacity: prog(f, 1496, 8) }}>MINGZHI · MIT LICENSE</div>
      <div style={{ position: 'absolute', right: v ? 60 : 160, top: H - 50, font: `13px/1 ${F.px}`, color: C.t3, opacity: prog(f, 1496, 8) }}>RENDERED WITH REMOTION</div>
    </AbsoluteFill>
  );
};
