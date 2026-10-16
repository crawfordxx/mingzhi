/**
 * 卡片交叉过渡：上一个镜头的卡片不在自己结束前淡出，而是延续到下一个镜头开头 CARD_XFADE_SEC 秒里淡出，
 * 同时下一张卡片照常从镜头起点进场——两张重叠 CARD_XFADE_SEC 秒，任何一帧上半屏都不会闪空。
 * 下一个镜头是全屏插入或画中画（素材铺满）时硬切，不延续。渲染（CardLayer）与分段指纹（segments）共用
 */
import { shotAt, visualLayout } from './layout.js';
import type { Shot, TemplateId } from '../storyboard/schema.js';

export const CARD_XFADE_SEC = 0.3;

/** 镜头在卡片层上有没有东西可画：分屏（卡片区底与卡片）、浮层（卡片或素材小窗）、全屏只有 cta */
export function drawsCard(shot: Shot): boolean {
  const layout = visualLayout(shot);
  if (layout === 'split') return true;
  if (layout === 'overlay') return Boolean(shot.card || shot.broll);
  return layout === 'full' && shot.card?.template === 'cta';
}

/** sec 时刻仍在淡出的上一个镜头：index 为它的序号，t 为淡出进度（0 刚开始 → 1 结束）；没有则 null。shots 为画面时间轴 */
export function cardCarry(shots: Shot[], sec: number): { index: number; t: number } | null {
  const hit = shotAt(shots, sec);
  if (!hit || hit.index === 0) return null;
  const t = (sec - hit.shot.start) / CARD_XFADE_SEC;
  const prev = shots[hit.index - 1];
  const layout = visualLayout(hit.shot);
  if (t >= 1 - 1e-9 || layout === 'broll' || layout === 'pip' || !drawsCard(prev)) return null;
  return { index: hit.index - 1, t: Math.max(0, t) };
}

/**
 * 从没有卡片的镜头（人物全屏等）切进分屏时，卡片内部时钟提前这么多秒：第 0 帧标题与首行已就位，不是先出一张空白卡再长内容。
 * 卡片内部动作（逐条出现、勾选、计数等）因此比镜头内秒数早 FRESH_LEAD_SEC；音效计划对这些镜头的内部触发点应同样提前（cardLead）
 */
export const FRESH_LEAD_SEC = 0.4;

/**
 * 第 index 个镜头卡片内部时钟的提前量（秒）：镜头给了 lead（延续前段的卡片）就用它；从无卡镜头切进分屏为 FRESH_LEAD_SEC；
 * 被遮罩擦除进来的卡为 WIPE_LEAD_SEC（擦除边缘扫过时内容已就位，不是边擦边长）；其余为 0。shots 为画面时间轴
 */
export function cardLead(shots: Shot[], index: number): number {
  const shot = shots[index];
  if (shot?.lead !== undefined) return shot.lead;
  const prev = shots[index - 1];
  if (shot && prev && visualLayout(shot) === 'split' && !drawsCard(prev)) return FRESH_LEAD_SEC;
  return carryStyle(shots, index).kind === 'wipe' ? WIPE_LEAD_SEC : 0;
}

/**
 * 卡片的结构类：同一类的卡片版面骨架相近（都是竖排清单、都是一句大标题……），相邻时叠化不显脏；
 * 不同类的卡片（对比条 → 流程图）叠化时两套版式会叠在一起出重影，改用遮罩擦除
 */
const STRUCTURE: Record<TemplateId, string> = {
  hook: 'hook', title: 'headline', bigNumber: 'headline', chips: 'grid', toggles: 'list', evidenceList: 'list', strikeList: 'list',
  compareBars: 'chart', flow: 'diagram', terminal: 'window', browser: 'window', photo: 'media', cta: 'cta',
};
export const structureOf = (t: TemplateId): string => STRUCTURE[t];

/** 下一张卡按横向读（流程从左到右、柱条从左往右长、标签横排）时横向擦除，其余（清单、标题、数字）竖向从上往下擦 */
const ACROSS: ReadonlySet<TemplateId> = new Set<TemplateId>(['flow', 'compareBars', 'chips', 'terminal', 'browser']);

/** 擦除与叠化共用同一个窗口（CARD_XFADE_SEC，≤ 0.35 秒）：上一张卡在这段时间里被擦掉，分段指纹不用另记 */
export const WIPE_SEC = CARD_XFADE_SEC;
/** 擦除进来的卡片内部时钟提前量：与擦除同长，擦完时卡片相当于正常进场后 0.3 秒、标题已落位 */
export const WIPE_LEAD_SEC = WIPE_SEC;

export type CarryStyle = { kind: 'fade' } | { kind: 'wipe'; axis: 'x' | 'y' };

/**
 * 第 index 个镜头开头的卡片转场：前后都是带卡片的分屏、模板不同且结构类不同时用遮罩擦除（方向跟下一张卡的阅读方向：
 * 横向从左往右、竖向从上往下，两张卡的文字任何一帧都不叠在一起）；其余叠化。shots 为画面时间轴
 */
export function carryStyle(shots: Shot[], index: number): CarryStyle {
  const [prev, next] = [shots[index - 1], shots[index]];
  if (!prev?.card || !next?.card || visualLayout(prev) !== 'split' || visualLayout(next) !== 'split') return { kind: 'fade' };
  const a = prev.card.template;
  const b = next.card.template;
  if (a === b || structureOf(a) === structureOf(b)) return { kind: 'fade' };
  return { kind: 'wipe', axis: ACROSS.has(b) ? 'x' : 'y' };
}

/** 擦除边缘的位置（0 → 1）：四次方缓入缓出，起止柔、中段快，像一次干脆的推镜 */
export function wipeAt(t: number): number {
  const x = Math.max(0, Math.min(1, t));
  return x < 0.5 ? 8 * x ** 4 : 1 - (-2 * x + 2) ** 4 / 2;
}
