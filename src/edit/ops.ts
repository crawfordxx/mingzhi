import { z } from 'zod';
import { CAPTION_STYLES } from '../captions/styles.js';
import { COVER_STYLES } from '../cover/styles.js';
import { CardSpecSchema, LAYOUTS, VisualSchema, type TemplateId } from '../storyboard/schema.js';

const keys = <T extends object>(o: T): [keyof T & string, ...(keyof T & string)[]] => Object.keys(o) as [keyof T & string, ...(keyof T & string)[]];
const index = z.number().int().min(0);
const sec = z.number().finite().min(0);

/** 背景只允许预设或一句话描述：模型（或请求体）不能指定本机文件路径 */
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
  z.object({ type: z.literal('setLayout'), shotIndex: index, layout: z.enum(LAYOUTS) }),
  z.object({ type: z.literal('regenerateVisual'), shotIndex: index, visual: VisualSchema }),
  /** 换一张 B-roll：只重做该镜头的素材（素材面板标了删除的则去掉素材），其余镜头不动 */
  z.object({ type: z.literal('replaceBroll'), shotIndex: index }),
  z.object({ type: z.literal('editCaption'), index, text: z.string().trim().min(1).max(60) }),
  z.object({ type: z.literal('pace'), direction: z.enum(['tighter', 'looser']) }),
  /** 成片时间（用户在预览里看到的时间） */
  z.object({ type: z.literal('removeSpan'), fromSec: sec, toSec: sec }),
  /** 原片时间（上下文里「已剪掉的片段」给出的时间） */
  z.object({ type: z.literal('restoreSpan'), fromSec: sec, toSec: sec }),
]);
export type EditOp = z.infer<typeof EditOpSchema>;

/** 各模板的 visual 允许哪些来源（与卡片 schema 一致）；不在表里的模板不支持素材需求 */
export const VISUAL_SOURCES: Partial<Record<TemplateId, readonly string[]>> = {
  hook: ['generate', 'video'],
  photo: ['screenshot', 'generate'],
  browser: ['screenshot'],
};
