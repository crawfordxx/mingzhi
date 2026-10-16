import type { AppConfig } from '../config.js';
import type { TimedCaption } from '../captions/lines.js';
import { FULL_CAPTION_Y } from '../captions/styles.js';
import type { CostMeter } from '../cost/meter.js';
import { rethrowIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { hardChecks as realHardChecks, type HardCheck } from '../qa/hard.js';
import { defaultPalette } from '../qa/palette.js';
import { qaCards as realQaCards, type CardQaEntry, type QaCardsOptions } from '../qa/visual.js';
import { filmSummary, type FilmReport } from '../qa/film.js';
import type { FacePerson } from '../qa/face-noise-measure.js';
import { contentEnd, measureFilm } from '../qa/film-measure.js';
import { planRedo, syncBeats, type FilmQa, type RedoAction } from '../qa/film-redo.js';
import { CANVAS, type Storyboard } from '../storyboard/schema.js';
import { captionCenterY, visualLayout } from '../compose/layout.js';
import type { ProjectFile, ProjectPatch } from './project.js';

/** 自检结果：卡片视觉自检报告与成片硬检查（跳过自检时两者都为空） */
export interface PipelineQa { cards: CardQaEntry[]; hard: HardCheck[] }
/** 仅供测试注入的自检实现；缺省时用真实实现（不跑 Remotion 打包） */
export interface QaDeps { qaCards?: typeof realQaCards; hardChecks?: typeof realHardChecks; /** 整片度量（抽帧、渲染静帧）；测试注入假实现 */ film?: typeof measureFilm }

type Complete<S extends 'qa-cards' | 'qa-final' | 'qa-film'> = (step: S, message: string, patch?: ProjectPatch) => ProjectFile;

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

/** 成片里字幕实际用到的竖向中心：分屏镜头压在分界线上，其余版式（全屏、全屏插入、画中画、浮层）用字幕层的常量 */
export function captionCentersOf(storyboard: Storyboard): number[] {
  const ys = new Set(storyboard.shots.map((s) => captionCenterY(visualLayout(s))));
  return [CANVAS.seam, FULL_CAPTION_Y].filter((y) => ys.has(y));
}

export interface QaCardsContext {
  llm: LlmClient; workDir: string; meter: CostMeter; ffmpeg: string; qaCards?: typeof realQaCards; onProgress?: QaCardsOptions['onProgress'];
  /** 给封面预留的花费（元），封面开启时传 COVER_YUAN，关闭传 0 */
  reserveYuan?: number;
  /** 取消信号：转给逐张卡片的检查循环 */
  signal?: AbortSignal;
  /** 只检查这些镜头序号的卡片；缺省全部 */
  only?: number[];
  /** 只打分不重写的镜头（用户在对话里指定的卡片） */
  keep?: number[];
}

/** 卡片自检：不达标的卡片重写；返回（可能被改写的）分镜并落盘。自检本身出错（余额不足除外）只记一条进度，沿用原分镜 */
export async function runQaCards(ctx: QaCardsContext, storyboard: Storyboard, captions: TimedCaption[], complete: Complete<'qa-cards'>): Promise<{ storyboard: Storyboard; report: CardQaEntry[] }> {
  let res: { storyboard: Storyboard; report: CardQaEntry[] };
  try {
    res = await (ctx.qaCards ?? realQaCards)({
      client: ctx.llm, workDir: ctx.workDir, storyboard, captions, meter: ctx.meter, ffmpeg: ctx.ffmpeg, reserveYuan: ctx.reserveYuan,
      signal: ctx.signal, onProgress: ctx.onProgress, ...(ctx.only ? { only: ctx.only } : {}), ...(ctx.keep ? { keep: ctx.keep } : {}),
    });
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    complete('qa-cards', `卡片自检失败，已跳过（成片不受影响）：${err instanceof Error ? err.message : String(err)}`);
    return { storyboard, report: [] };
  }
  const reasons = [...new Set(res.report.flatMap((e) => (e.skipped ? [e.skipped] : [])))];
  complete('qa-cards', `${cardsSummary(res.report)}${reasons.length > 0 ? ` · 跳过原因：${reasons.join('；')}` : ''}`, { storyboard: res.storyboard, qa: { cards: res.report, hard: [] } });
  return res;
}

/** outroStartSec：有品牌片尾时给出，成片硬检查会多检查片尾响度 */
export interface QaFinalContext { cfg: AppConfig; hardChecks?: typeof realHardChecks; outroStartSec?: number }

/** 成片硬检查：不通过只在进度消息里列出，检查本身出错也不让成片失败 */
export async function runQaFinal(ctx: QaFinalContext, video: string, storyboard: Storyboard, cards: CardQaEntry[], complete: Complete<'qa-final'>): Promise<HardCheck[]> {
  let hard: HardCheck[] = [];
  let message: string;
  try {
    hard = await (ctx.hardChecks ?? realHardChecks)(video, { captionCenters: captionCentersOf(storyboard) }, defaultPalette(), ctx.cfg, ctx.outroStartSec);
    message = hardSummary(hard);
  } catch (err) {
    rethrowIfCancelled(err);
    message = `成片检查失败，已跳过（成片不受影响）：${err instanceof Error ? err.message : String(err)}`;
  }
  complete('qa-final', message, { qa: { cards, hard } });
  return hard;
}

/** redo：是否允许局部重做（CLI 与工作台首版重做；修改版本只检查，免得改掉用户点名的版式）；measure 缺省为真实度量 */
export interface QaFilmContext { cfg: AppConfig; workDir: string; redo: boolean; signal?: AbortSignal; measure?: typeof measureFilm; /** 素材记录所在目录（工作台是 base），缺省 workDir */ metaDir?: string; /** 人像视频与人物框，给出时整片自检加测人脸区域高频噪声 */ face?: FacePerson }
/** 一版成片：视频文件、它对应的分镜与片尾开始时刻 */
export interface FilmCut { video: string; storyboard: Storyboard; outroStartSec?: number }

const actionText = (actions: RedoAction[]): string => actions.map((a) => `第 ${a.shotIndex + 1} 镜：${a.detail}`).join('；');

async function measureCut(ctx: QaFilmContext, cut: FilmCut): Promise<FilmReport> {
  const o = { ffmpeg: ctx.cfg.ffmpeg, workDir: ctx.workDir, ...(ctx.metaDir ? { metaDir: ctx.metaDir } : {}), video: cut.video, storyboard: cut.storyboard, signal: ctx.signal, ...(ctx.face ? { face: ctx.face } : {}) };
  return (ctx.measure ?? measureFilm)(cut.outroStartSec === undefined ? o : { ...o, outroStartSec: cut.outroStartSec });
}

/**
 * 整片自检：度量 → 不达标且允许时按指标出一轮局部重做（只改目标镜头）→ 重渲（分段缓存只重渲受影响的镜头）→ 复测。
 * 度量或重渲出错（余额不足、取消除外）只记进度，沿用原成片
 */
export async function runQaFilm(ctx: QaFilmContext, cut: FilmCut, captions: TimedCaption[], rerender: (storyboard: Storyboard) => Promise<FilmCut>, complete: Complete<'qa-film'>): Promise<{ cut: FilmCut; film?: FilmQa }> {
  let before: FilmReport;
  try {
    before = await measureCut(ctx, cut);
  } catch (err) {
    rethrowIfCancelled(err);
    complete('qa-film', `整片自检失败，已跳过（成片不受影响）：${err instanceof Error ? err.message : String(err)}`);
    return { cut };
  }
  const plan = before.ok || !ctx.redo ? undefined : planRedo(cut.storyboard, before, captions, contentEnd(cut.storyboard));
  const unfixed = plan?.unfixed ?? [];
  const head = filmSummary(before);
  if (!plan || plan.actions.length === 0) {
    const film: FilmQa = { before, actions: [], unfixed };
    complete('qa-film', [head, ...before.skipped, ...unfixed].join(' · '), { film });
    return { cut, film };
  }
  complete('qa-film', `${head} · 局部重做：${actionText(plan.actions)}`);
  return redoOnce(ctx, cut, { before, actions: plan.actions, unfixed }, plan.storyboard, rerender, complete);
}

/** 按重做后的分镜重渲并复测：重做后的分镜先落盘一次（工作台直播刷新镜头列表，同时把 B-roll 节拍记录对齐）；重渲失败时撤回重做动作、保留原成片 */
async function redoOnce(ctx: QaFilmContext, cut: FilmCut, film: FilmQa, storyboard: Storyboard, rerender: (s: Storyboard) => Promise<FilmCut>, complete: Complete<'qa-film'>): Promise<{ cut: FilmCut; film: FilmQa }> {
  let next: FilmCut;
  try {
    next = await rerender(storyboard);
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    const reason = `局部重做渲染失败，已撤回（${actionText(film.actions)}）：${err instanceof Error ? err.message : String(err)}`;
    const reverted: FilmQa = { ...film, actions: [], unfixed: [...film.unfixed, reason] };
    complete('qa-film', reason, { film: reverted });
    return { cut, film: reverted };
  }
  const project = complete('qa-film', `局部重做后的分镜：${next.storyboard.shots.length} 个镜头`, { storyboard: next.storyboard });
  const beats = project?.broll?.beats;
  const synced = beats ? syncBeats(beats, next.storyboard) : undefined;
  let after: FilmReport | undefined;
  try {
    after = await measureCut(ctx, next);
  } catch (err) {
    rethrowIfCancelled(err);
  }
  const done: FilmQa = { ...film, ...(after ? { after } : {}) };
  const tail = [...(after?.skipped ?? []), ...film.unfixed];
  const brollPatch = project?.broll && synced && synced.some((r, i) => r !== beats?.[i]) ? { broll: { ...project.broll, beats: synced } } : {};
  complete('qa-film', [`局部重做后：${after ? filmSummary(after) : '复测失败'}`, ...tail].join(' · '), { film: done, ...brollPatch });
  return { cut: next, film: done };
}
