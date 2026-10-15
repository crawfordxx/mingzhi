/**
 * 卡片数字校验：卡片文字里的数字（含百分比、倍数、时长）必须能在口播（字幕）里找到，找不到的是模型编的。
 * 编造的字段去掉；去掉后卡片不合模式（必填字段被去掉、列表不够条数）时降级为不含数字的标题卡，连标题都没有就丢掉卡片。
 */
import { numberMentions, supported } from './numbers.js';
import { CardSpecSchema, ShotSchema, type CardSpec } from './schema.js';

/** 素材与网址字段里的数字是文件名、网址，不检查 */
const SKIP_KEYS = new Set(['image', 'video', 'visual', 'url']);
/** 降级标题按这个顺序取第一个干净的字段 */
const TITLE_KEYS = ['headline', 'title', 'label'] as const;

/** 文字里口播找不到依据的数字（按出现顺序，返回卡片里的原文片段） */
export function unsupportedNumbers(text: string, source: string): string[] {
  const sources = numberMentions(source, 'source');
  return numberMentions(text, 'card').filter((m) => !supported(m, sources)).map((m) => m.text);
}

interface Pruned { value: unknown; removed: string[] }

/** 去掉含编造数字的字段：字符串整段去掉，数组去掉坏元素，对象逐字段处理；返回 undefined 表示整个去掉 */
function prune(value: unknown, source: string): Pruned {
  if (typeof value === 'string') {
    const bad = unsupportedNumbers(value, source);
    return { value: bad.length > 0 ? undefined : value, removed: bad };
  }
  if (Array.isArray(value)) {
    const parts = value.map((v) => prune(v, source));
    return { value: parts.flatMap((p) => (p.value === undefined ? [] : [p.value])), removed: parts.flatMap((p) => p.removed) };
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).map(([k, v]) => [k, SKIP_KEYS.has(k) ? { value: v, removed: [] } : prune(v, source)] as const);
    const kept = Object.fromEntries(entries.filter(([, p]) => p.value !== undefined).map(([k, p]) => [k, p.value]));
    return { value: kept, removed: entries.flatMap(([, p]) => p.removed) };
  }
  return { value, removed: [] };
}

/** 降级：原卡片里第一个不含编造数字的标题类字段做成标题卡 */
function fallbackTitle(card: CardSpec, source: string): CardSpec | null {
  const props = card.props as Record<string, unknown>;
  const text = TITLE_KEYS.map((k) => props[k]).find((v): v is string => typeof v === 'string' && unsupportedNumbers(v, source).length === 0);
  if (!text) return null;
  const parsed = CardSpecSchema.safeParse({ template: 'title', props: { title: text } });
  return parsed.success ? parsed.data : null;
}

/** 一张卡片的数字校验：返回清理后的卡片（null = 丢掉）与去掉的数字 */
export function checkCardFacts(card: CardSpec, source: string): { card: CardSpec | null; removed: string[] } {
  const { value, removed } = prune(card.props, source);
  if (removed.length === 0) return { card, removed };
  const parsed = CardSpecSchema.safeParse({ template: card.template, props: value });
  return { card: parsed.success ? parsed.data : fallbackTitle(card, source), removed };
}

/** 整条分镜（模型原始输出）逐镜头校验；不合模式的镜头原样留给归一化处理，卡片被丢掉的镜头改为全屏 */
export function checkStoryboardFacts(raw: unknown, source: string): { raw: unknown; removed: string[] } {
  const items = (raw as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(items)) return { raw, removed: [] };
  const checked = items.map((item) => {
    const shot = ShotSchema.safeParse(item);
    if (!shot.success || !shot.data.card) return { item, removed: [] as string[] };
    const res = checkCardFacts(shot.data.card as CardSpec, source);
    if (res.removed.length === 0) return { item, removed: res.removed };
    const { card: _old, ...rest } = shot.data;
    return { item: res.card ? { ...rest, card: res.card } : { ...rest, layout: 'full' }, removed: res.removed };
  });
  return { raw: { ...(raw as object), shots: checked.map((c) => c.item) }, removed: checked.flatMap((c) => c.removed) };
}
