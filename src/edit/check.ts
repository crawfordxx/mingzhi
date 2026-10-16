import { MAX_DISPLAY_WIDTH, displayWidth } from '../captions/lines.js';
import { MOODS, type CardSpec, type Layout, type TemplateId } from '../storyboard/schema.js';
import type { EditContext } from './context.js';
import { VISUAL_SOURCES, type EditOp } from './ops.js';

/** 换上去的卡片不能自带素材文件（文件名是编造的，路径还可能越界），素材只能靠 visual 去取；photo 没有素材来源就是空卡 */
export function checkCard(card: CardSpec): string | null {
  const p = card.props as { image?: unknown; video?: unknown; visual?: unknown };
  if (p.image !== undefined || p.video !== undefined) return '卡片不能自带 image / video 文件，需要素材请用 visual 描述';
  if (card.template === 'photo' && p.visual === undefined) return 'photo 卡片需要 visual 才能取到素材';
  return null;
}

/**
 * 镜头能不能换成某个版式（预检与执行共用）：cta 只能全屏；全屏插入、画中画要有 B-roll 素材；
 * 浮层要有卡片或素材；分屏要有卡片或素材（无卡片时上半屏铺素材）
 */
export function layoutBlocker(layout: Layout, shot: { template?: string; broll: boolean }): string | null {
  if (layout === 'full') return null;
  if (shot.template === 'cta') return 'cta 卡片只能全屏';
  if ((layout === 'broll' || layout === 'pip') && !shot.broll) return '该镜头没有 B-roll 素材，不能改成全屏插入或画中画';
  if (layout === 'overlay' && !shot.template && !shot.broll) return '该镜头没有卡片或素材，不能改成浮层';
  if (layout === 'split' && !shot.template && !shot.broll) return '该镜头没有卡片，不能改成分屏';
  return null;
}

const shotMissing = (i: number, ctx: EditContext): string | null => (i < ctx.shots.length ? null : `没有第 ${i} 个镜头`);

function checkVisual(op: Extract<EditOp, { type: 'regenerateVisual' }>, ctx: EditContext): string | null {
  const missing = shotMissing(op.shotIndex, ctx);
  if (missing) return missing;
  const template = ctx.shots[op.shotIndex].template as TemplateId | undefined;
  const allowed = template ? VISUAL_SOURCES[template] : undefined;
  if (!allowed) return '该镜头的卡片不支持素材';
  return allowed.includes(op.visual.source) ? null : `「${template}」卡片不支持来源「${op.visual.source}」`;
}

/** 字幕文字不能超过每行显示宽度上限 */
export const captionTooLong = (text: string): string | null => (
  displayWidth(text) > MAX_DISPLAY_WIDTH ? `字幕太长（每行最多约 ${MAX_DISPLAY_WIDTH - 1} 个汉字）` : null
);

/** 操作与当前版本对不上（序号越界、预设不存在、卡片带素材文件等）时返回中文原因，合法返回 null */
export function checkOp(op: EditOp, ctx: EditContext): string | null {
  switch (op.type) {
    case 'setBackground': {
      const { spec } = op;
      return spec.kind === 'preset' && !ctx.presets.some((p) => p.id === spec.id) ? `没有预设背景「${spec.id}」` : null;
    }
    case 'setBgm':
      return ['auto', 'none', ...MOODS, ...ctx.tracks.map((t) => t.id)].includes(op.bgm) ? null : `没有配乐「${op.bgm}」`;
    case 'replaceCard':
      return shotMissing(op.shotIndex, ctx) ?? checkCard(op.card);
    case 'setLayout': {
      const shot = ctx.shots[op.shotIndex];
      if (!shot) return shotMissing(op.shotIndex, ctx);
      return layoutBlocker(op.layout, { template: shot.template, broll: shot.broll === true });
    }
    case 'regenerateVisual':
      return checkVisual(op, ctx);
    case 'editCaption':
      return op.index >= ctx.captions.length ? `没有第 ${op.index} 句字幕` : captionTooLong(op.text);
    case 'removeSpan':
      return op.toSec > op.fromSec && op.fromSec < ctx.outputDurationSec ? null : '时间范围不在成片内';
    case 'restoreSpan':
      return op.toSec > op.fromSec && op.fromSec < ctx.sourceDurationSec ? null : '时间范围不在原片内';
    default:
      return null;
  }
}
