import type { TimedCaption } from '../captions/lines.js';
import type { LlmClient } from '../llm/kexiang.js';
import { CATALOG } from './catalog.js';
import { normalizeStoryboard, type NormalizeResult } from './normalize.js';
import { HOOK_WINDOW_SEC, ShotSchema } from './schema.js';

export { CATALOG } from './catalog.js';
export const STORYBOARD_MODEL = 'google/gemini-3.5-flash';

const MAX_DROPPED_RATIO = 0.3;
const MIN_CARD_SHOTS = 2;
const MAX_ERROR_SAMPLES = 3;
const TARGET_SHOT_SEC = 5;

const catalogText = CATALOG.map((c) => `- ${c.id}：${c.use}\n  props：${c.props}`).join('\n');

const SYSTEM_PROMPT = `你是短视频口播的分镜导演。输入是成片时间轴上的字幕（每行 [开始-结束] 文字，单位秒，保留 2 位小数）、总时长和可用图片列表。请为整条视频设计分镜：画面分上下两半，split 镜头上半屏显示信息卡片、下半屏是人物；full 镜头人物全屏。

输出严格的 JSON，不要任何多余文字：
{"shots":[{"start":秒,"end":秒,"layout":"split|full","card":{"template":"模板名","props":{…}}}]}
full 镜头不带 card（cta 除外）。镜头按时间顺序首尾相接，覆盖 0 到总时长。

规则：
1. 开头 2-3 张 hook（index 从 1 起，total 为张数），覆盖前几句字幕（${HOOK_WINDOW_SEC} 秒内），每张对应一句最抓人的话；highlight 里的词必须是 headline 的子串。
2. 中段每 1-3 句字幕配一个分屏卡片，镜头边界对齐字幕边界；单个镜头严格控制在 2-8 秒，绝不超过 8 秒，长段落要拆成多个镜头，每个镜头换一张新卡片。
3. 约 20% 的时长用 full 让人物全屏，选情绪、转折、口播感强的句子。
4. 最后一个镜头用 cta（layout 为 full），覆盖最后一句字幕；actions 默认 ["关注","点赞","收藏"]。
5. 卡片文字是提炼后的信息，不要照抄字幕；数字、专名与字幕保持一致，不要编造字幕里没有的数据。
6. 每个字段严格遵守下面写明的长度上限，超出会被丢弃；不同相邻镜头尽量换用不同模板。
7. photo 与 browser.image 只能用「可用图片」列表里的文件名；列表为「无」时不要使用 photo，browser 也不要带 image。

模板目录：
${catalogText}`;

const formatCaptions = (captions: TimedCaption[]): string =>
  captions.map((c) => `[${c.start.toFixed(2)}-${c.end.toFixed(2)}] ${c.text}`).join('\n');

function buildUserMessage(captions: TimedCaption[], durationSec: number, images: string[]): string {
  const imageLine = images.length > 0 ? images.join('，') : '无';
  const target = Math.max(2, Math.round(durationSec / TARGET_SHOT_SEC));
  return `总时长：${durationSec.toFixed(2)} 秒（镜头数约 ${target} 个，平均每个约 ${TARGET_SHOT_SEC} 秒）\n可用图片：${imageLine}\n字幕：\n${formatCaptions(captions)}`;
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

const countCardShots = (res: NormalizeResult): number => res.storyboard.shots.filter((s) => s.card).length;

const needsRetry = (res: NormalizeResult, rawCount: number): boolean =>
  res.dropped > rawCount * MAX_DROPPED_RATIO || countCardShots(res) < MIN_CARD_SHOTS;

/** 让 Gemini 为字幕设计分镜并归一化；不合格镜头过多时带原因重试 1 次；请求失败直接抛出，由流程决定是否降级 */
export async function generateStoryboard(client: LlmClient, captions: TimedCaption[], durationSec: number, availableImages: string[]): Promise<NormalizeResult & { attempts: number }> {
  const user = buildUserMessage(captions, durationSec, availableImages);
  const ask = (message: string) => client.chatJson({ model: STORYBOARD_MODEL, system: SYSTEM_PROMPT, user: message, reasoningEffort: 'low' });

  const raw1 = await ask(user);
  const first = normalizeStoryboard(raw1, durationSec, availableImages);
  const count1 = rawShotCount(raw1);
  if (!needsRetry(first, count1)) return { ...first, attempts: 1 };

  const reasons = summarizeErrors(raw1);
  const hint = `\n\n上一次有 ${first.dropped} 个镜头不合格${reasons.length > 0 ? `：${reasons.join('；')}` : ''}。请严格遵守字段长度上限和图片规则后重新输出。`;
  const second = normalizeStoryboard(await ask(user + hint), durationSec, availableImages);
  return { ...(second.dropped < first.dropped ? second : first), attempts: 2 };
}
