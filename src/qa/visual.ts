import { readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import type { CostMeter } from '../cost/meter.js';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { renderCardFrames, withBundle } from '../compose/render.js';
import { reviseCard } from '../storyboard/revise.js';
import type { CardSpec, Shot, Storyboard } from '../storyboard/schema.js';

export const QA_MODEL = 'google/gemini-3.5-flash';
/** 四个维度都不低于此分才算通过 */
export const PASS_SCORE = 8;
export const MAX_REVISIONS = 2;
/** 每次打分或重写前，预算至少要剩这么多（一次视觉调用的大致花费，元） */
const STEP_BUDGET_YUAN = 0.05;

export interface CardScore { layout: number; hierarchy: number; motion: number; brand: number; notes: string }

export interface CardQaEntry { shotIndex: number; scores: CardScore[]; revised: number; passed: boolean; /** 未检查或中途停止的原因 */ skipped?: string }

const MIN_DIMENSION = 1;
const MAX_DIMENSION = 10;
/** 模型有时把分数写成字符串或小数：数字字符串转成数字，四舍五入并夹在 1-10；缺失或不是数字才算格式错误 */
const dimension = z.preprocess(
  (v) => (typeof v === 'string' && v.trim() !== '' ? Number(v) : v),
  z.number().finite().transform((n) => Math.min(MAX_DIMENSION, Math.max(MIN_DIMENSION, Math.round(n)))),
);
const ScoreSchema = z.object({ layout: dimension, hierarchy: dimension, motion: dimension, brand: dimension, notes: z.string().default('') });

const SCORE_SYSTEM = `你是短视频信息卡片的视觉评审。图片只含这张卡片本身，是同一张卡片的三个时刻，从左到右依次是：镜头开头后 0.3 秒、镜头中点、镜头结束前 0.3 秒。

先理解三帧：第一帧通常还在进场中途——文字从遮罩下方滑上来时下半截被遮住、元素半透明或还在位移，这是正常的进场动画，不算截断或乱码，也不算重叠。第二、三帧是定稿状态。

从四个维度各打 1-10 分的整数（1 很差，5 勉强能用，8 达到发布水准，10 无可挑剔）：
- layout 版式：按第二、三帧评——对齐、留白是否得当，文字有没有溢出卡片、被截断或互相遮挡。
- hierarchy 层级：按第二、三帧评——主次是否清楚，一眼能不能读到重点；字数要和镜头时长相称（按每秒读 5 个字估算，镜头里读不完要扣分）。
- motion 动效节奏：只看三帧里看得到的东西。成片里整张卡片还有统一的进场（从下方弹入，约 0.5 秒），这三帧里看不到它。
  有逐条展开内容的卡片（清单逐行出现、数字滚动、条形增长、开关切换等）：展开进度应当从第一帧到第二帧明显推进、第三帧已完整稳定，没有推进或第三帧仍未展开完要扣分。
  内容本来就是静态的卡片（只有标题、一张图配一行字）：不因第一帧已完整扣分，三帧稳定、不跳变就算合格，只在第三帧仍未就位、内容抖动或跳变时扣分。
- brand 品牌一致性：是否符合本套视觉语言——普通卡片是米色底、白色卡片；开场 hook 卡是黑底（或压暗的配图）配荧光黄绿强调，终端卡是深灰底，这些深色属于正常设计，不因底色扣分；另看标签色、字体是否统一。

请挑剔一些：默认不超过 7 分，只有确实无可挑剔才给 8 及以上。
notes 用一两句中文写出最主要的问题和修改方向；都没问题就写“无”。
只输出 JSON，不要任何多余文字：{"layout":整数,"hierarchy":整数,"motion":整数,"brand":整数,"notes":"评语"}`;

interface Version { card: CardSpec; score: CardScore }

const scoreSum = (s: CardScore): number => s.layout + s.hierarchy + s.motion + s.brand;
const isPass = (s: CardScore): boolean => Math.min(s.layout, s.hierarchy, s.motion, s.brand) >= PASS_SCORE;
/** 版本排序：通过的优先，其次总分高，再相同保留先出现的 */
const better = (a: Version, b: Version): Version => {
  if (isPass(a.score) !== isPass(b.score)) return isPass(a.score) ? a : b;
  return scoreSum(a.score) >= scoreSum(b.score) ? a : b;
};

/** 让视觉模型给三联图打分（带上镜头时长，供评估字数是否读得完）；返回不合格式时抛错 */
export async function scoreCard(client: LlmClient, stripPng: string, card: CardSpec, durationSec?: number): Promise<CardScore> {
  const image = `data:image/png;base64,${readFileSync(stripPng).toString('base64')}`;
  const duration = durationSec === undefined ? '' : `镜头时长：${durationSec.toFixed(1)} 秒\n`;
  const raw = await client.chatJson({
    model: QA_MODEL, system: SCORE_SYSTEM, user: `${duration}卡片数据：${JSON.stringify(card)}`,
    images: [image], reasoningEffort: 'low', label: '卡片视觉自检',
  });
  const parsed = ScoreSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`卡片打分结果格式不对：${parsed.error.issues[0]?.message ?? '未知'}`);
  return parsed.data;
}

export interface QaCardsOptions {
  client: LlmClient; workDir: string; storyboard: Storyboard; captions: TimedCaption[]; meter: CostMeter;
  /** 拼三联图用的 ffmpeg 路径 */
  ffmpeg: string;
  /** 给后续步骤（封面）预留的花费（元），每次预算检查一并扣除，缺省 0 */
  reserveYuan?: number;
  /** 取消信号：每张卡片、每次打分前检查，取消时抛 CancelledError */
  signal?: AbortSignal;
  /** 只检查这些镜头序号的卡片（工作台新版本只检查改动过的卡片）；缺省检查全部分屏卡片 */
  only?: number[];
  /** 只打分、不重写的镜头序号：用户在对话里指定的卡片，重写会换掉用户要的模板和文字，回复就和成片对不上了 */
  keep?: number[];
  /** msg 是给人看的进度文案；info 带本次打分的结构化数据，供工作台直播 */
  onProgress?: (msg: string, info?: { shotIndex: number; attempt: number; score: CardScore; passed: boolean }) => void;
}

/** 再花一次视觉调用（并为封面留出预留）是否仍在预算内 */
const canAffordStep = (opts: QaCardsOptions): boolean => opts.meter.canSpend(STEP_BUDGET_YUAN + (opts.reserveYuan ?? 0));
/** 预算不足时的原因后缀：有预留时写明，免得误以为总预算耗尽 */
const reserveNote = (opts: QaCardsOptions): string => ((opts.reserveYuan ?? 0) > 0 ? `（已为封面预留 ¥${(opts.reserveYuan ?? 0).toFixed(2)}）` : '');

const KEEP_NOTE = '你指定的卡片只打分、不重写';

const captionsIn = (captions: TimedCaption[], shot: Shot): TimedCaption[] => captions.filter((c) => c.end > shot.start && c.start < shot.end);

/** 评分一个版本：复用打包渲染三帧再打分，打完分就删掉三联图 */
async function evaluate(opts: QaCardsOptions, serveUrl: string, shot: Shot, card: CardSpec): Promise<Version> {
  const strip = await renderCardFrames(opts.workDir, card, shot.end - shot.start, opts.ffmpeg, serveUrl);
  try {
    return { card, score: await scoreCard(opts.client, strip, card, shot.end - shot.start) };
  } finally {
    rmSync(strip, { force: true });
  }
}

/** 分镜里用到的素材文件，重写时只允许用这些 */
function usedImages(storyboard: Storyboard): string[] {
  const files = storyboard.shots.flatMap((s) => {
    const p = (s.card?.props ?? {}) as { image?: string; video?: string };
    return [p.image, p.video].filter((f): f is string => typeof f === 'string');
  });
  return [...new Set(files)];
}

/** 单个分屏卡片：打分 → 不过线则以目前最好的版本为基础重写（最多 MAX_REVISIONS 次）→ 保留通过的或得分最高的版本 */
async function checkOne(opts: QaCardsOptions, serveUrl: string, index: number, images: string[]): Promise<{ entry: CardQaEntry; card: CardSpec }> {
  const shot = opts.storyboard.shots[index];
  const scores: CardScore[] = [];
  const versions: Version[] = [];
  let skipped: string | undefined;
  let revised = 0;
  let card = shot.card as CardSpec;
  try {
    for (;;) {
      throwIfCancelled(opts.signal);
      if (!canAffordStep(opts)) { skipped = `预算不足，停止检查${reserveNote(opts)}`; break; }
      const version = await evaluate(opts, serveUrl, shot, card);
      versions.push(version);
      scores.push(version.score);
      const s = version.score;
      const line = `第 ${index + 1} 镜卡片自检：版式 ${s.layout} 层级 ${s.hierarchy} 动效 ${s.motion} 品牌 ${s.brand}`;
      opts.onProgress?.(line, { shotIndex: index, attempt: scores.length, score: s, passed: isPass(s) });
      if (isPass(version.score) || revised >= MAX_REVISIONS) break;
      if (opts.keep?.includes(index)) { skipped = KEEP_NOTE; break; }
      if (!canAffordStep(opts)) { skipped = `预算不足，停止重写${reserveNote(opts)}`; break; }
      const base = versions.reduce(better);
      const next = await reviseCard(opts.client, { ...shot, card: base.card }, captionsIn(opts.captions, shot), base.score, images);
      if (!next) { skipped = '重写结果无效，保留现有版本'; break; }
      revised += 1;
      card = next;
    }
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    skipped = `自检失败：${err instanceof Error ? err.message : String(err)}`;
  }
  const best = versions.reduce<Version | undefined>((a, b) => (a ? better(a, b) : b), undefined);
  const passed = best !== undefined && isPass(best.score);
  return { entry: { shotIndex: index, scores, revised, passed, ...(skipped ? { skipped } : {}) }, card: best?.card ?? (shot.card as CardSpec) };
}

/** 打包失败：分镜原样返回，每个目标镜头都标注原因 */
function failedBundle(opts: QaCardsOptions, targets: number[], err: unknown): { storyboard: Storyboard; report: CardQaEntry[] } {
  const skipped = `打包失败：${err instanceof Error ? err.message : String(err)}`;
  return { storyboard: opts.storyboard, report: targets.map((shotIndex) => ({ shotIndex, scores: [], revised: 0, passed: false, skipped })) };
}

/** 逐个检查分屏卡片，返回替换后的分镜与报告；打包、检查或重写出错只标注、不中断，保留原卡片 */
export async function qaCards(opts: QaCardsOptions): Promise<{ storyboard: Storyboard; report: CardQaEntry[] }> {
  const images = usedImages(opts.storyboard);
  const cards = new Map<number, CardSpec>();
  const report: CardQaEntry[] = [];
  const targets = opts.storyboard.shots.flatMap((s, i) => (s.layout === 'split' && s.card && (!opts.only || opts.only.includes(i)) ? [i] : []));
  if (targets.length > 0) {
    let checked = false; // 逐张检查已全部跑完（此后 withBundle 再抛错只可能是清理打包目录失败）
    try {
      // 全部卡片共用一次打包
      await withBundle(opts.workDir, async (serveUrl) => {
        for (const index of targets) {
          throwIfCancelled(opts.signal);
          if (!canAffordStep(opts)) {
            report.push({ shotIndex: index, scores: [], revised: 0, passed: false, skipped: `预算不足，未检查${reserveNote(opts)}` });
            continue;
          }
          const { entry, card } = await checkOne(opts, serveUrl, index, images);
          report.push(entry);
          cards.set(index, card);
        }
        checked = true;
      });
    } catch (err) {
      rethrowIfBalance(err);
      rethrowIfCancelled(err);
      // 检查结果已经花了钱：清理失败时保留结果，只在进度里说明
      if (checked) opts.onProgress?.(`卡片自检的打包目录清理失败（检查结果已保留）：${err instanceof Error ? err.message : String(err)}`);
      else return failedBundle(opts, targets, err);
    }
  }
  const shots = opts.storyboard.shots.map((s, i): Shot => (cards.has(i) ? { ...s, card: cards.get(i) } : s));
  return { storyboard: { ...opts.storyboard, shots }, report };
}
