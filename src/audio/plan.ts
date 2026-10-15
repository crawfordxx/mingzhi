import type { Mood, SfxId, Track } from '../assets/catalog.js';
import type { TimedCaption } from '../captions/lines.js';
import type { CardSpec, Shot } from '../storyboard/schema.js';

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

/**
 * 背景乐音量包络：字幕区间视为人声，保持 DUCK_DB；字幕间空隙 ≥ OPEN_GAP_SEC 时抬到 OPEN_DB。
 * 开头淡入、结尾淡出到 SILENT_DB；没有完整落在淡入淡出之间的空隙不处理。
 */
export function bgmEnvelope(captions: TimedCaption[], durationSec: number): VolumeKey[] {
  if (durationSec <= 0) return [{ sec: 0, db: SILENT_DB }];
  // 片子比淡入淡出之和还短时，按比例缩短两端
  const total = FADE_IN_SEC + FADE_OUT_SEC;
  const scale = Math.min(1, durationSec / total);
  const fadeIn = FADE_IN_SEC * scale;
  const fadeOut = durationSec - FADE_OUT_SEC * scale;
  const inner = gapKeys(captions, fadeIn, fadeOut);
  const keys = [
    { sec: 0, db: SILENT_DB },
    { sec: fadeIn, db: DUCK_DB },
    ...inner,
    { sec: fadeOut, db: DUCK_DB },
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

export interface SfxCue { sec: number; sfx: SfxId; volume: number }

const DEFAULT_VOLUME = 0.35;
const TICK_VOLUME = 0.15;
/** 同一时刻（±该秒数内）只保留一个音效 */
const DEDUP_SEC = 0.05;

/*
 * 以下节奏与渲染模板保持一致（模板在 .tsx 里依赖 React，这里不引入，复制最小常量；
 * tests/audio-plan.test.ts 与模板源头对拍，改动模板时测试会报警）：
 * - 卡片出场时长：render/templates/parts.tsx 的 EXIT_SEC（对拍 TIMING.exitSec）
 * - 开关点击：render/templates/Toggles.tsx 的 clickTimes（按函数结果对拍）
 * - CTA 点击：render/templates/Cta.tsx 的 ctaClickTimes（按函数结果对拍）
 * - 标签弹入：render/templates/Chips.tsx 的 FIRST_POP + 序号 * STAGGER（对拍 TIMING.chips*）
 * - 数字滚动：render/templates/BigNumber.tsx 的 PURE_NUMBER 与 COUNT_START/COUNT_SEC（tick 落在窗内）
 */
const EXIT_SEC = 0.25;
const TOGGLE_FIRST = 0.6;
const TOGGLE_GAP = 0.5;
const TOGGLE_SWITCH_SEC = 0.3;
const TOGGLE_DONE_BEFORE_EXIT = 0.3;
const CTA_FIRST = 0.5;
const CTA_GAP = 0.5;
const CTA_PRESS_SEC = 0.24;
const CTA_DONE_BEFORE_END = 0.2;
const CHIPS_FIRST = 0.15;
const CHIPS_STAGGER = 0.12;
const TICK_COUNT = 7;
const TICK_GAP = 0.1;
export const PURE_NUMBER = /^(\d{1,3}(,\d{3})+|\d+)(\.\d+)?$/;
/** 供测试与模板源头对拍的常量 */
export const TIMING = { exitSec: EXIT_SEC, chipsFirst: CHIPS_FIRST, chipsStagger: CHIPS_STAGGER } as const;

function toggleTimes(k: number, dur: number): number[] {
  const room = dur - EXIT_SEC - TOGGLE_DONE_BEFORE_EXIT - TOGGLE_SWITCH_SEC - TOGGLE_FIRST;
  const gap = k > 1 ? Math.max(0, Math.min(TOGGLE_GAP, room / (k - 1))) : 0;
  return Array.from({ length: k }, (_, j) => TOGGLE_FIRST + j * gap);
}

function ctaTimes(n: number, dur: number): number[] {
  const room = Math.max(0, dur - CTA_DONE_BEFORE_END - CTA_PRESS_SEC);
  const first = Math.min(CTA_FIRST, room);
  const gap = n > 1 ? Math.min(CTA_GAP, (room - first) / (n - 1)) : 0;
  return Array.from({ length: n }, (_, i) => first + i * gap);
}

const cue = (sec: number, sfx: SfxId, volume = DEFAULT_VOLUME): SfxCue => ({ sec, sfx, volume });

/** 卡片内部动作对应的音效（相对镜头开始的秒数） */
function innerCues(card: CardSpec, dur: number): SfxCue[] {
  switch (card.template) {
    case 'toggles': {
      const onCount = card.props.rows.filter((r) => r.on).length;
      return toggleTimes(onCount, dur).map((t) => cue(t, 'toggle'));
    }
    case 'cta':
      return ctaTimes(card.props.actions.length, dur).map((t) => cue(t, 'click'));
    case 'bigNumber':
      if (!PURE_NUMBER.test(card.props.value)) return [];
      return Array.from({ length: TICK_COUNT }, (_, i) => cue((i + 1) * TICK_GAP, 'tick', TICK_VOLUME));
    case 'chips': {
      const marks = card.props.groups.flatMap((g) => g.items.map((it) => it.mark));
      return marks.flatMap((m, i) => (m === 'yes' ? [cue(CHIPS_FIRST + i * CHIPS_STAGGER, 'confirm')] : []));
    }
    default:
      return [];
  }
}

/** 镜头开始处的音效：分屏卡片入场 enter；browser 用 load 代替；全屏镜头（cta）不入场 */
function startCue(shot: Shot & { card: CardSpec }): SfxCue[] {
  if (shot.card.template === 'browser') return [cue(0, 'load')];
  return shot.layout === 'split' ? [cue(0, 'enter')] : [];
}

/** 按时间排序，±DEDUP_SEC 内只保留更响的一个，音量相同保留更早的 */
function dedupe(cues: SfxCue[]): SfxCue[] {
  const sorted = [...cues].sort((a, b) => a.sec - b.sec);
  return sorted.reduce<SfxCue[]>((acc, c) => {
    const last = acc[acc.length - 1];
    if (!last || c.sec - last.sec > DEDUP_SEC + EPS) return [...acc, c];
    return c.volume > last.volume ? [...acc.slice(0, -1), c] : acc;
  }, []);
}

/** 所有带卡片镜头的音效触发点（秒，相对整片）；晚于镜头结束的点丢弃 */
export function sfxCues(shots: Shot[]): SfxCue[] {
  const all = shots.flatMap((shot) => {
    if (!shot.card) return [];
    const withCard = { ...shot, card: shot.card };
    const dur = shot.end - shot.start;
    return [...startCue(withCard), ...innerCues(shot.card, dur)]
      .filter((c) => c.sec < dur)
      .map((c) => ({ ...c, sec: round3(shot.start + c.sec) }));
  });
  return dedupe(all);
}

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
