import type { TimedCaption } from '../captions/lines.js';
import type { LlmClient } from '../llm/kexiang.js';
import { CATALOG } from './catalog.js';
import { normalizeStoryboard, type NormalizeResult } from './normalize.js';
import { HOOK_WINDOW_SEC, MAX_SHOT_SEC, ShotSchema, type Shot } from './schema.js';

export { CATALOG } from './catalog.js';
export const STORYBOARD_MODEL = 'google/gemini-3.5-flash';

const MAX_DROPPED_RATIO = 0.3;
const MIN_CARD_SHOTS = 2;
const MAX_ERROR_SAMPLES = 3;
const CTA_ACTIONS = ['关注', '点赞', '收藏'];

const catalogText = CATALOG.map((c) => `- ${c.id}：${c.use}\n  props：${c.props}`).join('\n');

const SYSTEM_PROMPT = `你是短视频口播的分镜导演。输入是成片时间轴上的字幕（每行 [开始-结束] 文字，单位秒，保留 2 位小数）、总时长和可用素材列表。请为整条视频设计分镜：画面分上下两半，split 镜头上半屏显示信息卡片、下半屏是人物；full 镜头人物全屏。

输出严格的 JSON，不要任何多余文字：
{"shots":[{"start":秒,"end":秒,"layout":"split|full","card":{"template":"模板名","props":{…}}}]}
full 镜头不带 card（cta 除外）。镜头按时间顺序首尾相接，覆盖 0 到总时长。

规则：
1. 开头 2-3 张 hook（index 从 1 起，total 为张数），覆盖前几句字幕（${HOOK_WINDOW_SEC} 秒内），每张对应一句最抓人的话；highlight 里的词必须是 headline 的子串。
2. 中段每 1-3 句字幕配一个分屏卡片，镜头边界对齐字幕边界；单个镜头严格控制在 2-${MAX_SHOT_SEC} 秒，绝不超过 ${MAX_SHOT_SEC} 秒，长段落要拆成多个镜头，每个镜头换一张新卡片。
3. 约 20% 的时长用 full 让人物全屏，选情绪、转折、口播感强的句子。
4. 最后一个镜头用 cta（layout 为 full），覆盖最后一句字幕；actions 固定为 ["关注","点赞","收藏"]。
5. 卡片文字是提炼后的信息，不要照抄字幕；数字、专名与字幕保持一致，不要编造字幕里没有的数据。
6. 每个字段严格遵守下面写明的长度上限，超出会被丢弃；不同相邻镜头尽量换用不同模板。
7. image、video 只能填「可用素材」列表里的文件名，不要编造文件名；需要新素材时不写文件名，改在 visual 里写需求（截图 screenshot、生图 generate、视频 video，各模板允许的来源见目录；生图与视频提示词用英文）。素材优先级：能截官方网页就用 screenshot，其次 generate；video 只用于开头最关键的那张 hook，全片最多 1 个。photo 必须带 image、video、visual 之一，列表为「无」时只能写 visual；browser 不带 image 时可以写 screenshot 类 visual。

模板目录：
${catalogText}`;

const formatCaptions = (captions: TimedCaption[]): string =>
  captions.map((c) => `[${c.start.toFixed(2)}-${c.end.toFixed(2)}] ${c.text}`).join('\n');

function buildUserMessage(captions: TimedCaption[], durationSec: number, images: string[]): string {
  const imageLine = images.length > 0 ? images.join('，') : '无';
  return `总时长：${durationSec.toFixed(2)} 秒\n可用素材：${imageLine}\n字幕：\n${formatCaptions(captions)}`;
}

/** 前几个不合格镜头的 zod 错误摘要，供重试时告诉模型哪里错了 */
function summarizeErrors(raw: unknown): string[] {
  const items = (raw as { shots?: unknown } | null)?.shots;
  if (!Array.isArray(items)) return ['顶层缺少 shots 数组'];
  return items.flatMap((item, i) => {
    const parsed = ShotSchema.safeParse(item);
    if (parsed.success) return [];
    const issue = parsed.error.issues[0];
    return [`第 ${i + 1} 个镜头 ${issue.path.join('.') || '(根)'}：${issue.message}`];
  }).slice(0, MAX_ERROR_SAMPLES);
}

const rawShotCount = (raw: unknown): number => {
  const items = (raw as { shots?: unknown } | null)?.shots;
  return Array.isArray(items) ? items.length : 0;
};

const cardShots = (res: NormalizeResult): Shot[] => res.storyboard.shots.filter((s) => s.card);

const tooManyDropped = (res: NormalizeResult, rawCount: number): boolean => res.dropped > rawCount * MAX_DROPPED_RATIO;
const tooFewCards = (res: NormalizeResult): boolean => cardShots(res).length < MIN_CARD_SHOTS;

/** 更好的结果：dropped 更少；相同则带卡片镜头更多；仍相同保留首次 */
const better = (a: NormalizeResult, b: NormalizeResult): NormalizeResult =>
  b.dropped < a.dropped || (b.dropped === a.dropped && cardShots(b).length > cardShots(a).length) ? b : a;

/** 按触发原因生成重试提示：不合格镜头过多（带前几个 zod 错误）或带卡片镜头太少 */
function retryHint(res: NormalizeResult, raw: unknown): string {
  const reasons = summarizeErrors(raw);
  const detail = reasons.length > 0 ? `：${reasons.join('；')}` : '';
  const parts = [
    ...(tooManyDropped(res, rawShotCount(raw)) ? [`上一次有 ${res.dropped} 个镜头不合格${detail}`] : []),
    ...(tooFewCards(res) ? [`上一次可用的带卡片的镜头只有 ${cardShots(res).length} 个，至少需要 ${MIN_CARD_SHOTS} 个${detail}`] : []),
  ];
  return `\n\n${parts.join('。')}。请严格遵守字段长度上限和图片规则后重新输出。`;
}

/** cta 的动作固定为三连；不改动入参 */
function fixCtaActions(res: NormalizeResult): NormalizeResult {
  const shots = res.storyboard.shots.map((s): Shot => (s.card?.template === 'cta' ? { ...s, card: { template: 'cta', props: { actions: [...CTA_ACTIONS] } } } : s));
  return { ...res, storyboard: { shots } };
}

/** 让 Gemini 为字幕设计分镜并归一化；不合格过多或卡片太少时带原因重试 1 次（重试失败则保留首次结果）；首次请求失败直接抛出，由流程决定是否降级 */
export async function generateStoryboard(client: LlmClient, captions: TimedCaption[], durationSec: number, availableImages: string[]): Promise<NormalizeResult & { attempts: number; retryError?: string }> {
  const user = buildUserMessage(captions, durationSec, availableImages);
  const ask = (message: string) => client.chatJson({ model: STORYBOARD_MODEL, system: SYSTEM_PROMPT, user: message, reasoningEffort: 'low' });

  const raw1 = await ask(user);
  const first = normalizeStoryboard(raw1, durationSec, availableImages);
  if (!tooManyDropped(first, rawShotCount(raw1)) && !tooFewCards(first)) return { ...fixCtaActions(first), attempts: 1 };

  try {
    const second = normalizeStoryboard(await ask(user + retryHint(first, raw1)), durationSec, availableImages);
    return { ...fixCtaActions(better(first, second)), attempts: 2 };
  } catch (err) {
    return { ...fixCtaActions(first), attempts: 2, retryError: err instanceof Error ? err.message : String(err) };
  }
}
