import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';
import type { SfxCue, VolumeKey } from '../audio/plan.js';

/** 画布与版式常量：分界线 y=960 来自参考片实测 */
export const CANVAS = { width: 1080, height: 1920, fps: 30, seam: 960 } as const;
export const MIN_SHOT_SEC = 1;
/** 带卡片的镜头最长 8 秒，超出部分改为人物全屏 */
export const MAX_SHOT_SEC = 8;
export const HOOK_WINDOW_SEC = 15;

export const TEMPLATE_IDS = ['hook', 'title', 'bigNumber', 'chips', 'compareBars', 'evidenceList', 'terminal', 'toggles', 'strikeList', 'browser', 'photo', 'cta'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const text = z.string().trim().min(1).max(60);
const short = z.string().trim().min(1).max(24);
/** 徽章、标签、选项等短词，最长 12 字 */
const chip = z.string().trim().min(1).max(12);

/** 素材需求：分镜只写“要什么”，由后续步骤去截图、生图或生视频 */
const screenshotNeed = z.object({ source: z.literal('screenshot'), url: z.string().trim().url().regex(/^https?:\/\//).optional(), query: z.string().trim().min(2).max(60).optional() });
const generateNeed = z.object({ source: z.literal('generate'), prompt: z.string().trim().min(8).max(400) });
const videoNeed = z.object({ source: z.literal('video'), prompt: z.string().trim().min(8).max(400) });
/** 截图要有网址或搜索词之一（discriminatedUnion 成员不能带 refine，所以放在外层检查） */
const hasTarget = (v: { source: string; url?: string; query?: string }): boolean => v.source !== 'screenshot' || Boolean(v.url || v.query);
const TARGET_MSG = '截图需求要有 url 或 query';
export const VisualSchema = z.discriminatedUnion('source', [screenshotNeed, generateNeed, videoNeed]).refine(hasTarget, TARGET_MSG);
export type Visual = z.infer<typeof VisualSchema>;
/** 各模板允许的来源：hook 生图/视频，photo 截图/生图，browser 只截图 */
const HookVisual = z.discriminatedUnion('source', [generateNeed, videoNeed]);
const PhotoVisual = z.discriminatedUnion('source', [screenshotNeed, generateNeed]).refine(hasTarget, TARGET_MSG);
const BrowserVisual = screenshotNeed.refine(hasTarget, TARGET_MSG);

const card = <T extends TemplateId, P extends z.ZodTypeAny>(template: T, props: P) => z.object({ template: z.literal(template), props });

export const CardSpecSchema = z.discriminatedUnion('template', [
  card('hook', z.object({ index: z.number().int().min(1).max(3), total: z.number().int().min(1).max(3), headline: text, highlight: z.array(chip).max(3), kicker: text.optional(), stat: z.object({ value: short, label: short }).optional(), image: z.string().optional(), video: z.string().optional(), visual: HookVisual.optional() })),
  card('title', z.object({ title: text, subtitle: text.optional(), crumb: short.optional() })),
  card('bigNumber', z.object({ value: z.string().trim().min(1).max(10), unit: short.optional(), label: text, chips: z.array(chip).max(18).optional(), highlight: z.array(chip).max(6).optional() })),
  card('chips', z.object({ groups: z.array(z.object({ label: chip, items: z.array(z.object({ text: chip, mark: z.enum(['yes', 'no', 'maybe']) })).min(1).max(5) })).min(1).max(2) })),
  card('compareBars', z.object({ crumb: short.optional(), items: z.array(z.object({ name: chip, note: short.optional(), value: z.number().min(0).max(1), annotation: chip.optional(), tone: z.enum(['bad', 'warn', 'good']) })).min(1).max(3), verdict: chip.optional() })),
  card('evidenceList', z.object({ crumb: short.optional(), title: text, rows: z.array(z.object({ badge: z.enum(['成本', '收益', '证据', '来源']), text })).min(1).max(5), highlight: z.array(z.number().int().min(0).max(4)).max(5).optional(), tags: z.array(chip).max(3).optional() })),
  card('terminal', z.object({ title: short.optional(), lines: z.array(z.string().trim().min(1).max(40)).min(1).max(6) })),
  card('toggles', z.object({ title: short.optional(), rows: z.array(z.object({ label: chip, on: z.boolean() })).min(1).max(4), footnote: text.optional() })),
  card('strikeList', z.object({ title: short.optional(), items: z.array(chip).min(1).max(5) })),
  card('browser', z.object({ url: z.string().trim().min(1).max(80), title: text.optional(), image: z.string().optional(), visual: BrowserVisual.optional() })),
  card('photo', z.object({ image: z.string().min(1).optional(), video: z.string().min(1).optional(), visual: PhotoVisual.optional(), label: short.optional(), sublabel: text.optional() })),
  card('cta', z.object({ actions: z.array(z.string().trim().min(1).max(6)).min(1).max(3) })),
]);
export type CardSpec = z.infer<typeof CardSpecSchema>;

export const ShotSchema = z.object({ start: z.number().finite(), end: z.number().finite(), layout: z.enum(['split', 'full']), card: CardSpecSchema.optional() });
export type Shot = { start: number; end: number; layout: 'split' | 'full'; card?: CardSpec };
export interface Storyboard { shots: Shot[] }

/** 传给 Remotion 主合成的全部数据；person 与图片都是相对 publicDir（工作目录）的文件名 */
export type TalkProps = { person: string; personWidth: number; personHeight: number; subject: SubjectBox | null; captions: TimedCaption[]; shots: Shot[]; durationSec: number; bgm?: { file: string; keys: VolumeKey[]; durationSec: number }; sfx?: SfxCue[] };
