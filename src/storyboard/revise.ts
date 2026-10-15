import type { TimedCaption } from '../captions/lines.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { CardScore } from '../qa/visual.js';
import { CATALOG } from './catalog.js';
import { STORYBOARD_MODEL } from './generate.js';
import { normalizeStoryboard } from './normalize.js';
import { CardSpecSchema, type CardSpec, type Shot } from './schema.js';

const catalogText = CATALOG.map((c) => `- ${c.id}：${c.use}\n  props：${c.props}`).join('\n');

const SYSTEM_PROMPT = `你是短视频口播的分镜导演。上半屏的一张信息卡片经视觉评审后没有达标，请根据评语重新设计这一张卡片。

输出严格的 JSON，不要任何多余文字：{"card":{"template":"模板名","props":{…}}}

规则：
1. 可以换用更合适的模板，也可以在原模板上改字段；针对评语指出的问题修改（溢出就缩短文字或减少条目，层级不清就提炼重点，等等）。
2. 卡片文字是提炼后的信息，不要照抄字幕；数字、专名与字幕保持一致，不要编造字幕里没有的数据。
3. 每个字段严格遵守下面写明的长度上限，超出会被丢弃。
4. 原卡片是 hook 时新卡片仍用 hook，并保留 index、total；原卡片不是 hook 时不要用 hook；不要用 cta。
5. image、video 只能填「可用素材」里的文件名，不要编造；没有合适素材就不要写。本次重写不能申请新素材，忽略模板目录里的 visual 字段。
6. 镜头只有几秒：时长短的镜头少放条目、少写字，让观众来得及读完。

模板目录：
${catalogText}`;

const formatCaptions = (captions: TimedCaption[]): string =>
  captions.length > 0 ? captions.map((c) => `[${c.start.toFixed(2)}-${c.end.toFixed(2)}] ${c.text}`).join('\n') : '无';

function buildUserMessage(card: CardSpec, durationSec: number, captions: TimedCaption[], score: CardScore, images: string[]): string {
  const scoreLine = `版式 ${score.layout}、层级 ${score.hierarchy}、动效节奏 ${score.motion}、品牌一致性 ${score.brand}（满分 10）`;
  return `镜头时长：${durationSec.toFixed(1)} 秒\n当前卡片：${JSON.stringify(card)}\n评分：${scoreLine}\n评语：${score.notes || '无'}\n可用素材：${images.length > 0 ? images.join('，') : '无'}\n该镜头的字幕：\n${formatCaptions(captions)}`;
}

/** hook 的序号由整条分镜决定，换卡片时沿用原来的 index / total */
function keepHookNumbering(next: CardSpec, old: CardSpec): CardSpec {
  return next.template === 'hook' && old.template === 'hook' ? { template: 'hook', props: { ...next.props, index: old.props.index, total: old.props.total } } : next;
}

/** 重写不申请新素材：去掉 visual（photo 因此没有可用素材时会在后面的清理里被丢弃） */
function withoutVisual(card: CardSpec): CardSpec {
  const props = Object.fromEntries(Object.entries(card.props).filter(([k]) => k !== 'visual'));
  return { template: card.template, props } as CardSpec;
}

/** 用与整条分镜相同的归一化清理新卡片（去掉不可用素材等）：把镜头放在 0 起点的单镜头时间轴上跑一遍，卡片被丢弃则返回 null */
function sanitize(card: CardSpec, durationSec: number, images: string[]): CardSpec | null {
  const raw = { shots: [{ start: 0, end: durationSec, layout: 'split', card }] };
  const { storyboard, dropped } = normalizeStoryboard(raw, durationSec, images);
  return dropped === 0 ? storyboard.shots.find((s) => s.card)?.card ?? null : null;
}

/**
 * 把评语与该镜头字幕交给分镜模型，返回重写后的卡片（可换模板，镜头仍是分屏）。
 * 模型返回不合模式、换成不允许的模板（cta、非 hook 镜头变 hook、hook 镜头换模板）或素材不可用被丢弃时返回 null；请求本身失败会抛出。
 */
export async function reviseCard(client: LlmClient, shot: Shot, captionsInShot: TimedCaption[], score: CardScore, availableImages: string[] = []): Promise<CardSpec | null> {
  const old = shot.card;
  if (!old) return null;
  const raw = await client.chatJson({
    model: STORYBOARD_MODEL, system: SYSTEM_PROMPT, user: buildUserMessage(old, shot.end - shot.start, captionsInShot, score, availableImages),
    reasoningEffort: 'low', label: '卡片重写',
  });
  const parsed = CardSpecSchema.safeParse((raw as { card?: unknown } | null)?.card);
  if (!parsed.success || parsed.data.template === 'cta') return null;
  if ((parsed.data.template === 'hook') !== (old.template === 'hook')) return null;
  const clean = sanitize(withoutVisual(parsed.data), shot.end - shot.start, availableImages);
  return clean ? keepHookNumbering(clean, old) : null;
}
