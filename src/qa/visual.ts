import { readFileSync, rmSync } from 'node:fs';
import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import type { CostMeter } from '../cost/meter.js';
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

从四个维度各打 1-10 分的整数（1 很差，5 勉强能用，8 达到发布水准，10 无可挑剔）：
- layout 版式：对齐、留白是否得当，文字有没有溢出卡片、被截断或互相遮挡。
- hierarchy 层级：主次是否清楚，一眼能不能读到重点。
- motion 动效节奏：只看三帧里看得到的东西——卡片内部元素的展开进度应当从第一帧到第二帧明显推进（如文字逐步出现、数字滚动、条形增长），到第三帧已经完整且稳定；第一帧就全部就位（没有推进）、第三帧仍未展开完或内容不稳定都要扣分。
- brand 品牌一致性：是否符合米色底、白色卡片、指定标签色、字体统一的视觉语言。

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

/** 让视觉模型给三联图打分；返回不合格式时抛错 */
export async function scoreCard(client: LlmClient, stripPng: string, card: CardSpec): Promise<CardScore> {
  const image = `data:image/png;base64,${readFileSync(stripPng).toString('base64')}`;
  const raw = await client.chatJson({
    model: QA_MODEL, system: SCORE_SYSTEM, user: `卡片数据：${JSON.stringify(card)}`,
    images: [image], reasoningEffort: 'low', label: '卡片视觉自检',
  });
  const parsed = ScoreSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`卡片打分结果格式不对：${parsed.error.issues[0]?.message ?? '未知'}`);
  return parsed.data;
}

export interface QaCardsOptions {
  client: LlmClient; workDir: string; storyboard: Storyboard; captions: TimedCaption[]; meter: CostMeter; onProgress?: (msg: string) => void;
}

const captionsIn = (captions: TimedCaption[], shot: Shot): TimedCaption[] => captions.filter((c) => c.end > shot.start && c.start < shot.end);

/** 评分一个版本：复用打包渲染三帧再打分，打完分就删掉三联图 */
async function evaluate(opts: QaCardsOptions, serveUrl: string, shot: Shot, card: CardSpec): Promise<Version> {
  const strip = await renderCardFrames(opts.workDir, card, shot.end - shot.start, serveUrl);
  try {
    return { card, score: await scoreCard(opts.client, strip, card) };
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
      if (!opts.meter.canSpend(STEP_BUDGET_YUAN)) { skipped = '预算不足，停止检查'; break; }
      const version = await evaluate(opts, serveUrl, shot, card);
      versions.push(version);
      scores.push(version.score);
      opts.onProgress?.(`第 ${index + 1} 镜卡片自检：版式 ${version.score.layout} 层级 ${version.score.hierarchy} 动效 ${version.score.motion} 品牌 ${version.score.brand}`);
      if (isPass(version.score) || revised >= MAX_REVISIONS) break;
      if (!opts.meter.canSpend(STEP_BUDGET_YUAN)) { skipped = '预算不足，停止重写'; break; }
      const base = versions.reduce(better);
      const next = await reviseCard(opts.client, { ...shot, card: base.card }, captionsIn(opts.captions, shot), base.score, images);
      if (!next) { skipped = '重写结果无效，保留现有版本'; break; }
      revised += 1;
      card = next;
    }
  } catch (err) {
    skipped = `自检失败：${err instanceof Error ? err.message : String(err)}`;
  }
  const best = versions.reduce<Version | undefined>((a, b) => (a ? better(a, b) : b), undefined);
  const passed = best !== undefined && isPass(best.score);
  return { entry: { shotIndex: index, scores, revised, passed, ...(skipped ? { skipped } : {}) }, card: best?.card ?? (shot.card as CardSpec) };
}

/** 逐个检查分屏卡片，返回替换后的分镜与报告；打包、检查或重写出错只标注、不中断，保留原卡片 */
export async function qaCards(opts: QaCardsOptions): Promise<{ storyboard: Storyboard; report: CardQaEntry[] }> {
  const images = usedImages(opts.storyboard);
  const cards = new Map<number, CardSpec>();
  const report: CardQaEntry[] = [];
  const targets = opts.storyboard.shots.flatMap((s, i) => (s.layout === 'split' && s.card ? [i] : []));
  if (targets.length > 0) {
    try {
      // 全部卡片共用一次打包
      await withBundle(opts.workDir, async (serveUrl) => {
        for (const index of targets) {
          if (!opts.meter.canSpend(STEP_BUDGET_YUAN)) {
            report.push({ shotIndex: index, scores: [], revised: 0, passed: false, skipped: '预算不足，未检查' });
            continue;
          }
          const { entry, card } = await checkOne(opts, serveUrl, index, images);
          report.push(entry);
          cards.set(index, card);
        }
      });
    } catch (err) {
      const skipped = `打包失败：${err instanceof Error ? err.message : String(err)}`;
      return { storyboard: opts.storyboard, report: targets.map((shotIndex) => ({ shotIndex, scores: [], revised: 0, passed: false, skipped })) };
    }
  }
  const shots = opts.storyboard.shots.map((s, i): Shot => (cards.has(i) ? { ...s, card: cards.get(i) } : s));
  return { storyboard: { ...opts.storyboard, shots }, report };
}
