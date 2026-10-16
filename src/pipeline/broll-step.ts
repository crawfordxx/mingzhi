import type { AppConfig } from '../config.js';
import type { CostMeter } from '../cost/meter.js';
import type { TimedCaption } from '../captions/lines.js';
import { brollCapYuan, makeBudget, type BrollBudget } from '../broll/budget.js';
import { makeDeps } from '../broll/deps.js';
import { fulfillVisuals, upgradeToVideo, type BrollAsset, type BrollDeps, type FulfillOptions } from '../broll/fulfill.js';
import { PROJECT_LUT } from '../broll/process.js';
import type { BeatEnv } from '../broll/realize.js';
import type { LlmClient } from '../llm/kexiang.js';
import { runBeats, type BeatRecord, type BeatsCtx } from './broll-beats.js';
import { brollMix, finalize, mixSummary, recheck, recordCardAssets, writeCredits } from './broll-finish.js';
import { redoShots, type BrollMark } from './broll-redo.js';
import { brollDetail } from './detail.js';
import { rethrowIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { KexiangTaskClient, type TaskClient } from '../llm/kexiang-task.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import type { Shot, Storyboard } from '../storyboard/schema.js';
import { visualsOf, type VisualNeed } from '../storyboard/visuals.js';
import type { ProgressEvent } from './run.js';
import type { ProjectFile, ProjectPatch } from './project.js';

/** B-roll 选项：enabled 为 false 时不取任何素材 */
export interface BrollOptions { enabled: boolean; maxVideos: number; budgetYuan: number; pexelsKey?: string; pixabayKey?: string }
export interface BrollContext {
  workDir: string;
  cfg: AppConfig;
  broll?: BrollOptions;
  /** 仅供测试注入；缺省时用可想 task 与可想 key 构造真实依赖 */
  brollDeps?: BrollDeps;
  task?: TaskClient;
  /** 统一记账；缺省时按 broll.budgetYuan 在本步内累计检查 */
  meter?: CostMeter;
  /** 给后续步骤（封面）预留的花费，预算检查时一并扣除，缺省 0 */
  reserveYuan?: number;
  /** 取消信号：转给逐条取素材的循环 */
  signal?: AbortSignal;
  /** 排到最后取素材的镜头（见 FulfillOptions.deferShots） */
  deferShots?: number[];
  onProgress?: (e: ProgressEvent) => void;
  /** 节拍规划、审片、主体定位用的模型；和 captions 都有时才跑节拍编排 */
  llm?: LlmClient;
  captions?: TimedCaption[];
  /** credits.json 写到这里（工作台是版本目录；缺省 workDir） */
  creditsDir?: string;
  /** 工作台修改版本：不重新规划节拍；只重做这些时刻（成片秒数）所在镜头的 B-roll，marks 是上一版素材面板的标记，records 是上一版的节拍记录 */
  edit?: { redoAt: number[]; marks: Record<string, BrollMark>; records: BeatRecord[] };
  /** 素材向人物背景的平均色做白平衡微调（0–1） */
  whiteBalance?: { r: number; g: number; b: number };
}
type Complete = (step: 'broll', message: string, patch?: ProjectPatch) => ProjectFile;

const SOURCE_LABEL: Record<BrollAsset['source'], string> = { screenshot: '截图', generate: '生图', pexels: '图库', video: '视频' };
const NEED_TASK = '取 B-roll 素材需要可想 AI key，请设置环境变量 MINGZHI_KX_KEY，或加 --no-broll 关闭素材获取';
const NEED_TASK_BG = '一句话生成背景需要可想 AI key，请设置环境变量 MINGZHI_KX_KEY';
const NEED_LABEL: Record<VisualNeed['visual']['source'], string> = { screenshot: '截图', generate: '生图', video: '生图（钩子关键图）' };

const DEFAULT_MAX_VIDEOS = 1;
const DEFAULT_BUDGET_YUAN = 10;

/** 严格解析命令行数字：只接受纯十进制（不收 1e3、0x10、空串、负数）；max-videos 必须是整数 */
function parseNonNegative(raw: string | undefined, fallback: number, flag: string, integer: boolean): number {
  if (raw === undefined) return fallback;
  if (!(integer ? /^\d+$/ : /^\d+(\.\d+)?$/).test(raw)) throw new Error(`${flag} 需要${integer ? '非负整数' : '非负数'}，收到「${raw}」`);
  return Number(raw);
}

/** --budget 解析：每条视频的花费上限（元），缺省 10；预算属于整条流程，不归 B-roll */
export function parseBudgetArg(raw: string | undefined): number {
  return parseNonNegative(raw, DEFAULT_BUDGET_YUAN, '--budget', false);
}

/** CLI 参数 → B-roll 选项：默认开启，最多 1 个视频，预算 10 元；pexelsKey 来自配置（MINGZHI_PEXELS_KEY） */
export function parseBrollArgs(values: { 'no-broll'?: boolean; 'max-videos'?: string; budget?: string }, pexelsKey?: string): BrollOptions {
  return {
    enabled: !values['no-broll'],
    maxVideos: parseNonNegative(values['max-videos'], DEFAULT_MAX_VIDEOS, '--max-videos', true),
    budgetYuan: parseBudgetArg(values.budget), // 仅在没有 meter 时 B-roll 自己用它检查
    ...(pexelsKey ? { pexelsKey } : {}),
  };
}

/** 需要可想任务（取素材或一句话生成背景）时构造任务客户端；没配 key 时先给出可操作的提示，而不是构造时才抛通用错误 */
export function makeTaskClient(cfg: AppConfig, wanted: { background: boolean; broll: BrollOptions; meter?: CostMeter }): KexiangTaskClient | undefined {
  if (!wanted.background && !wanted.broll.enabled) return undefined;
  if (!cfg.kexiangKey) throw new Error(wanted.broll.enabled ? NEED_TASK : NEED_TASK_BG);
  return new KexiangTaskClient(cfg.kexiangKey, undefined, undefined, undefined, wanted.meter);
}

/** 开启素材获取却没有任何可用的依赖时，提前报错（避免跑完剪辑才发现） */
export function validateBroll(broll: BrollOptions | undefined, deps: BrollDeps | undefined, task: TaskClient | undefined): void {
  if (broll?.enabled && !deps && !task) throw new Error(NEED_TASK);
}

/** 素材统计：图库图片并入「生图」一栏（都是静态图） */
export function brollSummary(assets: BrollAsset[], failureCount: number, costYuan: number): string {
  const count = (...sources: BrollAsset['source'][]): number => assets.filter((a) => sources.includes(a.source)).length;
  return `素材 ${assets.length} 个（截图 ${count('screenshot')} / 生图 ${count('generate', 'pexels')} / 视频 ${count('video')}）· 花费 ¥${costYuan.toFixed(2)} · 失败 ${failureCount} 个`;
}

/** 去掉卡片上的 visual（待取素材需求），不改动入参 */
function stripVisual(shot: Shot): Shot {
  const card = shot.card;
  if (!card || !('visual' in card.props)) return shot;
  const { visual: _visual, ...props } = card.props as { visual?: unknown };
  return { ...shot, card: { ...card, props } } as Shot;
}

/** 不取素材：去掉所有 visual 后重新归一化（可用文件为空），只靠 visual 存在的 photo 会被丢弃并补成全屏 */
export function withoutBroll(storyboard: Storyboard, durationSec: number): Storyboard {
  return normalizeStoryboard({ ...storyboard, shots: storyboard.shots.map(stripVisual) }, durationSec, []).storyboard;
}

/** 单个素材的进度文案（只回调、不写 project.json）：开始、视频状态、完成（缓存命中标「（缓存）」）或失败 */
const startMessage = (n: number, total: number, need: VisualNeed): string => `素材 ${n}/${total}：${NEED_LABEL[need.visual.source]}中…`;
function assetMessage(done: number, total: number, a: BrollAsset | { key: string; failed: string }): string {
  const head = `素材 ${done}/${total}`;
  return 'failed' in a ? `${head} 失败：${a.failed}` : `${head} ${SOURCE_LABEL[a.source]}${a.cached ? '（缓存）' : ''} ${a.file}`;
}

function resolveDeps(ctx: BrollContext, broll: BrollOptions): BrollDeps {
  if (ctx.brollDeps) return ctx.brollDeps;
  if (!ctx.task) throw new Error(NEED_TASK);
  return makeDeps({ apiKey: ctx.cfg.kexiangKey ?? '', task: ctx.task, cfg: ctx.cfg, pexelsKey: broll.pexelsKey ?? ctx.cfg.pexelsKey, pixabayKey: broll.pixabayKey ?? ctx.cfg.pixabayKey, meter: ctx.meter });
}

/** 进度回调：onStart / onAsset 共用一个计数 */
function progressHooks(ctx: BrollContext, total: number): Pick<FulfillOptions, 'onStart' | 'onAsset'> {
  let done = 0;
  const emit = (message: string): void => ctx.onProgress?.({ step: 'broll', message });
  return {
    onStart: (need) => emit(startMessage(done + 1, total, need)),
    onAsset: (a) => { done += 1; emit(assetMessage(done, total, a)); },
  };
}

/** 图生视频的状态：变化时才转发 */
function videoStatus(ctx: BrollContext): (status: string) => void {
  let last = '';
  return (status) => { if (status !== last) { last = status; ctx.onProgress?.({ step: 'broll', message: `钩子图生视频中（${status}）` }); } };
}

/** 节拍编排的环境；没有模型或字幕（老调用方）时不跑节拍 */
function beatsCtx(ctx: BrollContext, deps: BrollDeps, budget: BrollBudget, durationSec: number): BeatsCtx | undefined {
  if (!ctx.llm || !ctx.captions) return undefined;
  const env: BeatEnv = {
    workDir: ctx.workDir, ffmpeg: ctx.cfg.ffmpeg, lut: PROJECT_LUT, llm: ctx.llm, budget, fetchImpl: deps.fetchImpl ?? fetch,
    ...(ctx.signal ? { signal: ctx.signal } : {}), ...(ctx.whiteBalance ? { whiteBalance: ctx.whiteBalance } : {}),
  };
  const emit = (message: string, detail?: ProgressEvent['detail']): void => ctx.onProgress?.({ step: 'broll', message, ...(detail ? { detail } : {}) });
  return { env, captions: ctx.captions, durationSec, sources: deps.sources ?? [], paid: deps, emit };
}

interface Shots { storyboard: Storyboard; records: BeatRecord[]; notes: string[]; imageUrls: Record<string, string> }

/** 首版：规划节拍并放进镜头；修改版本：只重做指定镜头 */
async function placeBroll(ctx: BrollContext, bc: BeatsCtx | undefined, storyboard: Storyboard): Promise<Shots> {
  if (!bc) return { storyboard, records: ctx.edit?.records ?? [], notes: [], imageUrls: {} };
  if (ctx.edit) {
    const r = await redoShots(bc, storyboard, ctx.edit.redoAt, ctx.edit.marks, ctx.edit.records);
    return { storyboard: r.storyboard, records: ctx.edit.records, notes: r.notes, imageUrls: {} };
  }
  const r = await runBeats(bc, storyboard);
  return { storyboard: r.storyboard, records: r.records, notes: r.note ? [r.note] : [], imageUrls: r.imageUrls };
}

/** 开启时：卡片素材 → 节拍编排（或重做指定镜头）→ 预算还够时钩子图生视频 → 归一化、复检、写 credits.json；整步异常不中断出片，降级为去掉待取素材的分镜 */
async function fetchBroll(ctx: BrollContext, broll: BrollOptions, storyboard: Storyboard, durationSec: number, complete: Complete): Promise<Storyboard> {
  try {
    const deps = resolveDeps(ctx, broll);
    const budget = makeBudget({ meter: ctx.meter, budgetYuan: broll.budgetYuan, reserveYuan: ctx.reserveYuan, capYuan: brollCapYuan(durationSec) });
    const res = await fulfillVisuals(storyboard, deps, {
      workDir: ctx.workDir, durationSec, maxVideos: broll.maxVideos, budgetYuan: broll.budgetYuan, meter: ctx.meter, reserveYuan: ctx.reserveYuan,
      signal: ctx.signal, afford: budget.canAfford, ...(ctx.deferShots ? { deferShots: ctx.deferShots } : {}),
      ...progressHooks(ctx, visualsOf(storyboard).length),
    });
    budget.note(res.costYuan);
    recordCardAssets(ctx.workDir, res.assets);
    const placed = await placeBroll(ctx, beatsCtx(ctx, deps, budget, durationSec), res.storyboard);
    const video = await upgradeToVideo(placed.storyboard, res.videoWanted, deps, { workDir: ctx.workDir, maxVideos: broll.maxVideos, afford: budget.canAfford, signal: ctx.signal, onStatus: videoStatus(ctx) });
    video.assets.forEach((a) => budget.note(a.cost ?? 0));
    recordCardAssets(ctx.workDir, video.assets);
    return finishBroll(ctx, { ...placed, storyboard: video.storyboard, notes: [...placed.notes, ...video.skipped] }, [...res.assets, ...video.assets], [...res.failures, ...video.failures.map((reason) => ({ shotIndex: -1, reason }))], budget, durationSec, complete);
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    const fallback = withoutBroll(storyboard, durationSec);
    complete('broll', `素材获取失败，已去掉待取素材的需求（图片卡改为全屏人像）：${err instanceof Error ? err.message : String(err)}`, { storyboard: fallback });
    return fallback;
  }
}

/** 归一化 → 规则复检 → credits.json → 记录并汇总 */
function finishBroll(ctx: BrollContext, placed: Shots, assets: BrollAsset[], failures: { shotIndex: number; reason: string }[], budget: BrollBudget, durationSec: number, complete: Complete): Storyboard {
  const final = finalize(placed.storyboard, ctx.workDir, durationSec);
  const issues = recheck(final, durationSec);
  writeCredits(final, ctx.workDir, ctx.creditsDir ?? ctx.workDir);
  const mix = brollMix(final, ctx.workDir);
  const spent = budget.spent();
  const placedCount = placed.records.filter((r) => r.status === 'placed').length;
  ctx.onProgress?.({ step: 'broll', message: `B-roll 复检：${issues.length === 0 ? '通过' : issues.join('；')}`, detail: brollDetail({ phase: 'done', spentYuan: spent, mix, placed: placedCount, beats: placed.records.length, issues }) });
  const notes = placed.notes.length > 0 ? ` · ${placed.notes.join('；')}` : '';
  complete('broll', `${mixSummary(mix, placedCount, placed.records.length, spent, failures.length)}${notes}`, {
    storyboard: final,
    broll: { assets, failures, costYuan: spent, beats: placed.records, issues },
  });
  return final;
}

/**
 * 分镜之后的素材步骤：开启时取素材；关闭（或未配置）时去掉待取素材的卡片，
 * 仅当分镜因此变化时才记录一次 broll 步骤，没有素材需求的老流程不受影响。
 */
export async function runBroll(ctx: BrollContext, storyboard: Storyboard, durationSec: number, complete: Complete): Promise<Storyboard> {
  if (ctx.broll?.enabled) return fetchBroll(ctx, ctx.broll, storyboard, durationSec, complete);
  const stripped = withoutBroll(storyboard, durationSec);
  if (JSON.stringify(stripped) === JSON.stringify(storyboard)) return storyboard;
  complete('broll', '素材获取已关闭，已去掉待取素材的需求（图片卡改为全屏人像）', { storyboard: stripped });
  return stripped;
}
