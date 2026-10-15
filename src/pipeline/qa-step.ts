import type { AppConfig } from '../config.js';
import type { TimedCaption } from '../captions/lines.js';
import { FULL_CAPTION_Y } from '../captions/styles.js';
import type { CostMeter } from '../cost/meter.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { hardChecks as realHardChecks, type HardCheck } from '../qa/hard.js';
import { defaultPalette } from '../qa/palette.js';
import { qaCards as realQaCards, type CardQaEntry, type QaCardsOptions } from '../qa/visual.js';
import { CANVAS, type Storyboard } from '../storyboard/schema.js';
import type { ProjectFile, ProjectPatch } from './project.js';

/** 自检结果：卡片视觉自检报告与成片硬检查（跳过自检时两者都为空） */
export interface PipelineQa { cards: CardQaEntry[]; hard: HardCheck[] }
/** 仅供测试注入的自检实现；缺省时用真实实现（不跑 Remotion 打包） */
export interface QaDeps { qaCards?: typeof realQaCards; hardChecks?: typeof realHardChecks }

type Complete<S extends 'qa-cards' | 'qa-final'> = (step: S, message: string, patch?: ProjectPatch) => ProjectFile;

export const cardsSummary = (report: CardQaEntry[]): string => {
  const passed = report.filter((e) => e.passed).length;
  const revised = report.reduce((sum, e) => sum + e.revised, 0);
  const skipped = report.filter((e) => e.skipped).length;
  return `卡片自检 ${report.length} 张：通过 ${passed}、重写 ${revised} 次、跳过 ${skipped}`;
};

const failing = (hard: HardCheck[]): HardCheck[] => hard.filter((c) => !c.ok);

/** 进度消息：全部通过，或列出未通过项的 id 与详情 */
export const hardSummary = (hard: HardCheck[]): string => {
  const bad = failing(hard);
  if (bad.length === 0) return `成片检查：全部通过（${hard.length}/${hard.length}）`;
  return `成片检查 ${hard.length - bad.length}/${hard.length} 通过，未通过：${bad.map((c) => `${c.id}（${c.detail}）`).join('；')}`;
};

/** CLI 完成提示里的一行摘要 */
export const qaSummary = (qa: PipelineQa): string =>
  `${cardsSummary(qa.cards)} · ${qa.hard.length === 0 ? '成片检查未完成' : `成片检查 ${qa.hard.length - failing(qa.hard).length}/${qa.hard.length} 通过`}`;

/** 成片里字幕实际用到的竖向中心：分屏镜头压在分界线上，全屏镜头用字幕层的常量 */
export function captionCentersOf(storyboard: Storyboard): number[] {
  const layouts = new Set(storyboard.shots.map((s) => s.layout));
  return [...(layouts.has('split') ? [CANVAS.seam] : []), ...(layouts.has('full') ? [FULL_CAPTION_Y] : [])];
}

export interface QaCardsContext {
  llm: LlmClient; workDir: string; meter: CostMeter; ffmpeg: string; qaCards?: typeof realQaCards; onProgress?: QaCardsOptions['onProgress'];
  /** 给封面预留的花费（元），封面开启时传 COVER_YUAN，关闭传 0 */
  reserveYuan?: number;
}

/** 卡片自检：不达标的卡片重写；返回（可能被改写的）分镜并落盘。自检本身出错（余额不足除外）只记一条进度，沿用原分镜 */
export async function runQaCards(ctx: QaCardsContext, storyboard: Storyboard, captions: TimedCaption[], complete: Complete<'qa-cards'>): Promise<{ storyboard: Storyboard; report: CardQaEntry[] }> {
  let res: { storyboard: Storyboard; report: CardQaEntry[] };
  try {
    res = await (ctx.qaCards ?? realQaCards)({ client: ctx.llm, workDir: ctx.workDir, storyboard, captions, meter: ctx.meter, ffmpeg: ctx.ffmpeg, reserveYuan: ctx.reserveYuan, onProgress: ctx.onProgress });
  } catch (err) {
    rethrowIfBalance(err);
    complete('qa-cards', `卡片自检失败，已跳过（成片不受影响）：${err instanceof Error ? err.message : String(err)}`);
    return { storyboard, report: [] };
  }
  const reasons = [...new Set(res.report.flatMap((e) => (e.skipped ? [e.skipped] : [])))];
  complete('qa-cards', `${cardsSummary(res.report)}${reasons.length > 0 ? ` · 跳过原因：${reasons.join('；')}` : ''}`, { storyboard: res.storyboard, qa: { cards: res.report, hard: [] } });
  return res;
}

export interface QaFinalContext { cfg: AppConfig; hardChecks?: typeof realHardChecks }

/** 成片硬检查：不通过只在进度消息里列出，检查本身出错也不让成片失败 */
export async function runQaFinal(ctx: QaFinalContext, video: string, storyboard: Storyboard, cards: CardQaEntry[], complete: Complete<'qa-final'>): Promise<HardCheck[]> {
  let hard: HardCheck[] = [];
  let message: string;
  try {
    hard = await (ctx.hardChecks ?? realHardChecks)(video, { captionCenters: captionCentersOf(storyboard) }, defaultPalette(), ctx.cfg);
    message = hardSummary(hard);
  } catch (err) {
    message = `成片检查失败，已跳过（成片不受影响）：${err instanceof Error ? err.message : String(err)}`;
  }
  complete('qa-final', message, { qa: { cards, hard } });
  return hard;
}
