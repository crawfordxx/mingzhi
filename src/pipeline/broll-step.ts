import type { AppConfig } from '../config.js';
import { fulfillVisuals, makeDeps, type BrollAsset, type BrollDeps } from '../broll/fulfill.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import type { Shot, Storyboard } from '../storyboard/schema.js';
import { visualsOf } from '../storyboard/visuals.js';
import type { ProgressEvent } from './run.js';
import type { ProjectFile, ProjectPatch } from './project.js';

/** B-roll 选项：enabled 为 false 时不取任何素材 */
export interface BrollOptions { enabled: boolean; maxVideos: number; budgetYuan: number; pexelsKey?: string }
export interface BrollContext {
  workDir: string;
  cfg: AppConfig;
  broll?: BrollOptions;
  /** 仅供测试注入；缺省时用可想 task 与可想 key 构造真实依赖 */
  brollDeps?: BrollDeps;
  task?: TaskClient;
  onProgress?: (e: ProgressEvent) => void;
}
type Complete = (step: 'broll', message: string, patch?: ProjectPatch) => ProjectFile;

const SOURCE_LABEL: Record<BrollAsset['source'], string> = { screenshot: '截图', generate: '生图', pexels: '图库', video: '视频' };
const NEED_TASK = '取 B-roll 素材需要可想 AI key，请设置环境变量 MINGZHI_KX_KEY，或用 --no-broll 关闭';

const DEFAULT_MAX_VIDEOS = 1;
const DEFAULT_BUDGET_YUAN = 10;

/** 解析非负数命令行参数；缺省用默认值，非法时报错并写明参数名 */
function parseNonNegative(raw: string | undefined, fallback: number, flag: string, integer: boolean): number {
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (raw.trim() === '' || !Number.isFinite(n) || n < 0 || (integer && !Number.isInteger(n))) throw new Error(`${flag} 需要${integer ? '非负整数' : '非负数'}，收到「${raw}」`);
  return n;
}

/** CLI 参数 → B-roll 选项：默认开启，最多 1 个视频，预算 10 元；图库 key 来自 MINGZHI_PEXELS_KEY */
export function parseBrollArgs(values: { 'no-broll'?: boolean; 'max-videos'?: string; budget?: string }, env: NodeJS.ProcessEnv): BrollOptions {
  const pexelsKey = env.MINGZHI_PEXELS_KEY || undefined;
  return {
    enabled: !values['no-broll'],
    maxVideos: parseNonNegative(values['max-videos'], DEFAULT_MAX_VIDEOS, '--max-videos', true),
    budgetYuan: parseNonNegative(values.budget, DEFAULT_BUDGET_YUAN, '--budget', false),
    ...(pexelsKey ? { pexelsKey } : {}),
  };
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
  return normalizeStoryboard({ shots: storyboard.shots.map(stripVisual) }, durationSec, []).storyboard;
}

/** 单个素材的进度文案（只回调、不写 project.json） */
function assetMessage(done: number, total: number, a: BrollAsset | { key: string; failed: string }): string {
  const head = `素材 ${done}/${total}`;
  return 'failed' in a ? `${head} 失败：${a.failed}` : `${head} ${SOURCE_LABEL[a.source]} ${a.file}`;
}

function resolveDeps(ctx: BrollContext, broll: BrollOptions): BrollDeps {
  if (ctx.brollDeps) return ctx.brollDeps;
  if (!ctx.task) throw new Error(NEED_TASK);
  return makeDeps({ apiKey: ctx.cfg.kexiangKey ?? '', task: ctx.task, cfg: ctx.cfg, pexelsKey: broll.pexelsKey });
}

/** 开启时按分镜取素材并写回；整步异常不中断出片，降级为去掉待取素材的分镜 */
async function fetchBroll(ctx: BrollContext, broll: BrollOptions, storyboard: Storyboard, durationSec: number, complete: Complete): Promise<Storyboard> {
  const total = visualsOf(storyboard).length;
  let done = 0;
  try {
    const res = await fulfillVisuals(storyboard, resolveDeps(ctx, broll), {
      workDir: ctx.workDir, durationSec, maxVideos: broll.maxVideos, budgetYuan: broll.budgetYuan,
      onAsset: (a) => { done += 1; ctx.onProgress?.({ step: 'broll', message: assetMessage(done, total, a) }); },
    });
    complete('broll', brollSummary(res.assets, res.failures.length, res.costYuan),
      { storyboard: res.storyboard, broll: { assets: res.assets, failures: res.failures, costYuan: res.costYuan } });
    return res.storyboard;
  } catch (err) {
    const fallback = withoutBroll(storyboard, durationSec);
    complete('broll', `素材获取失败，已去掉需要素材的卡片：${err instanceof Error ? err.message : String(err)}`, { storyboard: fallback });
    return fallback;
  }
}

/**
 * 分镜之后的素材步骤：开启时取素材；关闭（或未配置）时去掉待取素材的卡片，
 * 仅当分镜因此变化时才记录一次 broll 步骤，没有素材需求的老流程不受影响。
 */
export async function runBroll(ctx: BrollContext, storyboard: Storyboard, durationSec: number, complete: Complete): Promise<Storyboard> {
  if (ctx.broll?.enabled) return fetchBroll(ctx, ctx.broll, storyboard, durationSec, complete);
  const stripped = withoutBroll(storyboard, durationSec);
  if (JSON.stringify(stripped) === JSON.stringify(storyboard)) return storyboard;
  complete('broll', '素材获取已关闭，已去掉需要素材的卡片', { storyboard: stripped });
  return stripped;
}
