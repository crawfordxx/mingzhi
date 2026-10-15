import { z } from 'zod';
import { CAPTION_STYLES } from '../captions/styles.js';
import { COVER_STYLES } from '../cover/styles.js';
import type { LlmClient } from '../llm/kexiang.js';
import { CATALOG } from '../storyboard/catalog.js';
import { CardSpecSchema, MOODS, VisualSchema, type TemplateId } from '../storyboard/schema.js';
import { formatContext, type EditContext } from './context.js';

export const EDIT_MODEL = 'google/gemini-3.5-flash';

const keys = <T extends object>(o: T): [keyof T & string, ...(keyof T & string)[]] => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const index = z.number().int().min(0);
const sec = z.number().finite().min(0);

/** 背景只允许预设或一句话描述：模型不能凭空指定本机文件路径 */
const BackgroundPick = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('preset'), id: z.string().min(1) }),
  z.object({ kind: z.literal('prompt'), prompt: z.string().trim().min(2).max(300) }),
]);

export const EditOpSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('setBackground'), spec: BackgroundPick }),
  z.object({ type: z.literal('setCaptionStyle'), id: z.enum(keys(CAPTION_STYLES)) }),
  z.object({ type: z.literal('setCoverStyle'), id: z.enum(keys(COVER_STYLES)) }),
  /** bgm：'none' 不要配乐、'auto' 自动选曲、情绪（chill/tech/upbeat）或曲目 id */
  z.object({ type: z.literal('setBgm'), bgm: z.string().trim().min(1) }),
  z.object({ type: z.literal('replaceCard'), shotIndex: index, card: CardSpecSchema }),
  z.object({ type: z.literal('setLayout'), shotIndex: index, layout: z.enum(['split', 'full']) }),
  z.object({ type: z.literal('regenerateVisual'), shotIndex: index, visual: VisualSchema }),
  z.object({ type: z.literal('editCaption'), index, text: z.string().trim().min(1).max(30) }),
  z.object({ type: z.literal('pace'), direction: z.enum(['tighter', 'looser']) }),
  /** 成片时间（用户在预览里看到的时间） */
  z.object({ type: z.literal('removeSpan'), fromSec: sec, toSec: sec }),
  /** 原片时间（上下文里「已剪掉的片段」给出的时间） */
  z.object({ type: z.literal('restoreSpan'), fromSec: sec, toSec: sec }),
]);
export type EditOp = z.infer<typeof EditOpSchema>;

export interface EditOption { label: string; ops: EditOp[] }
/** 模型的修改方案：回复 + 直接执行的操作 + 可点选的备选方案 */
export interface EditPlan { reply: string; ops: EditOp[]; options?: EditOption[] }

export type { EditContext } from './context.js';

/** 各模板的 visual 允许哪些来源（与卡片 schema 一致）；不在表里的模板不支持素材需求 */
export const VISUAL_SOURCES: Partial<Record<TemplateId, readonly string[]>> = {
  hook: ['generate', 'video'],
  photo: ['screenshot', 'generate'],
  browser: ['screenshot'],
};

/** 操作与当前版本对不上（序号越界、预设不存在等）时返回中文原因，合法返回 null */
export function checkOp(op: EditOp, ctx: EditContext): string | null {
  switch (op.type) {
    case 'setBackground': {
      const { spec } = op;
      return spec.kind === 'preset' && !ctx.presets.some((p) => p.id === spec.id) ? `没有预设背景「${spec.id}」` : null;
    }
    case 'setBgm':
      return ['auto', 'none', ...MOODS, ...ctx.tracks.map((t) => t.id)].includes(op.bgm) ? null : `没有配乐「${op.bgm}」`;
    case 'replaceCard':
      return shotMissing(op.shotIndex, ctx);
    case 'setLayout': {
      const missing = shotMissing(op.shotIndex, ctx);
      return missing ?? (op.layout === 'split' && !ctx.shots[op.shotIndex].template ? '该镜头没有卡片，不能改成分屏' : null);
    }
    case 'regenerateVisual':
      return checkVisual(op, ctx);
    case 'editCaption':
      return op.index < ctx.captions.length ? null : `没有第 ${op.index} 句字幕`;
    case 'removeSpan':
      return op.toSec > op.fromSec && op.fromSec < ctx.outputDurationSec ? null : '时间范围不在成片内';
    case 'restoreSpan':
      return op.toSec > op.fromSec && op.fromSec < ctx.sourceDurationSec ? null : '时间范围不在原片内';
    default:
      return null;
  }
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

const catalogText = CATALOG.map((c) => `- ${c.id}：${c.use}\n  props：${c.props}`).join('\n');

const SYSTEM_PROMPT = `你是口播短视频的修改助手。用户在工作台用一句话提出修改，你输出一份修改方案；程序会逐条执行 ops。只做用户要求的修改，不要顺手改别的。

输出严格的 JSON，不要任何多余文字：
{"reply":"给用户的简短回复","ops":[操作…],"options":[{"label":"选项名","ops":[操作…]}]}
- reply：一两句中文，说清楚改了什么；纯提问或无需修改时 ops 写 []。
- options 可选：用户的意思有多种合理做法时，给 2-3 个可点选的备选方案（label 简短），此时 ops 可以为空；明确的需求不要给 options。

操作（type 字段区分）：
- {"type":"setBackground","spec":{"kind":"preset","id":"预设id"}} 或 {"kind":"prompt","prompt":"一句话描述的背景"}
- {"type":"setCaptionStyle","id":"字幕样式id"}
- {"type":"setCoverStyle","id":"封面风格id"}（只重做封面）
- {"type":"setBgm","bgm":"none | auto | chill | tech | upbeat | 曲目id"}
- {"type":"replaceCard","shotIndex":镜头序号,"card":{"template":"模板名","props":{…}}}
- {"type":"setLayout","shotIndex":镜头序号,"layout":"split|full"}（改全屏会去掉卡片）
- {"type":"regenerateVisual","shotIndex":镜头序号,"visual":{"source":"screenshot|generate|video",…}}（hook 可 generate/video，photo 可 screenshot/generate，browser 只能 screenshot；生图与视频提示词用英文）
- {"type":"editCaption","index":字幕序号,"text":"新文字"}
- {"type":"pace","direction":"tighter|looser"}（整体剪得更紧凑 / 更宽松）
- {"type":"removeSpan","fromSec":秒,"toSec":秒}（删掉一段，用成片时间）
- {"type":"restoreSpan","fromSec":秒,"toSec":秒}（找回被剪掉的一段，用原片时间，范围取自「已剪掉的片段」）

规则：
1. 镜头序号、字幕序号都从 0 起，以上下文里列出的为准；用户说 @mm:ss 时，用「引用解析」里给出的镜头序号。
2. 背景预设、字幕样式、封面风格、配乐只能用上下文列出的 id。
3. 卡片文字要精炼，严格遵守各字段长度上限；数字、专名不要编造。
4. 不确定的需求宁可给 options，不要瞎猜。

模板目录：
${catalogText}`;

const TopSchema = z.object({ reply: z.string().trim().min(1), ops: z.array(z.unknown()).default([]), options: z.unknown().optional() });
const OptionSchema = z.object({ label: z.string().trim().min(1).max(30), ops: z.array(z.unknown()) });

interface Checked { ops: EditOp[]; dropped: string[] }

/** 逐条校验：先过 zod，再对照当前版本；不合格的丢弃并记下原因 */
function checkOps(raw: unknown[], ctx: EditContext): Checked {
  return raw.reduce<Checked>((acc, item) => {
    const name = String((item as { type?: unknown } | null)?.type ?? '未知');
    const parsed = EditOpSchema.safeParse(item);
    if (!parsed.success) return { ...acc, dropped: [...acc.dropped, `「${name}」参数不合法（${parsed.error.issues[0].path.join('.') || 'type'}）`] };
    const problem = checkOp(parsed.data, ctx);
    return problem ? { ...acc, dropped: [...acc.dropped, `「${name}」${problem}`] } : { ...acc, ops: [...acc.ops, parsed.data] };
  }, { ops: [], dropped: [] });
}

function checkOptions(raw: unknown, ctx: EditContext): { options: EditOption[]; dropped: string[] } {
  if (raw === undefined || raw === null) return { options: [], dropped: [] };
  if (!Array.isArray(raw)) return { options: [], dropped: ['选项格式不对'] };
  return raw.reduce<{ options: EditOption[]; dropped: string[] }>((acc, item) => {
    const parsed = OptionSchema.safeParse(item);
    if (!parsed.success) return { ...acc, dropped: [...acc.dropped, '一个选项格式不对'] };
    const { ops, dropped } = checkOps(parsed.data.ops, ctx);
    const label = parsed.data.label;
    const note = dropped.map((d) => `选项「${label}」的${d}`);
    return ops.length === 0
      ? { ...acc, dropped: [...acc.dropped, ...note, `选项「${label}」没有可执行的操作`] }
      : { options: [...acc.options, { label, ops }], dropped: [...acc.dropped, ...note] };
  }, { options: [], dropped: [] });
}

/** 让模型根据用户的一句话和当前版本上下文给出修改方案；非法操作逐条丢弃并在回复末尾说明，整体不可用时抛中文错误 */
export async function planEdit(client: LlmClient, message: string, context: EditContext): Promise<EditPlan> {
  const raw = await client.chatJson({ model: EDIT_MODEL, system: SYSTEM_PROMPT, user: `${formatContext(context)}\n\n用户的话：${message}`, reasoningEffort: 'low', label: '修改' });
  const top = TopSchema.safeParse(raw);
  if (!top.success) throw new Error('模型返回的修改方案格式不对（缺少 reply 或 ops 不是数组），请换个说法再试一次');
  const direct = checkOps(top.data.ops, context);
  const picked = checkOptions(top.data.options, context);
  const dropped = [...direct.dropped, ...picked.dropped];
  const note = dropped.length > 0 ? `\n\n（有 ${dropped.length} 处无法执行，已忽略：${dropped.join('；')}）` : '';
  return {
    reply: top.data.reply + note,
    ops: direct.ops,
    ...(picked.options.length > 0 ? { options: picked.options } : {}),
  };
}
