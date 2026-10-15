import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';
import { probe } from '../media/probe.js';
import { CAPTION_STYLES, CAPTION_MAX_WIDTH } from '../captions/styles.js';
import { CANVAS } from '../storyboard/schema.js';
import { contrastRatio } from './contrast.js';

export interface HardCheck {
  id: 'resolution' | 'fps' | 'loudness' | 'truePeak' | 'blackFrames' | 'safeArea' | 'contrast';
  ok: boolean;
  detail: string;
}

export interface CaptionLayout {
  captionCenters: number[];
  /** 字幕容器最大宽度，缺省取 CAPTION_MAX_WIDTH（与 CaptionLayer 的 left/right 留白共用同一常量） */
  captionMaxWidth?: number;
}

export const TARGET_LUFS = -14;
export const LUFS_TOLERANCE = 1;
export const MAX_TRUE_PEAK_DBTP = -1.0;
export const MIN_CONTRAST = 4.5;
/** 平台安全区：字幕不进顶部 0–160、底部 1600–1920；右侧 960–1080 点赞栏只在 y 1000–1650 一段，
 *  但分屏字幕（中心 960，半高 75 → 到 1035）与之相邻，故所有布局统一要求居中右缘 ≤ 960 */
export const SAFE_AREA = { top: 160, bottom: 1600, right: 960 } as const;
/** 字幕最多两行，行高 1.25（与 CaptionText 一致），用最大字号估算半高 */
const CAPTION_LINES = 2;
const CAPTION_LINE_HEIGHT = 1.25;
const BLACK_TAIL_SEC = 0.5;

export interface Palette { fg: string; bg: string; label: string }

const fmt = (n: number): string => (Number.isFinite(n) ? n.toFixed(1) : n < 0 ? '-inf' : 'inf');

/** 解析 ebur128 Summary：积分响度 I 与真峰值 Peak；静音时为 -inf */
export function parseEbur128(stderr: string): { lufs: number; peak: number } {
  const num = (raw: string): number => (raw === '-inf' ? -Infinity : Number(raw));
  const summary = stderr.slice(stderr.lastIndexOf('Summary:'));
  const lufs = /Integrated loudness:\s*\n\s*I:\s*(-?inf|-?[\d.]+)\s*LUFS/.exec(summary)?.[1];
  const peak = /True peak:\s*\n\s*Peak:\s*(-?inf|-?[\d.]+)\s*dBFS/.exec(summary)?.[1];
  if (lufs === undefined || peak === undefined) throw new Error('响度测量失败：ffmpeg 输出中没有 ebur128 的 Summary');
  return { lufs: num(lufs), peak: num(peak) };
}

/** 解析 blackdetect 输出的黑段 [start, end] 秒 */
export function parseBlackSegments(stderr: string): { start: number; end: number }[] {
  return [...stderr.matchAll(/black_start:([\d.]+)\s+black_end:([\d.]+)/g)].map((m) => ({ start: Number(m[1]), end: Number(m[2]) }));
}

function checkSize(width: number, height: number): HardCheck {
  const ok = width === CANVAS.width && height === CANVAS.height;
  return { id: 'resolution', ok, detail: `${width}×${height}（要求 ${CANVAS.width}×${CANVAS.height}）` };
}

function checkFps(fps: number): HardCheck {
  return { id: 'fps', ok: Math.abs(fps - CANVAS.fps) < 0.01, detail: `${fps} fps（要求 ${CANVAS.fps}）` };
}

async function measureLoudness(video: string, cfg: AppConfig): Promise<HardCheck[]> {
  try {
    const { stderr } = await run(cfg.ffmpeg, ['-hide_banner', '-nostats', '-i', video, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
    const { lufs, peak } = parseEbur128(stderr);
    return [
      { id: 'loudness', ok: Math.abs(lufs - TARGET_LUFS) <= LUFS_TOLERANCE, detail: `积分响度 ${fmt(lufs)} LUFS（要求 ${TARGET_LUFS} ± ${LUFS_TOLERANCE}）` },
      { id: 'truePeak', ok: peak <= MAX_TRUE_PEAK_DBTP, detail: `真峰值 ${fmt(peak)} dBTP（要求 ≤ ${MAX_TRUE_PEAK_DBTP}）` },
    ];
  } catch (err) {
    const detail = `响度测量失败：${(err as Error).message.split('\n')[0]}`;
    return [{ id: 'loudness', ok: false, detail }, { id: 'truePeak', ok: false, detail }];
  }
}

export async function checkBlack(video: string, durationSec: number, cfg: AppConfig): Promise<HardCheck> {
  let stderr: string;
  try {
    ({ stderr } = await run(cfg.ffmpeg, ['-hide_banner', '-nostats', '-i', video, '-an', '-vf', 'blackdetect=d=0.5:pix_th=0.10', '-f', 'null', '-']));
  } catch (err) {
    return { id: 'blackFrames', ok: false, detail: `黑帧检测失败：${(err as Error).message.split('\n')[0]}` };
  }
  const bad = parseBlackSegments(stderr).filter((s) => s.start < durationSec - BLACK_TAIL_SEC);
  const detail = bad.length === 0 ? '无黑帧段（片尾 0.5 秒内除外）' : `黑帧段：${bad.map((s) => `${s.start}s–${s.end}s`).join('、')}`;
  return { id: 'blackFrames', ok: bad.length === 0, detail };
}

/** 静态几何检查：字幕竖向不进顶/底安全区，横向居中时右缘不进点赞栏。
 *  描边向外多出约 5px（stroke 宽 8–10 的一半），相对 120px 的留白可忽略，不计入宽度 */
export function checkSafeArea(layout: CaptionLayout): HardCheck {
  const width = layout.captionMaxWidth ?? CAPTION_MAX_WIDTH;
  const maxSize = Math.max(...Object.values(CAPTION_STYLES).map((s) => s.size));
  const half = (maxSize * CAPTION_LINE_HEIGHT * CAPTION_LINES) / 2;
  const problems: string[] = [];
  for (const y of layout.captionCenters) {
    if (y - half < SAFE_AREA.top || y + half > SAFE_AREA.bottom) {
      problems.push(`字幕中心 y=${y}，上下缘 ${y - half}–${y + half} 越出安全区 ${SAFE_AREA.top}–${SAFE_AREA.bottom}`);
    }
  }
  const right = (CANVAS.width + width) / 2;
  if (right > SAFE_AREA.right) problems.push(`字幕最大宽度 ${width}，居中右缘 x=${right} > ${SAFE_AREA.right}（宽度须 ≤ ${2 * SAFE_AREA.right - CANVAS.width}）`);
  const detail = problems.length ? problems.join('；') : `字幕中心 ${layout.captionCenters.join('/')}（半高 ${half}），最大宽度 ${width}，右缘 x=${right} ≤ ${SAFE_AREA.right}`;
  return { id: 'safeArea', ok: problems.length === 0, detail };
}

export function checkContrast(palette: Palette[]): HardCheck {
  const low = palette.map((p) => ({ label: p.label, ratio: contrastRatio(p.fg, p.bg) })).filter((p) => p.ratio < MIN_CONTRAST);
  const detail = low.length === 0 ? `${palette.length} 组配色对比度均 ≥ ${MIN_CONTRAST}` : `低于 ${MIN_CONTRAST}：${low.map((p) => `${p.label} ${p.ratio.toFixed(2)}`).join('；')}`;
  return { id: 'contrast', ok: low.length === 0, detail };
}

export async function hardChecks(video: string, layout: CaptionLayout, palette: Palette[], cfg: AppConfig): Promise<HardCheck[]> {
  const info = await probe(video, cfg);
  const loudness: HardCheck[] = info.hasAudio
    ? await measureLoudness(video, cfg)
    : (['loudness', 'truePeak'] as const).map((id) => ({ id, ok: false, detail: '成片没有音轨' }));
  return [
    checkSize(info.width, info.height),
    checkFps(info.fps),
    ...loudness,
    await checkBlack(video, info.durationSec, cfg),
    checkSafeArea(layout),
    checkContrast(palette),
  ];
}
