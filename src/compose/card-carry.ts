/**
 * 卡片交叉过渡：上一个镜头的卡片不在自己结束前淡出，而是延续到下一个镜头开头 CARD_XFADE_SEC 秒里淡出，
 * 同时下一张卡片照常从镜头起点进场——两张重叠 CARD_XFADE_SEC 秒，任何一帧上半屏都不会闪空。
 * 下一个镜头是全屏插入或画中画（素材铺满）时硬切，不延续。渲染（CardLayer）与分段指纹（segments）共用
 */
import { shotAt, visualLayout } from './layout.js';
import type { Shot } from '../storyboard/schema.js';

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

/** 第 index 个镜头卡片内部时钟的提前量（秒）：从无卡镜头切进分屏为 FRESH_LEAD_SEC，其余为 0。shots 为画面时间轴 */
export function cardLead(shots: Shot[], index: number): number {
  const shot = shots[index];
  const prev = shots[index - 1];
  return shot && prev && visualLayout(shot) === 'split' && !drawsCard(prev) ? FRESH_LEAD_SEC : 0;
}
