import type { Mood, Track } from '../assets/catalog.js';
import type { TimedCaption } from '../captions/lines.js';

/** 背景乐人声压低参数（相对原曲的 dB） */
export const DUCK_DB = -22;
export const OPEN_DB = -14;
/** 字幕间空隙达到这么久才把背景乐抬起来 */
export const OPEN_GAP_SEC = 0.8;
/** 抬起 / 压回的过渡时长 */
export const RAMP_SEC = 0.3;
export const FADE_IN_SEC = 0.5;
export const FADE_OUT_SEC = 1.5;
/** 淡入淡出的端点音量，近似静音 */
const SILENT_DB = -60;

export interface VolumeKey { sec: number; db: number }

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const EPS = 1e-9;

/**
 * 字幕之间够长的空隙：抬起（空隙开始后 RAMP_SEC 内到顶）、压回（空隙结束前 RAMP_SEC 开始降）。
 * 空隙从“此前所有字幕的最晚结束时间”算起，嵌套、重叠的字幕不会在说话期间造出空隙。
 */
function gapKeys(captions: TimedCaption[], fadeIn: number, fadeOut: number): VolumeKey[] {
  const sorted = [...captions].sort((a, b) => a.start - b.start);
  const ends = sorted.reduce<number[]>((acc, c) => [...acc, Math.max(c.end, acc[acc.length - 1] ?? -Infinity)], []);
  return sorted.slice(1).flatMap((next, i) => {
    const from = ends[i];
    // 空隙太短，或没有完整落在淡入淡出之间，都不抬起
    if (next.start - from < OPEN_GAP_SEC - EPS || from < fadeIn || next.start > fadeOut) return [];
    return [
      { sec: from, db: DUCK_DB },
      { sec: from + RAMP_SEC, db: OPEN_DB },
      { sec: next.start - RAMP_SEC, db: OPEN_DB },
      { sec: next.start, db: DUCK_DB },
    ];
  });
}

/** 去掉时间不严格递增的点，并删除夹在两个同值点之间的冗余点 */
function tidy(keys: VolumeKey[]): VolumeKey[] {
  const increasing = keys.reduce<VolumeKey[]>((acc, k) => (acc.length === 0 || k.sec > acc[acc.length - 1].sec + EPS ? [...acc, k] : acc), []);
  return increasing.filter((k, i) => !(i > 0 && i < increasing.length - 1 && increasing[i - 1].db === k.db && increasing[i + 1].db === k.db));
}

/** 片尾里配乐的起始音量（比说话时抬高一点收束，再一路淡出），以及停留这么久后才开始淡出 */
export const OUTRO_DB = -16;
export const OUTRO_OPEN_SEC = 0.4;

/**
 * 背景乐音量包络：字幕区间视为人声，保持 DUCK_DB；字幕间空隙 ≥ OPEN_GAP_SEC 时抬到 OPEN_DB。
 * 开头淡入、结尾淡出到 SILENT_DB；没有完整落在淡入淡出之间的空隙不处理。
 * 给出 outroStartSec（品牌片尾开始）时，最后一句说完后抬到 OUTRO_DB 收束，片尾开始 OUTRO_OPEN_SEC 后一路淡出到片尾结束。
 */
export function bgmEnvelope(captions: TimedCaption[], durationSec: number, outroStartSec?: number): VolumeKey[] {
  if (durationSec <= 0) return [{ sec: 0, db: SILENT_DB }];
  // 片子比淡入淡出之和还短时，按比例缩短两端
  const total = FADE_IN_SEC + FADE_OUT_SEC;
  const scale = Math.min(1, durationSec / total);
  const fadeIn = FADE_IN_SEC * scale;
  const hasOutro = outroStartSec !== undefined && outroStartSec > fadeIn && outroStartSec < durationSec;
  const fadeOut = hasOutro ? Math.min(durationSec, outroStartSec + OUTRO_OPEN_SEC) : durationSec - FADE_OUT_SEC * scale;
  const inner = gapKeys(captions, fadeIn, fadeOut);
  const spoken = Math.min(Math.max(fadeIn, ...captions.map((c) => c.end)), (outroStartSec ?? 0) - RAMP_SEC);
  const lift = hasOutro ? [{ sec: spoken, db: DUCK_DB }, { sec: spoken + RAMP_SEC, db: OUTRO_DB }] : [];
  const keys = [
    { sec: 0, db: SILENT_DB },
    { sec: fadeIn, db: DUCK_DB },
    ...inner,
    ...lift,
    { sec: fadeOut, db: hasOutro ? OUTRO_DB : DUCK_DB },
    { sec: durationSec, db: SILENT_DB },
  ].map((k) => ({ sec: round3(k.sec), db: k.db }));
  return tidy(keys);
}

/** 某一时刻的音量（dB）：关键帧之间线性插值，越界取端点；没有关键帧时按压低音量 */
export function dbAt(keys: VolumeKey[], sec: number): number {
  if (keys.length === 0) return DUCK_DB;
  if (Number.isNaN(sec) || sec <= keys[0].sec) return keys[0].db;
  const last = keys[keys.length - 1];
  if (sec >= last.sec) return last.db;
  const i = keys.findIndex((k) => k.sec > sec);
  const a = keys[i - 1];
  const b = keys[i];
  return a.db + ((b.db - a.db) * (sec - a.sec)) / (b.sec - a.sec);
}

export { PURE_NUMBER, TIMING, sfxCues } from './sfx-plan.js';
export type { SfxCue } from './sfx-map.js';

/** FNV-1a 32 位哈希，保证同一 seed 跨进程结果一致 */
function hash(seed: string): number {
  return [...seed].reduce((h, ch) => Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0, 2166136261);
}

/** 同情绪里按 seed 的哈希稳定选曲；该情绪没有曲目时退到全部曲目 */
export function pickTrack(tracks: Track[], mood: Mood, seed: string): Track {
  const sameMood = tracks.filter((t) => t.mood === mood);
  // 按码元顺序排序（不用 localeCompare），结果不随运行环境的本地化设置变化
  const pool = [...(sameMood.length > 0 ? sameMood : tracks)].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  if (pool.length === 0) throw new Error('没有可选的配乐曲目');
  return pool[hash(seed) % pool.length];
}
