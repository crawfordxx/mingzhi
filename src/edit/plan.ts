import { z } from 'zod';
import type { Track } from '../assets/catalog.js';
import { loadTracks } from '../assets/catalog.js';
import type { LlmClient } from '../llm/kexiang.js';
import { CATALOG } from '../storyboard/catalog.js';
import type { VersionState } from './apply.js';
import { buildEditContext, formatContext } from './context.js';
import type { EditOp } from './ops.js';
import { validateOps } from './validate.js';

export { EditOpSchema, type EditOp } from './ops.js';
export { validateOps } from './validate.js';
export type { EditContext } from './context.js';

export const EDIT_MODEL = 'google/gemini-3.5-flash';

export interface EditOption { label: string; ops: EditOp[] }
/** 模型的修改方案：回复 + 直接执行的操作 + 可点选的备选方案 */
export interface EditPlan { reply: string; ops: EditOp[]; options?: EditOption[] }

const catalogText = CATALOG.map((c) => `- ${c.id}：${c.use}\n  props：${c.props}`).join('\n');

const SYSTEM_PROMPT = `你是口播短视频的修改助手。用户在工作台用一句话提出修改，你输出一份修改方案；程序会逐条执行 ops。只做用户要求的修改，不要顺手改别的。

输出严格的 JSON，不要任何多余文字：
{"reply":"给用户的简短回复","ops":[操作…],"options":[{"label":"选项名","ops":[操作…]}]}
- reply：一两句中文，只描述 ops 里真正写了的修改（ops 为空就不要说「已改好」）；纯提问或无需修改时 ops 写 []。
- options 可选：用户的意思有多种合理做法时，给 2-3 个可点选的备选方案（label 简短），此时 ops 可以为空；明确的需求不要给 options。

操作（type 字段区分）：
- {"type":"setBackground","spec":{"kind":"preset","id":"预设id"}} 或 {"kind":"prompt","prompt":"一句话描述的背景"}
- {"type":"setCaptionStyle","id":"字幕样式id"}
- {"type":"setCoverStyle","id":"封面风格id"}（只重做封面）
- {"type":"setBgm","bgm":"none | auto | chill | tech | upbeat | 曲目id"}
- {"type":"replaceCard","shotIndex":镜头序号,"card":{"template":"模板名","props":{…}}}
- {"type":"setLayout","shotIndex":镜头序号,"layout":"split|full|broll|pip|overlay"}（split 上卡下人；full 人物全屏，会去掉卡片；broll 素材全屏插入、pip 素材全屏加人物小窗，都只能用于标了「带素材」的镜头，会去掉卡片；overlay 人物全屏加顶部浮层卡，要有卡片或素材；cta 只能 full）
- {"type":"regenerateVisual","shotIndex":镜头序号,"visual":{"source":"screenshot|generate|video",…}}（hook 可 generate/video，photo 可 screenshot/generate，browser 只能 screenshot；生图与视频提示词用英文）
- {"type":"editCaption","index":字幕序号,"text":"新文字"}
- {"type":"pace","direction":"tighter|looser"}（整体剪得更紧凑 / 更宽松）
- {"type":"removeSpan","fromSec":秒,"toSec":秒}（删掉一段，用成片时间）
- {"type":"restoreSpan","fromSec":秒,"toSec":秒}（找回被剪掉的一段，用原片时间，范围取自「已剪掉的片段」）

规则：
1. 镜头序号、字幕序号都从 0 起，以上下文里列出的为准；用户说 @mm:ss 时，用「引用解析」里给出的镜头序号。
2. 背景预设、字幕样式、封面风格、配乐只能用上下文列出的 id。
3. 卡片不要写 image、video 文件名（你不知道有哪些文件）；需要图片或视频就用 visual 描述，photo 卡必须带 visual。卡片文字要精炼，严格遵守各字段长度上限；数字、专名不要编造。
4. 版式规则：cta 只能是最后一个镜头且只能全屏，hook 只能放在前 15 秒内且最多 3 张，带卡片的镜头最长 8 秒；违反的操作会被丢弃。
5. 不确定的需求宁可给 options，不要瞎猜。
6. 用户要换模板（如「换成标题卡 / 大字标题」）时，用 replaceCard 写一张新模板的完整卡片（例如把 photo 换成 title），不要只改原卡片的字段。

模板目录：
${catalogText}`;

const TopSchema = z.object({ reply: z.string().trim().min(1), ops: z.array(z.unknown()).default([]), options: z.unknown().optional() });
const OptionSchema = z.object({ label: z.string().trim().min(1).max(30), ops: z.array(z.unknown()) });

function checkOptions(raw: unknown, state: VersionState, tracks: Track[]): { options: EditOption[]; dropped: string[] } {
  if (raw === undefined || raw === null) return { options: [], dropped: [] };
  if (!Array.isArray(raw)) return { options: [], dropped: ['选项格式不对'] };
  return raw.reduce<{ options: EditOption[]; dropped: string[] }>((acc, item) => {
    const parsed = OptionSchema.safeParse(item);
    if (!parsed.success) return { ...acc, dropped: [...acc.dropped, '一个选项格式不对'] };
    const { ops, dropped } = validateOps(parsed.data.ops, state, tracks);
    const label = parsed.data.label;
    const note = dropped.map((d) => `选项「${label}」的${d}`);
    return ops.length === 0
      ? { ...acc, dropped: [...acc.dropped, ...note, `选项「${label}」没有可执行的操作`] }
      : { options: [...acc.options, { label, ops }], dropped: [...acc.dropped, ...note] };
  }, { options: [], dropped: [] });
}

/** 让模型根据用户的一句话和当前版本给出修改方案；非法操作（含版式规则不允许的）逐条丢弃并在回复末尾说明，整体不可用时抛中文错误 */
export async function planEdit(client: LlmClient, message: string, state: VersionState, tracks: Track[] = loadTracks()): Promise<EditPlan> {
  const context = buildEditContext(state, message, tracks);
  const user = `${formatContext(context)}\n\n用户的话：${message}`;
  const raw = await client.chatJson({ model: EDIT_MODEL, system: SYSTEM_PROMPT, user, reasoningEffort: 'low', label: '修改' });
  const top = TopSchema.safeParse(raw);
  if (!top.success) throw new Error('模型返回的修改方案格式不对（缺少 reply 或 ops 不是数组），请换个说法再试一次');
  const direct = validateOps(top.data.ops, state, tracks);
  const picked = checkOptions(top.data.options, state, tracks);
  const dropped = [...direct.dropped, ...picked.dropped];
  const nothing = top.data.ops.length > 0 && direct.ops.length === 0 && picked.options.length === 0;
  const note = nothing ? `\n\n（这次没有执行任何修改：${dropped.join('；')}）`
    : dropped.length > 0 ? `\n\n（有 ${dropped.length} 处无法执行，已忽略：${dropped.join('；')}）` : '';
  return {
    reply: top.data.reply + note,
    ops: direct.ops,
    ...(picked.options.length > 0 ? { options: picked.options } : {}),
  };
}
