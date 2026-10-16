// 合成影视感音效：whoosh、hit、riser、pop、tick、logo 及其变体、toggle/click/confirm 变体 → assets/sfx/*.wav
// 用法：node scripts/make-sfx.mjs [输出目录]
//
// 全部用代码合成（滤波噪声、正弦、包络），没有任何第三方采样，不涉及来源许可；固定随机种子，重跑结果逐字节一致。
// 32 kHz / 16 bit / 单声道，峰值归一到 -3 dBFS，整套体积远小于 1 MB。
//   whoosh  带通噪声，中心频率由低扫到高，升余弦包络，峰值在 anchor 处（画面切入的瞬间）
//   hit     低频正弦（音高快速下落）+ 低通噪声瞬态 + 软削波，瞬态在 0 秒
//   riser   滤波噪声 + 上扫正弦，响度一路抬高，在片尾（anchor）戛然而止，接 hit
//   pop     短促的气泡音（音高上扬、快衰减），轻
//   tick    木鱼般的短 click，数字滚动用
//   logo    两音上行的钟琶音 + 低频托底 + 简易混响，片尾用
// anchor：音效里「与画面动作对齐」的时刻（秒）；sync 说明它是什么：peak 响度峰值、onset 起音、end 响度结束处（riser 的高潮）。渲染时 cue.sec = 动作时刻 − anchor；tests/sfx-assets.test.ts 会读 wav 实测核对。
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SAMPLE_RATE = 32000;
const PEAK = 0.708; // -3 dBFS
const TAU = Math.PI * 2;

/** mulberry32：固定种子的伪随机数 */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const samples = (sec) => Math.round(sec * SAMPLE_RATE);
const zeros = (sec) => new Float64Array(samples(sec));
const white = (n, r) => Float64Array.from({ length: n }, () => r() * 2 - 1);
const lerp = (a, b, t) => a + (b - a) * t;
const expSweep = (f0, f1, t) => f0 * (f1 / f0) ** t;
/** 升余弦包络：0 → 1（峰值在 peak 秒）→ 0（总长 sec 秒） */
function bell(t, peak, sec) {
  if (t <= 0 || t >= sec) return 0;
  return t < peak ? Math.sin((Math.PI / 2) * (t / peak)) ** 2 : Math.cos((Math.PI / 2) * ((t - peak) / (sec - peak))) ** 2;
}

/** RBJ 双二阶滤波，系数逐样本重算（中心频率可随时间变化）；type：bp / lp / hp */
function biquad(input, type, freqAt, q) {
  const out = new Float64Array(input.length);
  let x1 = 0; let x2 = 0; let y1 = 0; let y2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const f = Math.min(freqAt(i / SAMPLE_RATE), SAMPLE_RATE * 0.45);
    const w = (TAU * f) / SAMPLE_RATE;
    const alpha = Math.sin(w) / (2 * q);
    const cw = Math.cos(w);
    let b0; let b1; let b2;
    if (type === 'bp') { b0 = alpha; b1 = 0; b2 = -alpha; } else if (type === 'lp') { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; } else { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
    const a0 = 1 + alpha; const a1 = -2 * cw; const a2 = 1 - alpha;
    const y = (b0 * input[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = input[i]; y2 = y1; y1 = y; out[i] = y;
  }
  return out;
}

const mix = (...layers) => {
  const n = Math.max(...layers.map((l) => l.length));
  return Float64Array.from({ length: n }, (_, i) => layers.reduce((s, l) => s + (l[i] ?? 0), 0));
};
const scale = (a, k) => a.map((v) => v * k);
const shift = (a, sec) => { const out = new Float64Array(a.length); const d = samples(sec); for (let i = d; i < a.length; i += 1) out[i] = a[i - d]; return out; };
/** 首尾各淡 ms 毫秒，防止爆音 */
function declick(a, headMs, tailMs) {
  const h = samples(headMs / 1000); const t = samples(tailMs / 1000);
  return a.map((v, i) => v * Math.min(1, h > 0 ? i / h : 1, t > 0 ? (a.length - 1 - i) / t : 1));
}
/** 按时间生成：fn(t) 返回该时刻的样本值 */
const synth = (sec, fn) => Float64Array.from({ length: samples(sec) }, (_, i) => fn(i / SAMPLE_RATE, i));

// ---------- 各类音效 ----------

function whoosh({ sec, peak, f0, f1, q, seed }) {
  const r = rng(seed);
  const body = biquad(white(samples(sec), r), 'bp', (t) => expSweep(f0, f1, t / sec), q);
  const air = biquad(white(samples(sec), r), 'hp', () => 3500, 0.7);
  const raw = mix(body, scale(air, 0.25));
  return declick(raw.map((v, i) => v * bell(i / SAMPLE_RATE, peak, sec)), 4, 10);
}

function hit({ sec, f0, f1, tauF, tauA, noiseTau, seed, drive }) {
  const r = rng(seed);
  let phase = 0;
  const body = synth(sec, (t) => {
    phase += (TAU * (f1 + (f0 - f1) * Math.exp(-t / tauF))) / SAMPLE_RATE;
    return Math.sin(phase) * Math.exp(-t / tauA);
  });
  const burst = biquad(white(samples(sec), r), 'lp', (t) => 400 + 5000 * Math.exp(-t / 0.02), 0.8).map((v, i) => v * Math.exp(-i / SAMPLE_RATE / noiseTau));
  const soft = mix(body, scale(burst, 0.7)).map((v) => Math.tanh(v * drive));
  return declick(soft, 0, 30);
}

function riser({ sec, f0, f1, tone0, tone1, seed }) {
  const r = rng(seed);
  const noiseBand = biquad(white(samples(sec), r), 'bp', (t) => expSweep(f0, f1, t / sec), 1.4);
  let phase = 0;
  const tone = synth(sec, (t) => {
    phase += (TAU * expSweep(tone0, tone1, t / sec)) / SAMPLE_RATE;
    return Math.sin(phase);
  });
  const env = (t) => (t / sec) ** 2.2;
  const raw = mix(noiseBand, scale(tone, 0.3)).map((v, i) => v * env(i / SAMPLE_RATE));
  return declick(raw, 12, 6);
}

function pop({ sec, f0, rise, tauA }) {
  let phase = 0;
  return declick(synth(sec, (t) => {
    phase += (TAU * f0 * (1 + rise * (1 - Math.exp(-t / 0.018)))) / SAMPLE_RATE;
    return Math.sin(phase) * Math.exp(-t / tauA);
  }), 1, 20);
}

function tick({ sec, f, seed }) {
  const r = rng(seed);
  const click = biquad(white(samples(sec), r), 'bp', () => f * 1.6, 2).map((v, i) => v * Math.exp(-i / SAMPLE_RATE / 0.004));
  const ring = synth(sec, (t) => Math.sin(TAU * f * t) * Math.exp(-t / 0.014));
  return declick(mix(scale(click, 0.9), scale(ring, 0.8)), 0, 8);
}

/** 双音「叮」：基频 + 非整数泛音，指数衰减；两音之间错开 gap 秒 */
function chime({ sec, notes, gap, tau }) {
  const voices = notes.map((f, k) => shift(synth(sec, (t) => {
    const partials = Math.sin(TAU * f * t) + 0.45 * Math.sin(TAU * f * 2.76 * t) * Math.exp(-t / (tau * 0.4)) + 0.2 * Math.sin(TAU * f * 5.4 * t) * Math.exp(-t / (tau * 0.15));
    return partials * Math.exp(-t / tau) * Math.min(1, t / 0.003);
  }), k * gap));
  return declick(mix(...voices), 0, 30);
}

/** Schroeder 简易混响：4 路梳状 + 2 级全通，wet 为湿声比例 */
function reverb(input, wet, extraSec) {
  const n = input.length + samples(extraSec);
  const x = Float64Array.from({ length: n }, (_, i) => input[i] ?? 0);
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => {
    const len = samples(d); const buf = new Float64Array(n);
    for (let i = 0; i < n; i += 1) buf[i] = x[i] + 0.78 * (i >= len ? buf[i - len] : 0);
    return buf;
  });
  let y = scale(mix(...combs), 0.25);
  for (const d of [0.005, 0.0017]) {
    const len = samples(d); const out = new Float64Array(n);
    for (let i = 0; i < n; i += 1) out[i] = -0.7 * y[i] + (i >= len ? y[i - len] + 0.7 * out[i - len] : 0);
    y = out;
  }
  return mix(scale(x, 1 - wet), scale(y, wet * 1.6));
}

function logo({ sec, notes, gap, tau, subHz }) {
  const bells = chime({ sec, notes, gap, tau });
  const sub = synth(sec, (t) => Math.sin(TAU * subHz * t) * bell(t, 0.25, 1.1) * 0.5);
  return declick(reverb(mix(bells, sub), 0.28, 0.4).slice(0, samples(sec)), 0, 120);
}

// ---------- 清单 ----------

/** 每条：文件名（不含 .wav）、合成函数、锚点（秒）。变体只换音高、时长、随机种子 */
export const SPECS = [
  { name: 'whoosh', sync: 'peak', anchor: 0.35, make: () => whoosh({ sec: 0.9, peak: 0.38, f0: 350, f1: 3200, q: 1.1, seed: 11 }) },
  { name: 'whoosh_2', sync: 'peak', anchor: 0.31, make: () => whoosh({ sec: 0.7, peak: 0.3, f0: 260, f1: 2400, q: 0.9, seed: 12 }) },
  { name: 'whoosh_3', sync: 'peak', anchor: 0.52, make: () => whoosh({ sec: 1.0, peak: 0.46, f0: 500, f1: 4200, q: 1.3, seed: 13 }) },
  { name: 'hit', sync: 'onset', anchor: 0, make: () => hit({ sec: 0.7, f0: 150, f1: 48, tauF: 0.05, tauA: 0.22, noiseTau: 0.035, seed: 21, drive: 1.8 }) },
  { name: 'hit_2', sync: 'onset', anchor: 0, make: () => hit({ sec: 0.55, f0: 190, f1: 62, tauF: 0.04, tauA: 0.16, noiseTau: 0.03, seed: 22, drive: 1.6 }) },
  { name: 'hit_3', sync: 'onset', anchor: 0, make: () => hit({ sec: 0.9, f0: 120, f1: 40, tauF: 0.07, tauA: 0.3, noiseTau: 0.045, seed: 23, drive: 2 }) },
  { name: 'riser', sync: 'end', anchor: 1.2, make: () => riser({ sec: 1.2, f0: 300, f1: 6500, tone0: 180, tone1: 1300, seed: 31 }) },
  { name: 'riser_short', sync: 'end', anchor: 0.4, make: () => riser({ sec: 0.4, f0: 900, f1: 7000, tone0: 420, tone1: 1700, seed: 32 }) },
  { name: 'pop', sync: 'onset', anchor: 0, make: () => pop({ sec: 0.18, f0: 420, rise: 1.1, tauA: 0.045 }) },
  { name: 'pop_2', sync: 'onset', anchor: 0, make: () => pop({ sec: 0.18, f0: 500, rise: 1.0, tauA: 0.04 }) },
  { name: 'pop_3', sync: 'onset', anchor: 0, make: () => pop({ sec: 0.18, f0: 360, rise: 1.2, tauA: 0.05 }) },
  { name: 'pop_4', sync: 'onset', anchor: 0, make: () => pop({ sec: 0.18, f0: 460, rise: 0.8, tauA: 0.042 }) },
  { name: 'tick_2', sync: 'onset', anchor: 0, make: () => tick({ sec: 0.06, f: 2300, seed: 42 }) },
  { name: 'tick_3', sync: 'onset', anchor: 0, make: () => tick({ sec: 0.06, f: 1600, seed: 43 }) },
  { name: 'click_2', sync: 'onset', anchor: 0, make: () => tick({ sec: 0.06, f: 1300, seed: 44 }) },
  { name: 'toggle_2', sync: 'onset', anchor: 0, make: () => tick({ sec: 0.08, f: 900, seed: 45 }) },
  { name: 'confirm_2', sync: 'onset', anchor: 0, make: () => chime({ sec: 0.4, notes: [1046, 1568], gap: 0.07, tau: 0.09 }) },
  { name: 'confirm_3', sync: 'onset', anchor: 0, make: () => chime({ sec: 0.4, notes: [1175, 1760], gap: 0.07, tau: 0.09 }) },
  { name: 'logo', sync: 'onset', anchor: 0, make: () => logo({ sec: 1.8, notes: [659.25, 987.77, 1318.5], gap: 0.13, tau: 0.55, subHz: 110 }) },
];

/** 峰值归一到 -3 dBFS，量化为 16 bit，封装成 WAV */
export function toWav(data) {
  const peak = data.reduce((m, v) => Math.max(m, Math.abs(v)), 1e-9);
  const pcm = Buffer.alloc(data.length * 2);
  data.forEach((v, i) => pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, (v / peak) * PEAK)) * 32767), i * 2));
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVEfmt ', 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24); header.writeUInt32LE(SAMPLE_RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const dir = process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'assets', 'sfx');
  mkdirSync(dir, { recursive: true });
  for (const spec of SPECS) writeFileSync(join(dir, `${spec.name}.wav`), toWav(spec.make()));
  console.log(`已生成 ${SPECS.length} 个音效到 ${dir}`);
}
