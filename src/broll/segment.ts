/** 每帧的分析结果：时间（秒）、与上一帧的亮度平均差（signalstats YDIF）、剪辑点分数（scdet score） */
export interface FrameStat { t: number; diff: number; score: number }
export interface Segment {
  /** 源片段起点（秒） */
  start: number;
  /** 源片段时长（秒） */
  sourceSec: number;
  /** 变速后的输出时长（秒） */
  outSec: number;
  /** 播放速度：0.5 为升格 */
  speed: number;
}

/** scdet 分数达到这个值视为素材内部剪辑点（ffmpeg 默认阈值） */
export const CUT_SCORE = 10;
/** 输出时长范围与默认值（秒） */
export const MIN_OUT_SEC = 2;
export const MAX_OUT_SEC = 4;
const DEFAULT_OUT_SEC = 3;
/** 输出短于这个时长视为没有可用平稳段（再短的 B-roll 一闪而过，只会显得碎） */
export const MIN_USABLE_SEC = 1.5;
/** 选不出可用段时的结果：原因写给调用方，换下一条候选 */
export interface Unusable { unusable: string }
/** 剪辑点两侧各让开的时长：转场、溶解、压缩残影常拖一两帧 */
const CUT_MARGIN_SEC = 0.2;
/** 平稳度代价里运动均值的权重：主要看帧差的波动（抖、急摇），其次才是运动量本身 */
const MEAN_WEIGHT = 0.25;

/** 解析 `metadata=mode=print` 的输出：frame 行起一帧，后续 key=value 填入该帧 */
export function parseFrameStats(text: string): FrameStat[] {
  const frames: FrameStat[] = [];
  for (const line of text.split('\n')) {
    const head = /^frame:\s*\d+\s+pts:\s*\S+\s+pts_time:\s*(\S+)/.exec(line);
    if (head) { frames.push({ t: Number(head[1]), diff: 0, score: 0 }); continue; }
    const kv = /^lavfi\.(signalstats\.YDIF|scd\.score)=(\S+)/.exec(line);
    const last = frames.at(-1);
    if (!kv || !last) continue;
    const value = Number(kv[2]);
    frames[frames.length - 1] = kv[1] === 'scd.score' ? { ...last, score: value } : { ...last, diff: value };
  }
  return frames;
}

/** 50fps 以上的素材在 30fps 时间线上放 0.5× 升格 */
export function speedFor(fps: number): number {
  return fps >= 50 ? 0.5 : 1;
}

interface Range { from: number; to: number }

/** 按剪辑点切成镜头，内部剪辑点两侧各让开 CUT_MARGIN_SEC；素材首尾不让 */
function shotRanges(stats: FrameStat[], durationSec: number): Range[] {
  const cuts = stats.filter((s) => s.score >= CUT_SCORE && s.t > 0).map((s) => s.t);
  const edges = [0, ...cuts, durationSec];
  return edges.slice(0, -1).map((from, i) => ({
    from: i === 0 ? from : from + CUT_MARGIN_SEC,
    to: i === edges.length - 2 ? edges[i + 1] : edges[i + 1] - CUT_MARGIN_SEC,
  })).filter((r) => r.to > r.from);
}

/** 窗口代价 = 帧差标准差 + 权重·帧差均值（越小越平稳） */
function windowCost(diffs: number[]): number {
  const mean = diffs.reduce((s, d) => s + d, 0) / diffs.length;
  const variance = diffs.reduce((s, d) => s + (d - mean) ** 2, 0) / diffs.length;
  return Math.sqrt(variance) + MEAN_WEIGHT * mean;
}

/** 在一个镜头里滑动窗口，返回代价最低的起点；放不下返回 null */
function bestInShot(stats: FrameStat[], shot: Range, len: number): { start: number; cost: number } | null {
  const idx = stats.map((s, i) => i).filter((i) => stats[i].t >= shot.from - 1e-6 && stats[i].t + len <= shot.to + 1e-6);
  let best: { start: number; cost: number } | null = null;
  for (const i of idx) {
    const window = stats.filter((s) => s.t >= stats[i].t && s.t < stats[i].t + len).map((s) => s.diff);
    const cost = windowCost(window);
    if (!best || cost < best.cost - 1e-9) best = { start: stats[i].t, cost };
  }
  return best;
}

/**
 * 选段：避开素材内部剪辑点，在放得下的镜头里选运动最平稳的一段；
 * 输出时长取 wantSec（夹在 2–4 秒，默认 3），60fps 素材源片段取一半（升格后时长不变）。
 * 没有镜头放得下时退而取最长的镜头（不超过所需长度），输出相应变短；
 * 最长镜头的输出也不足 MIN_USABLE_SEC（或让开剪辑点后一个镜头都不剩）时返回 unusable，绝不把剪辑点放回输出。
 */
export function pickSegment(stats: FrameStat[], opts: { fps: number; durationSec: number; wantSec?: number }): Segment | Unusable {
  const speed = speedFor(opts.fps);
  const outSec = Math.min(MAX_OUT_SEC, Math.max(MIN_OUT_SEC, opts.wantSec ?? DEFAULT_OUT_SEC));
  const len = outSec * speed;
  const shots = shotRanges(stats, opts.durationSec);
  const picks = shots.map((s) => bestInShot(stats, s, len)).filter((p): p is { start: number; cost: number } => p !== null);
  if (picks.length > 0) {
    const best = picks.reduce((a, b) => (b.cost < a.cost - 1e-9 ? b : a));
    return { start: best.start, sourceSec: len, outSec, speed };
  }
  const tooChoppy: Unusable = { unusable: `素材剪辑点过密，找不到 ≥${MIN_USABLE_SEC} 秒的连续镜头` };
  if (shots.length === 0) return tooChoppy;
  const longest = shots.reduce((a, b) => (b.to - b.from > a.to - a.from ? b : a));
  const sourceSec = Math.min(len, longest.to - longest.from);
  if (sourceSec / speed < MIN_USABLE_SEC - 1e-6) return tooChoppy;
  return { start: longest.from, sourceSec, outSec: sourceSec / speed, speed };
}
