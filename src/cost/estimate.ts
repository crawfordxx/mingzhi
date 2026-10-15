import { EST_TASK_YUAN } from './constants.js';

/** 开跑前的花费预估：系数来自实测，全部写成具名常量；low 为「可能不需要」时的下限，high 为最坏情况 */
export const CUT_YUAN_PER_MIN = 0.15;
export const POLISH_YUAN_PER_MIN = 0.05;
export const STORYBOARD_YUAN_PER_MIN = 0.05;
export const IMAGE_YUAN = EST_TASK_YUAN.image;
export const VIDEO_YUAN = EST_TASK_YUAN.video;
/** B-roll 联网搜索（找截图网址）每个截图需求的预估花费 */
export const SEARCH_YUAN = 0.05;
export const BG_PROMPT_YUAN = IMAGE_YUAN;
/** B-roll 生图密度：low 每 15 秒 1 张，high 每 10 秒 1 张 */
export const BROLL_SEC_PER_IMAGE_LOW = 15;
export const BROLL_SEC_PER_IMAGE_HIGH = 10;
/** 封面：两种比例各生图 1 张（¥0.6）+ 读图核对；high 按标题核对不通过重生一轮 */
export const COVER_ART_YUAN = 0.6;
export const COVER_READ_YUAN = 0.05;
export const COVER_YUAN = 2 * COVER_ART_YUAN + COVER_READ_YUAN;
export const COVER_HIGH_FACTOR = 2;
/** 卡片自检：每 6 秒 1 张卡，每张 ¥0.05（打分一次约 ¥0.02，加三联图与重写），最坏每张反复检 5 轮 */
export const QA_SEC_PER_CARD = 6;
export const QA_CARD_YUAN = 0.05;
export const QA_HIGH_FACTOR = 5;

/** yuan 是该项的高估值，low 是低估值（可能为 0） */
export interface EstimateItem { label: string; yuan: number; low: number }
export interface Estimate { low: number; high: number; items: EstimateItem[] }
export interface EstimateOptions { durationSec: number; bgPrompt: boolean; broll: boolean; maxVideos: number; qa: boolean; cover?: boolean }

/** 这三步有意不查预算（没有它们出不了片），预估里单独核对它们是否已超上限 */
const REQUIRED_LABELS: readonly string[] = ['剪口误', '字幕校对', '分镜'];

const round2 = (v: number): number => Math.round(v * 100) / 100;
const item = (label: string, low: number, high: number): EstimateItem => ({ label, low: round2(low), yuan: round2(high) });

/** 估算整条视频的付费步骤花费；durationSec 用原片时长（剪口误后只会更短，所以是偏保守的估计） */
export function estimateCost(opts: EstimateOptions): Estimate {
  const sec = Math.max(0, opts.durationSec);
  const min = sec / 60;
  const imagesLow = Math.ceil(sec / BROLL_SEC_PER_IMAGE_LOW);
  const imagesHigh = Math.ceil(sec / BROLL_SEC_PER_IMAGE_HIGH);
  const cards = Math.ceil(sec / QA_SEC_PER_CARD);
  const items: EstimateItem[] = [
    item('剪口误', min * CUT_YUAN_PER_MIN, min * CUT_YUAN_PER_MIN),
    item('字幕校对', min * POLISH_YUAN_PER_MIN, min * POLISH_YUAN_PER_MIN),
    item('分镜', min * STORYBOARD_YUAN_PER_MIN, min * STORYBOARD_YUAN_PER_MIN),
    ...(opts.bgPrompt ? [item('背景生图', BG_PROMPT_YUAN, BG_PROMPT_YUAN)] : []),
    ...(opts.broll ? [item('B-roll 生图', imagesLow * IMAGE_YUAN, imagesHigh * IMAGE_YUAN), item('B-roll 视频（Seedance）', 0, opts.maxVideos * VIDEO_YUAN), item('B-roll 联网搜索', imagesLow * SEARCH_YUAN, imagesHigh * SEARCH_YUAN)] : []),
    ...(opts.cover ?? true ? [item('封面', COVER_YUAN, COVER_YUAN * COVER_HIGH_FACTOR)] : []),
    ...(opts.qa ? [item('卡片自检', cards * QA_CARD_YUAN, cards * QA_CARD_YUAN * QA_HIGH_FACTOR)] : []),
  ];
  return { low: round2(items.reduce((s, i) => s + i.low, 0)), high: round2(items.reduce((s, i) => s + i.yuan, 0)), items };
}

const yuan = (v: number): string => `¥${v.toFixed(2)}`;
const range = (low: number, high: number): string => (low === high ? yuan(high) : `${yuan(low)}–${yuan(high)}`);

/** 预估的多行文字：总额区间、预算与各项明细；最高值超出预算时附降级提示 */
export function formatEstimate(est: Estimate, budgetYuan: number): string {
  const lines = [`预估花费 ${range(est.low, est.high)}（上限 ${yuan(budgetYuan)}）`, ...est.items.map((i) => `  · ${i.label} ${range(i.low, i.yuan)}`)];
  const required = round2(est.items.filter((i) => REQUIRED_LABELS.includes(i.label)).reduce((s, i) => s + i.yuan, 0));
  if (required > budgetYuan) lines.push(`必需步骤（剪口误、字幕校对、分镜）约 ${yuan(required)} 已超上限 ${yuan(budgetYuan)}，仍会花费`);
  if (est.high > budgetYuan) lines.push(`预估最高 ${yuan(est.high)}，超过上限 ${yuan(budgetYuan)}：将自动降级（不用 Seedance，必要时少生图）`);
  return lines.join('\n');
}
