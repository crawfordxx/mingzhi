// 文字面板、产品 UI 重建件（窗口 / 卡片 / 人像 / 终端）、像素特效（冲击星、尘土、轨迹、彩纸）
import React from 'react';
import { C, F, STEP, STEP_S } from './theme';
import { PxImg } from './px';
import { clamp, seeded } from './anim';

type XY = { x: number; y: number };

/** 白色像素面板 + 深品牌蓝投影；a = 入场进度（0→1，自下 24px 升起） */
export const Panel: React.FC<XY & { w: number; a?: number; pad?: string; children: React.ReactNode; z?: number; shadow?: boolean }> = ({ x, y, w, a = 1, pad = '30px 40px 32px', children, z = 40, shadow = true }) => (
  <div style={{ position: 'absolute', left: x, top: y + (1 - a) * 24, width: w, opacity: clamp(a * 1.4), zIndex: z }}>
    {shadow ? <div style={{ position: 'absolute', left: 12, top: 12, right: -12, bottom: -12, background: C.b6, clipPath: STEP }} /> : null}
    <div style={{ position: 'relative', background: '#fff', clipPath: STEP, padding: pad }}>{children}</div>
  </div>
);

export const Kicker: React.FC<{ p: string; children?: React.ReactNode; size?: number }> = ({ p, children, size = 1 }) => (
  <div style={{ display: 'flex', alignItems: 'center', gap: 14 * size, font: `${16 * size}px/1 ${F.zh}`, color: C.t2 }}>
    <span style={{ font: `${14 * size}px/1 ${F.px}`, color: C.b5 }}>{p}</span>{children}
  </div>
);

/** 像素大字（Fusion Pixel，12 的整数倍字号） */
export const Big: React.FC<{ size?: number; color?: string; children: React.ReactNode; style?: React.CSSProperties }> = ({ size = 96, color = '#141414', children, style }) => (
  <div style={{ font: `${size}px/1.08 ${F.pz}`, color, WebkitFontSmoothing: 'none', whiteSpace: 'nowrap', ...style }}>{children}</div>
);

export const Chip: React.FC<{ children: React.ReactNode; style?: React.CSSProperties }> = ({ children, style }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10, background: C.b1, color: C.b6, font: `600 20px/1 ${F.zh}`, padding: '10px 16px', clipPath: STEP_S, ...style }}>{children}</span>
);

/** 产品浮窗（照工作台预览窗：白圆角、红黄绿灯、居中标题） */
export const Win: React.FC<XY & { w: number; h: number; title: string; children?: React.ReactNode; style?: React.CSSProperties; z?: number }> = ({ x, y, w, h, title, children, style, z = 25 }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, borderRadius: 22, overflow: 'hidden', background: '#fff', boxShadow: '0 30px 60px rgba(0,0,0,.28),0 6px 16px rgba(0,0,0,.16)', zIndex: z, ...style }}>
    <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 40, display: 'flex', alignItems: 'center', padding: '0 16px', gap: 7, font: `13px/1 ${F.zh}`, color: '#707070' }}>
      <i style={{ width: 12, height: 12, borderRadius: 6, background: '#ff5f57' }} /><i style={{ width: 12, height: 12, borderRadius: 6, background: '#febc2e' }} /><i style={{ width: 12, height: 12, borderRadius: 6, background: '#28c840' }} />
      <span style={{ flex: 1, textAlign: 'center', marginRight: 40, whiteSpace: 'nowrap' }}>{title}</span>
    </div>
    <div style={{ position: 'absolute', left: 12, top: 44, right: 12, bottom: 12, borderRadius: 12, overflow: 'hidden', background: '#fffdf6' }}>{children}</div>
  </div>
);

/** 分镜信息卡（照产品卡片：白底圆角、700 字重、关键词蓝） */
export const Card: React.FC<XY & { w: number; title: React.ReactNode; sub?: string; size?: number; style?: React.CSSProperties }> = ({ x, y, w, title, sub, size = 26, style }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, background: '#fff', borderRadius: 10, boxShadow: '0 10px 24px rgba(0,0,0,.14)', padding: `${size * 0.75}px ${size * 0.85}px`, font: `700 ${size}px/1.3 ${F.zh}`, color: '#111', ...style }}>
    {title}
    {sub ? <div style={{ marginTop: 8, font: `400 ${Math.round(size * 0.62)}px/1.35 ${F.zh}`, color: '#777' }}>{sub}</div> : null}
  </div>
);
export const Hl: React.FC<{ children: React.ReactNode }> = ({ children }) => <span style={{ color: C.b5 }}>{children}</span>;

/** 下半屏人像：样片真实背景预设「极简工作室」像素化 + 无面孔磨砂剪影 + 一行真实字幕 */
export const Portrait: React.FC<XY & { w: number; h: number; caption?: string; preset?: string; style?: React.CSSProperties; capSize?: number }> = ({ x, y, w, h, caption, preset = '02-studio', style, capSize }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, overflow: 'hidden', ...style }}>
    <PxImg src={`px/preset-${preset}.png`} style={{ left: 0, top: -(w * 16 / 9 - h) / 2, width: w, height: w * 16 / 9 }} />
    <PxImg src="px/silhouette.png" style={{ left: w * 0.06, top: h * 0.08, width: w * 0.88, height: w * 0.88 * 72 / 54 }} />
    {caption ? <div style={{ position: 'absolute', left: 0, right: 0, top: 8, textAlign: 'center', font: `900 ${capSize ?? Math.round(w / 14)}px/1.2 ${F.zh}`, color: '#fff', WebkitTextStroke: '4px #111', paintOrder: 'stroke fill' }}>{caption}</div> : null}
  </div>
);

export const Term: React.FC<XY & { w: number; lines: React.ReactNode[]; shown: number; z?: number; a?: number }> = ({ x, y, w, lines, shown, z = 45, a = 1 }) => (
  <div style={{ position: 'absolute', left: x, top: y + (1 - a) * 20, width: w, opacity: a, background: '#1f1f22', borderRadius: 14, boxShadow: '0 24px 48px rgba(0,0,0,.3)', color: '#e8e8e8', font: `15px/1.9 ${F.mono}`, paddingBottom: 14, zIndex: z }}>
    <div style={{ height: 34, display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px', color: '#9a9a9a', font: `13px/1 ${F.mono}` }}>
      <i style={{ width: 11, height: 11, borderRadius: 6, background: '#ff5f57' }} /><i style={{ width: 11, height: 11, borderRadius: 6, background: '#febc2e' }} /><i style={{ width: 11, height: 11, borderRadius: 6, background: '#28c840' }} />
      <span style={{ marginLeft: 12 }}>Terminal — 剪辑直播</span>
    </div>
    {lines.slice(0, shown).map((l, i) => <p key={i} style={{ padding: '0 18px', whiteSpace: 'nowrap', margin: 0 }}>{l}</p>)}
  </div>
);

/** 蓝色锁定角标；a = 展开进度 */
export const Locks: React.FC<XY & { w: number; h: number; a?: number; color?: string }> = ({ x, y, w, h, a = 1, color = C.hero }) => {
  const s = 30, off = 18 + (1 - a) * 30;
  const b = `6px solid ${color}`;
  const base: React.CSSProperties = { position: 'absolute', width: s, height: s, zIndex: 36, opacity: clamp(a * 2) };
  return (
    <>
      <i style={{ ...base, left: x - off, top: y - off, borderLeft: b, borderTop: b }} />
      <i style={{ ...base, left: x + w + off - s, top: y - off, borderRight: b, borderTop: b }} />
      <i style={{ ...base, left: x - off, top: y + h + off - s, borderLeft: b, borderBottom: b }} />
      <i style={{ ...base, left: x + w + off - s, top: y + h + off - s, borderRight: b, borderBottom: b }} />
    </>
  );
};

/** CUT 标签：被剪掉的字保留并划掉 */
export const Pop: React.FC<XY & { text: string; a?: number }> = ({ x, y, text, a = 1 }) => (
  <div style={{ position: 'absolute', left: x, top: y + (1 - a) * 18, opacity: clamp(a * 2), zIndex: 30, whiteSpace: 'nowrap', font: `16px/1 ${F.px}`, color: '#fff', background: C.ink, padding: '9px 12px 8px', transform: `scale(${0.9 + 0.1 * a})` }}>
    CUT<s style={{ font: `24px/1 ${F.pz}`, textDecoration: 'none', position: 'relative', marginLeft: 10, WebkitFontSmoothing: 'none' }}>{text}<i style={{ position: 'absolute', left: -3, right: -3, top: '50%', height: 4, background: C.cut }} /></s>
  </div>
);

/** 冲击星：两帧交替放大 */
export const Burst: React.FC<XY & { f: number; s?: number }> = ({ x, y, f, s = 1 }) => {
  const k = Math.floor(f / 3) % 2 ? 1.14 : 1;
  const bars = [[-72, -6, 30, 6], [54, -6, 30, 6], [-54, -42, 6, 18], [60, -42, 6, 18], [-60, 24, 18, 6], [48, 24, 18, 6]];
  return <div style={{ position: 'absolute', left: x, top: y, zIndex: 26 }}>{bars.map(([l, t, w, h], i) => <b key={i} style={{ position: 'absolute', left: l * s * k, top: t * s * k, width: w, height: h, background: '#fff', outline: `3px solid ${C.ink}` }} />)}</div>;
};

/** 尘土：落地瞬间 5 颗，2 帧后缩小消散；t = 0→1 */
export const Dust: React.FC<XY & { t: number }> = ({ x, y, t }) => {
  if (t <= 0 || t >= 1) return null;
  const s = t < 0.5 ? 1 : 0.5;
  return <>{[[0, 0, 18], [-30, 6, 12], [36, 6, 12], [-54, 12, 6], [60, 12, 6]].map(([dx, dy, w], i) => <i key={i} style={{ position: 'absolute', left: x + dx * (1 + t * 0.8), top: y + dy - t * 12, width: Math.max(6, Math.round(w * s / 6) * 6), height: Math.max(6, Math.round(w * s / 6) * 6), background: '#fff', outline: `3px solid ${C.ink}`, zIndex: 24 }} />)}</>;
};

/** 跳跃轨迹点（世界坐标，二次贝塞尔），只显示到 t */
export const Trail: React.FC<{ p0: number[]; p1: number[]; p2: number[]; t: number; n?: number; fade?: number }> = ({ p0, p1, p2, t, n = 10, fade = 1 }) => (
  <>{Array.from({ length: n }, (_, i) => (i + 1) / (n + 1)).filter((u) => u <= t).map((u, i) => {
    const x = (1 - u) ** 2 * p0[0] + 2 * (1 - u) * u * p1[0] + u * u * p2[0];
    const y = (1 - u) ** 2 * p0[1] + 2 * (1 - u) * u * p1[1] + u * u * p2[1];
    return <b key={i} style={{ position: 'absolute', left: Math.round(x / 6) * 6, top: Math.round(y / 6) * 6, width: 12, height: 12, background: '#fff', outline: `3px solid ${C.ink}`, zIndex: 25, opacity: fade }} />;
  })}</>
);

/** 像素彩纸（DOM 版，用在小场景；影院高潮用 three.js 版） */
export const Confetti: React.FC<{ f: number; start: number; n: number; box: number[]; seed: number; z?: number }> = ({ f, start, n, box, seed, z = 28 }) => {
  const t = f - start;
  if (t < 0) return null;
  const r = seeded(seed);
  const cols = [C.hero, '#ffffff', C.cut, C.gold, C.b3, '#5f6b1e'];
  return <>{Array.from({ length: n }, (_, i) => {
    const x0 = box[0] + r() * box[2], y0 = box[1] + r() * box[3] * 0.3, vx = (r() - 0.5) * 6, vy = -4 - r() * 8, w = [6, 12, 12, 18][Math.floor(r() * 4)], col = cols[Math.floor(r() * cols.length)], ol = r() < 0.5;
    const x = x0 + vx * t, y = y0 + vy * t + 0.35 * t * t;
    if (y > box[1] + box[3] + 200) return null;
    return <i key={i} style={{ position: 'absolute', left: Math.round(x / 6) * 6, top: Math.round(y / 6) * 6, width: w, height: w === 18 ? 6 : w, background: col, outline: ol ? `3px solid ${C.ink}` : 'none', zIndex: z, transform: Math.floor((t + i) / 4) % 2 ? 'rotate(45deg)' : undefined }} />;
  })}</>;
};

/** macOS 箭头光标 + 双圈点击涟漪（起点差 3f） */
export const Cursor: React.FC<XY & { press?: number; ripple?: number }> = ({ x, y, press = 0, ripple = -1 }) => (
  <>
    {[0, 3].map((d, i) => {
      const t = (ripple - d) / 22;
      if (ripple < 0 || t < 0 || t > 1) return null;
      const r = 14 + (i ? 64 : 40) * (1 - (1 - t) ** 3);
      return <i key={i} style={{ position: 'absolute', left: x - r, top: y - r, width: r * 2, height: r * 2, borderRadius: '50%', border: `3px solid ${C.hero}`, opacity: (1 - t) * (i ? 0.4 : 0.7), zIndex: 60 }} />;
    })}
    <svg width={30} height={40} viewBox="0 0 15 20" style={{ position: 'absolute', left: x - 2, top: y - 2, zIndex: 61, transform: `scale(${1 - 0.15 * press})`, transformOrigin: '2px 2px' }}>
      <path d="M1 1 L1 16 L5 12 L8 19 L10.5 18 L7.5 11 L13 11 Z" fill="#111" stroke="#fff" strokeWidth={1.4} strokeLinejoin="round" />
    </svg>
  </>
);

/** 9:16 成片画面（照产品 split 版式：上半屏信息卡、下半屏人像 + 字幕），内容全部来自样片 */
export const CutFrame: React.FC<{ w: number; h: number; title: React.ReactNode; sub?: string; caption?: string; size?: number }> = ({ w, h, title, sub, caption, size }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: w, height: h, background: '#fffdf6', overflow: 'hidden' }}>
    <Card x={w * 0.05} y={h * 0.05} w={w * 0.9} title={title} sub={sub} size={size ?? Math.round(w / 12)} style={{ padding: `${w * 0.05}px ${w * 0.055}px` }} />
    <Portrait x={0} y={h / 2} w={w} h={h / 2} caption={caption} />
  </div>
);
