// HUD 顶栏（照工作台浅蓝顶栏）：数值全部是全局帧号的纯函数，与剧情同步
import React from 'react';
import { Img, staticFile } from 'remotion';
import { C, F } from './theme';
import { prog, expoOut, rollText } from './anim';
import { useV } from './px';
import { T } from '../timeline';

const changes = {
  bad: [[0, '0/2'], [T.STOMP1, '1/2'], [T.STOMP2, '2/2']] as [number, string][],
  check: [[0, 0], [600, 1], [662, 2], [690, 3], [932, 4], [1030, 5], [1094, 6], [T.CLIMAX, 7]] as [number, number][],
};
const at = <V,>(list: [number, V][], f: number): [V, number] => {
  let cur = list[0];
  for (const it of list) if (f >= it[0]) cur = it;
  return [cur[1], cur[0]];
};

export function hudVisible(f: number) {
  if (f < T.S02 || f >= T.S14) return 0;
  if (f >= T.S08 - 2 && f < T.S09) return 0;
  const a = f < T.S09 ? prog(f, T.S02, 12, expoOut) : prog(f, T.S09, 12, expoOut);
  return a;
}

const Item: React.FC<{ k: string; zh?: boolean; flash: boolean; children: React.ReactNode; v: boolean }> = ({ k, zh, flash, children, v }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: v ? 10 : 12, marginLeft: v ? 0 : 40, background: flash ? '#fff' : 'transparent', outline: flash ? `3px solid ${C.hero}` : 'none', outlineOffset: 6, boxShadow: flash ? '0 0 0 6px #fff' : 'none' }}>
    <span style={zh ? { font: `600 ${v ? 17 : 15}px/1 ${F.zh}`, color: C.b6 } : { font: `${v ? 14 : 13}px/1 ${F.px}`, color: C.b6 }}>{k}</span>
    {children}
  </div>
);

export const Hud: React.FC<{ f: number }> = ({ f }) => {
  const { v } = useV();
  const a = hudVisible(f);
  if (a <= 0) return null;
  const val = (s: string) => <span style={{ font: `${v ? 20 : 18}px/1 ${F.px}`, color: C.t1, whiteSpace: 'nowrap' }}>{s}</span>;
  const time = f < T.TIME_ROLL ? '2:12' : rollText(f, '2:12', '2:02', T.TIME_ROLL, 12);
  const [bad, badAt] = at(changes.bad, f);
  const [check, checkAt] = at(changes.check, f);
  const yen = f < T.CLIMAX ? '—' : rollText(f, '0.00', '3.76', T.CLIMAX, 18);
  const stage = f < 1094 ? 'v1' : f < T.S12 ? 'v1 ▸ v2' : 'v2';
  const fl = (t0: number) => t0 > 0 && f >= t0 && f < t0 + 14;
  const items = (
    <>
      <Item k="TIME" flash={f >= T.TIME_ROLL && f < T.TIME_ROLL + 22} v={v}>{val(time)}</Item>
      <Item k="口误" zh flash={fl(badAt)} v={v}>{val(bad)}</Item>
      <Item k="¥" flash={f >= T.CLIMAX && f < T.CLIMAX + 24} v={v}>{val(yen)}</Item>
      <Item k="CHECK" flash={fl(checkAt)} v={v}>
        <span style={{ display: 'flex', gap: 4 }}>{Array.from({ length: 7 }, (_, i) => <b key={i} style={{ width: v ? 11 : 12, height: 18, background: i < check ? C.b5 : C.b2, display: 'block' }} />)}</span>
        {check === 7 ? val('7/7') : null}
      </Item>
      <Item k="STAGE" flash={f >= 1094 && f < 1110} v={v}>{val(stage)}</Item>
    </>
  );
  const brand = (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, font: `600 ${v ? 22 : 19}px/1 ${F.zh}`, color: C.t1, marginRight: 'auto' }}>
      <Img src={staticFile('logo.svg')} style={{ width: v ? 40 : 34, height: v ? 40 : 34, borderRadius: 8 }} />明知AI剪辑
      <small style={{ font: `300 italic ${v ? 18 : 16}px/1 ${F.serif}`, color: C.t2 }}>(Mingzhi · MIT)</small>
    </div>
  );
  const teeth: React.CSSProperties = { position: 'absolute', left: 0, right: 0, bottom: -6, height: 6, background: `repeating-linear-gradient(90deg,${C.b1} 0 12px,transparent 12px 24px)` };
  return (
    <div style={{ position: 'absolute', left: 0, top: -(1 - a) * 80, width: '100%', zIndex: 80 }}>
      {v ? (
        <div style={{ position: 'relative', background: C.b1, padding: '26px 40px 22px', display: 'flex', flexDirection: 'column', gap: 22 }}>
          {brand}
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>{items}</div>
          <i style={teeth} />
        </div>
      ) : (
        <div style={{ position: 'relative', height: 64, background: C.b1, display: 'flex', alignItems: 'center', padding: '0 40px' }}>
          {brand}{items}<i style={teeth} />
        </div>
      )}
    </div>
  );
};
