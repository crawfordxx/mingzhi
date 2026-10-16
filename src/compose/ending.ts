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

function mergePlain(shots: Shot[]): Shot[] {
  return shots.reduce<Shot[]>((acc, s) => {
    const last = acc[acc.length - 1];
    return last && isPlain(last) && isPlain(s) ? [...acc.slice(0, -1), { ...last, end: s.end }] : [...acc, s];
  }, []);
}

/** 结尾时间线：最后一句字幕后留 ≥ HOLD_SEC（定格），再接 OUTRO_SEC 的品牌片尾（关闭时只有留白）。contentSec 是口播内容（人像视频）的时长 */
export function planEnding(captions: TimedCaption[], contentSec: number, outro: boolean): EndingPlan {
  const spoken = lastCaption(captions)?.end ?? 0;
  const outroStartSec = Math.max(snapFrame(contentSec), ceilFrame(spoken > 0 ? spoken + HOLD_SEC : 0));
  const durationSec = outro ? round3(outroStartSec + Math.round(OUTRO_SEC * CANVAS.fps) / CANVAS.fps) : outroStartSec;
  return { durationSec, outroStartSec, hasOutro: outro };
}

const isCta = (s: Shot | undefined): s is Shot & { card: Extract<NonNullable<Shot['card']>, { template: 'cta' }> } => s?.card?.template === 'cta';

/** 已提前的 CTA（placed）之后全是纯人像镜头时，还原成「CTA 在末尾、覆盖到内容结尾」的原始形态；其余原样返回 */
function unplaceCta(shots: Shot[]): Shot[] {
  const i = shots.map((s) => isCta(s) && s.card.props.placed === true).lastIndexOf(true);
  if (i < 0 || !shots.slice(i + 1).every(isPlain)) return shots;
  const { placed: _drop, ...props } = (shots[i].card as { props: { actions: string[]; placed?: boolean } }).props;
  return [...shots.slice(0, i), { ...shots[i], card: { template: 'cta', props }, end: shots[shots.length - 1].end }];
}

/** 能放 CTA 的起点范围：整片倒数 5–8 秒、最晚在最后一句开始前留 CTA_SEC.min；窗口放不下时退到最后一句之前；起点不得早于最后一个非纯人像镜头的结尾（不吃别的卡片与素材） */
function ctaRange(body: Shot[], final: TimedCaption, totalSec: number): { lo: number; hi: number; fence: number } {
  const fence = body.reduce((m, s) => (isPlain(s) ? m : Math.max(m, s.end)), 0);
  const latest = final.start - CTA_SEC.min;
  const lo = totalSec - CTA_FROM_END.max;
  const hi = Math.min(totalSec - CTA_FROM_END.min, latest);
  return lo <= hi ? { lo: Math.max(lo, fence), hi, fence } : { lo: Math.max(0, fence), hi: latest, fence };
}

/**
 * 在分镜里放置 CTA（分镜阶段调用，结果落盘）：把末尾 CTA 移到整片倒数第 5–8 秒，并在最后一句字幕开始前结束（与最后一句不同时出现），
 * 之后的最后一句回到人物全屏；CTA 标 placed，归一化不再拉回。再次调用幂等（先还原再放置）。
 * 只占用纯人像镜头：会吃掉或截断其他卡片、B-roll 素材时不提前，CTA 留在末尾；没有字幕、放不下 CTA_SEC.min 时同理。不改入参
 */
export function placeCta(shots: Shot[], captions: TimedCaption[], contentSec: number, outro: boolean): Shot[] {
  const base = unplaceCta(shots);
  const last = base[base.length - 1];
  const final = lastCaption(captions);
  if (!isCta(last) || !final) return base;
  const body = base.slice(0, -1);
  const { lo, hi, fence } = ctaRange(body, final, planEnding(captions, contentSec, outro).durationSec);
  if (lo > hi) return base;
  const pref = Math.min(hi, Math.max(lo, final.start - CTA_SEC.pref));
  // 离最后一个非纯人像镜头结尾不足 1 秒时吸附过去，免得留下碎镜头
  const start = snapFrame(fence >= lo && fence <= hi && Math.abs(pref - fence) < MIN_SHOT_SEC ? fence : pref);
  const end = Math.min(floorFrame(final.start), floorFrame(last.end - MIN_SHOT_SEC), snapFrame(start + CTA_SEC.max));
  if (end - start < CTA_SEC.min - 1 / CANVAS.fps || start >= last.end) return base;
  const kept = body.flatMap((s): Shot[] => (s.end <= start ? [s] : s.start < start ? [{ ...s, end: start }] : []));
  const gapFrom = kept[kept.length - 1]?.end ?? 0;
  const gap: Shot[] = start - gapFrom > 1e-9 ? [{ start: gapFrom, end: start, layout: 'full' }] : [];
  const cta: Shot = { ...last, start, end, card: { template: 'cta', props: { ...last.card.props, placed: true } } };
  return mergePlain([...kept, ...gap, cta, { start: end, end: last.end, layout: 'full' }]);
}

/** 渲染用的片尾字段；没有片尾返回 undefined */
export function outroProps(plan: EndingPlan, options: OutroOptions, logoFile: string): OutroProps | undefined {
  return plan.hasOutro ? { startSec: plan.outroStartSec, text: options.text, logo: logoFile } : undefined;
}
