import type { TimedCaption } from '../captions/lines.js';
import { CANVAS, MIN_SHOT_SEC, type Shot } from '../storyboard/schema.js';

/** 片尾文字缺省值（默认同时放产品 logo） */
export const OUTRO_DEFAULT_TEXT = '用明知AI剪辑制作';
/** 用户可配置的片尾：关闭，或改文字（文字为空时只放 logo） */
export interface OutroOptions { enabled: boolean; text: string }
export const DEFAULT_OUTRO: OutroOptions = { enabled: true, text: OUTRO_DEFAULT_TEXT };
/** 片尾文字最长字数（一行放得下） */
export const OUTRO_TEXT_MAX = 24;

/** 传给渲染的片尾字段：startSec 起整片剩余部分都是片尾；logo 是相对工作目录的图片 */
export interface OutroProps { startSec: number; text: string; logo: string }

/** 最后一句字幕结束后至少留这么久，让话落地再接片尾 */
export const HOLD_SEC = 0.6;
/** 品牌片尾时长（2–3 秒） */
export const OUTRO_SEC = 2.5;
/** 片尾里 logo 弹出的时刻（相对片尾开始）；logo 音对准它 */
export const OUTRO_LOGO_SEC = 0.15;
/** CTA 卡起点距整片结尾的范围（秒）与单张时长范围 */
export const CTA_FROM_END = { min: 5, max: 8 } as const;
export const CTA_SEC = { min: 2, pref: 2.5, max: 3 } as const;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const snapFrame = (sec: number): number => round3(Math.round(sec * CANVAS.fps) / CANVAS.fps);
const ceilFrame = (sec: number): number => round3(Math.ceil(sec * CANVAS.fps - 1e-6) / CANVAS.fps);
const floorFrame = (sec: number): number => round3(Math.floor(sec * CANVAS.fps + 1e-6) / CANVAS.fps);

/** 合并用户设置与缺省：没设置按缺省，文字去首尾空白 */
export function resolveOutro(options: Partial<OutroOptions> | undefined): OutroOptions {
  return { enabled: options?.enabled ?? DEFAULT_OUTRO.enabled, text: (options?.text ?? DEFAULT_OUTRO.text).trim() };
}

export interface EndingPlan {
  /** 渲染用镜头：CTA 已提前，覆盖 [0, 内容结尾]，之后的留白与片尾不属于任何镜头 */
  shots: Shot[];
  /** 整片时长（秒）= 留白结束（片尾开始）+ 片尾时长；没有片尾时等于留白结束 */
  durationSec: number;
  /** 留白结束的时刻：有片尾时是片尾开始；人像在内容结尾到这里定格 */
  outroStartSec: number;
  hasOutro: boolean;
}

const lastCaption = (captions: TimedCaption[]): TimedCaption | undefined => captions.reduce<TimedCaption | undefined>((best, c) => (!best || c.end > best.end ? c : best), undefined);
const isPlain = (s: Shot): boolean => !s.card && !s.broll && s.layout === 'full';

function mergePlain(shots: Shot[]): Shot[] {
  return shots.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    return last && isPlain(last) && isPlain(s) ? [...acc.slice(0, -1), { ...last, end: s.end }] : [...acc, s];
  }, []);
}

/** 镜头不超出口播内容：起点不早于内容结尾的镜头去掉，末镜头截到内容结尾（人像视频比方案略短时） */
const trimTo = (shots: Shot[], contentSec: number): Shot[] => shots.filter((s) => s.start < contentSec - 1e-9).map((s) => (s.end > contentSec ? { ...s, end: contentSec } : s));

/** CTA 起点：窗口 [lo, hi] 内尽量贴近 pref；离某个镜头边界不足 MIN_SHOT_SEC 时吸附到边界，免得留下碎镜头 */
function ctaStart(body: Shot[], pref: number, lo: number, hi: number): number {
  const bounds = body.flatMap((s) => [s.start, s.end]).filter((t) => t >= lo - 1e-9 && t <= hi + 1e-9 && Math.abs(t - pref) < MIN_SHOT_SEC);
  const near = bounds.reduce<number | undefined>((best, t) => (best === undefined || Math.abs(t - pref) < Math.abs(best - pref) ? t : best), undefined);
  return near ?? Math.min(hi, Math.max(lo, pref));
}

/**
 * 把末尾的 CTA 移到整片倒数第 CTA_FROM_END 秒范围内，并在最后一句字幕开始前结束（CTA 与最后一句不同时出现），
 * 之后的最后一句回到人物全屏。最后一句太长、窗口放不下时，CTA 退到最后一句之前（宁可偏离窗口，也不与最后一句同时出现）。
 * 不是末尾 CTA、没有字幕、会吃掉钩子卡或放不下 CTA_SEC.min 时原样返回。不改入参
 */
function relocateCta(shots: Shot[], captions: TimedCaption[], totalSec: number): Shot[] {
  const last = shots[shots.length - 1];
  const final = lastCaption(captions);
  if (!last || last.card?.template !== 'cta' || !final) return shots;
  const body = shots.slice(0, -1);
  const latest = final.start - CTA_SEC.min;
  const lo = totalSec - CTA_FROM_END.max;
  const hi = Math.min(totalSec - CTA_FROM_END.min, latest);
  const pref = final.start - CTA_SEC.pref;
  const start = snapFrame(lo <= hi ? ctaStart(body, pref, lo, hi) : Math.max(0, pref));
  const end = Math.min(floorFrame(final.start), snapFrame(start + CTA_SEC.max));
  if (start < 0 || end - start < CTA_SEC.min - 1 / CANVAS.fps) return shots;
  if (body.some((s) => s.card?.template === 'hook' && s.end > start)) return shots;
  const kept = body.flatMap((s): Shot[] => (s.end <= start ? [s] : s.start < start ? [{ ...s, end: start }] : []));
  const tail: Shot[] = [{ ...last, start, end }, { start: end, end: last.end, layout: 'full' }];
  const gap = start - (kept[kept.length - 1]?.end ?? 0);
  const before: Shot[] = gap > 1e-9 ? [...kept, { start: start - gap, end: start, layout: 'full' }] : kept;
  return mergePlain([...before, ...tail]);
}

/**
 * 结尾规划：最后一句字幕后留 ≥ HOLD_SEC（人像定格），再接 OUTRO_SEC 的品牌片尾；CTA 提前到倒数第 5–8 秒。
 * contentSec 是口播内容（人像视频）的时长；返回的镜头只覆盖内容部分。不改入参
 */
export function planEnding(shots: Shot[], captions: TimedCaption[], contentSec: number, outro: boolean): EndingPlan {
  const content = trimTo(shots, contentSec);
  const spoken = lastCaption(captions)?.end ?? 0;
  const outroStartSec = Math.max(snapFrame(contentSec), ceilFrame(spoken > 0 ? spoken + HOLD_SEC : 0));
  const durationSec = outro ? round3(outroStartSec + Math.round(OUTRO_SEC * CANVAS.fps) / CANVAS.fps) : outroStartSec;
  return { shots: relocateCta(content, captions, durationSec), durationSec, outroStartSec, hasOutro: outro };
}

/** 渲染用的片尾字段；没有片尾返回 undefined */
export function outroProps(plan: EndingPlan, options: OutroOptions, logoFile: string): OutroProps | undefined {
  return plan.hasOutro ? { startSec: plan.outroStartSec, text: options.text, logo: logoFile } : undefined;
}
