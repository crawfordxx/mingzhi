import type { TimedCaption } from '../captions/lines.js';
import { CANVAS, MIN_SHOT_SEC, type Shot } from '../storyboard/schema.js';
import { contentSentence, type SentenceSpan } from './content-sentence.js';

/** 片尾文字缺省值（默认同时放产品 logo） */
export const OUTRO_DEFAULT_TEXT = '用明知AI剪辑制作';
/** 用户可配置的片尾：关闭，或改文字（文字为空时只放 logo） */
export interface OutroOptions { enabled: boolean; text: string }
export const DEFAULT_OUTRO: OutroOptions = { enabled: true, text: OUTRO_DEFAULT_TEXT };
/** 片尾文字最长字数（一行放得下） */
export const OUTRO_TEXT_MAX = 24;

/** 传给渲染的片尾字段：startSec 起整片剩余部分都是片尾；logo 是相对工作目录的图片；片尾配色取全片色板（render/palette 的 usePalette，由色板推导，不在这里传） */
export interface OutroProps { startSec: number; text: string; logo: string }

/** 最后一句字幕结束后至少留这么久，让话落地再接片尾 */
export const HOLD_SEC = 0.6;
/** 品牌片尾时长 = clamp(片长 × 8%, 1.0, 2.5) 秒：短片 1 秒出头，长片封顶，不拖沓 */
export const OUTRO_RATIO = 0.08;
export const OUTRO_MIN_SEC = 1;
export const OUTRO_MAX_SEC = 2.5;
/** 片尾里 logo 弹出的时刻（相对片尾开始）；logo 音对准它 */
export const OUTRO_LOGO_SEC = 0.15;
/** CTA 卡起点距整片结尾的范围（秒）与单张时长范围 */
export const CTA_FROM_END = { min: 5, max: 8 } as const;
export const CTA_SEC = { min: 2, pref: 2.5, max: 3 } as const;
/** 放到最后一个内容句之后时，离内容句结束留的间隔（秒） */
export const CTA_AFTER_GAP_SEC = 0.1;
const EPS = 1e-6;

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const snapFrame = (sec: number): number => round3(Math.round(sec * CANVAS.fps) / CANVAS.fps);
const ceilFrame = (sec: number): number => round3(Math.ceil(sec * CANVAS.fps - 1e-6) / CANVAS.fps);
const floorFrame = (sec: number): number => round3(Math.floor(sec * CANVAS.fps + 1e-6) / CANVAS.fps);

/** 片尾时长（秒，整帧）：片长（口播内容含留白与 CTA，不含片尾）的 8%，夹在 [OUTRO_MIN_SEC, OUTRO_MAX_SEC] */
export function outroSecFor(contentSec: number): number {
  const sec = Math.min(OUTRO_MAX_SEC, Math.max(OUTRO_MIN_SEC, contentSec * OUTRO_RATIO));
  return round3(Math.round(sec * CANVAS.fps) / CANVAS.fps);
}

/** 合并用户设置与缺省：没设置按缺省，文字去首尾空白 */
export function resolveOutro(options: Partial<OutroOptions> | undefined): OutroOptions {
  return { enabled: options?.enabled ?? DEFAULT_OUTRO.enabled, text: (options?.text ?? DEFAULT_OUTRO.text).trim() };
}

/** 结尾的时间线：留白与片尾都在口播内容之后，不属于任何镜头 */
export interface EndingPlan {
  /** 整片时长（秒）= 留白结束（片尾开始）+ 片尾时长；没有片尾时等于留白结束 */
  durationSec: number;
  /** 留白结束的时刻：有片尾时是片尾开始；人像与末镜头的画面在内容结尾到这里定格 */
  outroStartSec: number;
  hasOutro: boolean;
}

const lastCaption = (captions: TimedCaption[]): TimedCaption | undefined => captions.reduce<TimedCaption | undefined>((best, c) => (!best || c.end > best.end ? c : best), undefined);
const isPlain = (s: Shot): boolean => !s.card && !s.broll && s.layout === 'full';
const isCta = (s: Shot | undefined): s is Shot & { card: Extract<NonNullable<Shot['card']>, { template: 'cta' }> } => s?.card?.template === 'cta';
const isPlacedCta = (s: Shot | undefined): boolean => isCta(s) && s.card.props.placed === true;

function mergePlain(shots: Shot[]): Shot[] {
  return shots.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    return last && isPlain(last) && isPlain(s) ? [...acc.slice(0, -1), { ...last, end: s.end }] : [...acc, s];
  }, []);
}

/** 提前到口播内容之后的 CTA（最后一个镜头、标 placed、结束晚于内容结尾）的结束时刻；没有返回 undefined */
function ctaAfterContentEnd(shots: Shot[], contentSec: number): number | undefined {
  const last = shots[shots.length - 1];
  return isPlacedCta(last) && last.end > contentSec + EPS ? last.end : undefined;
}

/**
 * 结尾时间线：最后一句字幕后留 ≥ HOLD_SEC（定格），再接品牌片尾（关闭时只有留白）。contentSec 是口播内容（人像视频）的时长；
 * 分镜里的 CTA 放到了内容结尾之后时（placeCta 的「最后一句之后」），片尾接在 CTA 之后。
 * 片尾时长按片长折算（outroSecFor）
 */
export function planEnding(captions: TimedCaption[], contentSec: number, outro: boolean, shots: Shot[] = []): EndingPlan {
  const spoken = lastCaption(captions)?.end ?? 0;
  const ctaEnd = ctaAfterContentEnd(shots, contentSec);
  const outroStartSec = Math.max(snapFrame(contentSec), ceilFrame(spoken > 0 ? spoken + HOLD_SEC : 0), ctaEnd === undefined ? 0 : ceilFrame(ctaEnd));
  const durationSec = outro ? round3(outroStartSec + outroSecFor(outroStartSec)) : outroStartSec;
  return { durationSec, outroStartSec, hasOutro: outro };
}

/** 回到「CTA 在末尾、覆盖到内容结尾」的原始形态：已提前的 CTA 之后全是纯人像镜头时合并回去；CTA 在内容结尾之后时并入前面的纯人像镜头；其余原样返回 */
function unplaceCta(shots: Shot[], contentSec: number): Shot[] {
  const i = shots.map(isPlacedCta).lastIndexOf(true);
  const cta = shots[i];
  if (i < 0 || !isCta(cta)) return shots;
  const { placed: _drop, ...props } = cta.card.props;
  const plainCta = (start: number, end: number): Shot => ({ ...cta, card: { template: 'cta', props }, start, end });
  if (i === shots.length - 1 && cta.end > contentSec + EPS) {
    const end = snapFrame(contentSec);
    const prev = shots[i - 1];
    if (end - cta.start >= MIN_SHOT_SEC) return [...shots.slice(0, i), plainCta(cta.start, end)];
    return prev && isPlain(prev) ? [...shots.slice(0, i - 1), plainCta(prev.start, end)] : shots;
  }
  return shots.slice(i + 1).every(isPlain) ? [...shots.slice(0, i), plainCta(cta.start, shots[shots.length - 1].end)] : shots;
}

/** 能放 CTA 的起点范围：整片倒数 5–8 秒、最晚在内容句开始前留 CTA_SEC.min；起点不得早于最后一个非纯人像镜头的结尾（不吃别的卡片与素材）。窗口放不下时 lo > hi */
function ctaRange(body: Shot[], sentence: SentenceSpan, totalSec: number): { lo: number; hi: number; fence: number } {
  const fence = body.reduce((m, s) => (isPlain(s) ? m : Math.max(m, s.end)), 0);
  return { lo: Math.max(totalSec - CTA_FROM_END.max, fence), hi: Math.min(totalSec - CTA_FROM_END.min, sentence.start - CTA_SEC.min), fence };
}

/** 把 body 里 start 之后的部分截掉（只会截纯人像镜头），空隙补人像镜头；返回 start 之前的镜头 */
function bodyUntil(body: Shot[], start: number): Shot[] {
  const kept = body.flatMap((s): Shot[] => (s.end <= start ? [s] : s.start < start ? [{ ...s, end: start }] : []));
  const gapFrom = kept[kept.length - 1]?.end ?? 0;
  return start - gapFrom > 1e-9 ? [...kept, { start: gapFrom, end: start, layout: 'full' }] : kept;
}

const placedCta = (last: Shot & { card: Extract<NonNullable<Shot['card']>, { template: 'cta' }> }, start: number, end: number): Shot =>
  ({ ...last, start, end, card: { template: 'cta', props: { ...last.card.props, placed: true } } });

/** 前移：CTA 放进整片倒数 5–8 秒，并在内容句开始前结束，其后的内容句回到人物全屏；内容句太长、窗口放不下或会吃掉别的镜头返回 undefined */
function placeBefore(body: Shot[], last: Shot & { card: Extract<NonNullable<Shot['card']>, { template: 'cta' }> }, sentence: SentenceSpan, total: number): Shot[] | undefined {
  const { lo, hi, fence } = ctaRange(body, sentence, total);
  if (lo > hi) return undefined;
  const pref = Math.min(hi, Math.max(lo, sentence.start - CTA_SEC.pref));
  // 离最后一个非纯人像镜头结尾不足 1 秒时吸附过去，免得留下碎镜头
  const start = snapFrame(fence >= lo && fence <= hi && Math.abs(pref - fence) < MIN_SHOT_SEC ? fence : pref);
  const end = Math.min(floorFrame(sentence.start), floorFrame(last.end - MIN_SHOT_SEC), snapFrame(start + CTA_SEC.max));
  if (end - start < CTA_SEC.min - 1 / CANVAS.fps || start >= last.end) return undefined;
  return mergePlain([...bodyUntil(body, start), placedCta(last, start, end), { start: end, end: last.end, layout: 'full' }]);
}

/**
 * 后放：CTA 放到最后一个内容句之后（短片、窗口放不下、前面有别的卡片挡着时）。起点 = 内容句结束 + CTA_AFTER_GAP_SEC（不早于前面最后一个非纯人像镜头结尾），
 * 时长 CTA_SEC.min；结束晚于口播内容结尾时，CTA 是最后一个镜头，片尾和留白接在它之后（planEnding）
 */
function placeAfter(body: Shot[], last: Shot & { card: Extract<NonNullable<Shot['card']>, { template: 'cta' }> }, sentence: SentenceSpan): Shot[] {
  const contentEnd = last.end;
  const fence = body.reduce((m, s) => (isPlain(s) ? m : Math.max(m, s.end)), 0);
  const wanted = Math.max(ceilFrame(sentence.end), Math.min(ceilFrame(sentence.end + CTA_AFTER_GAP_SEC), floorFrame(contentEnd)));
  // 离前一个卡片镜头结尾不足 1 秒（且内容句已说完）时吸附过去，免得留下碎镜头
  const start = fence >= ceilFrame(sentence.end) - EPS && fence <= wanted && wanted - fence < MIN_SHOT_SEC ? snapFrame(fence) : Math.max(wanted, ceilFrame(fence));
  const end0 = ceilFrame(start + CTA_SEC.min);
  const end = end0 < contentEnd && contentEnd - end0 < MIN_SHOT_SEC ? snapFrame(contentEnd) : end0;
  const after: Shot[] = end < contentEnd - EPS ? [{ start: end, end: contentEnd, layout: 'full' }] : [];
  return mergePlain([...bodyUntil(body, start), placedCta(last, start, end), ...after]);
}

/**
 * 在分镜里放置 CTA（分镜阶段调用，结果落盘）：CTA 不能盖住最后一个内容句（content-sentence：最后一个承载信息的字幕句，收尾话不算）。
 * 窗口放得下时前移到整片倒数第 5–8 秒并在内容句开始前结束（placeBefore）；否则（短片、内容句很长、前面有卡片挡着）放到内容句之后（placeAfter）。
 * CTA 标 placed，归一化不再拉回。再次调用幂等（先还原再放置）。没有 CTA 或没有字幕时原样返回。不改入参
 */
export function placeCta(shots: Shot[], captions: TimedCaption[], contentSec: number, outro: boolean): Shot[] {
  const base = unplaceCta(shots, contentSec);
  const last = base[base.length - 1];
  const sentence = contentSentence(captions);
  if (!isCta(last) || !sentence) return base;
  const body = base.slice(0, -1);
  return placeBefore(body, last, sentence, planEnding(captions, contentSec, outro).durationSec) ?? placeAfter(body, last, sentence);
}

/** 渲染用的片尾字段；没有片尾返回 undefined */
export function outroProps(plan: EndingPlan, options: OutroOptions, logoFile: string): OutroProps | undefined {
  return plan.hasOutro ? { startSec: plan.outroStartSec, text: options.text, logo: logoFile } : undefined;
}
