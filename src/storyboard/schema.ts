import { z } from 'zod';
import type { TimedCaption } from '../captions/lines.js';
import type { SubjectBox } from '../matting/composite.js';
import type { SfxCue, VolumeKey } from '../audio/plan.js';
import type { CaptionStyleId } from '../captions/styles.js';
import type { Mood } from '../assets/catalog.js';
import type { OutroProps } from '../compose/ending.js';

/** 画布与版式常量：分界线 y=960 来自参考片实测 */
export const CANVAS = { width: 1080, height: 1920, fps: 30, seam: 960 } as const;
export const MIN_SHOT_SEC = 1;
/** 带卡片的镜头最长 8 秒，超出部分改为人物全屏 */
export const MAX_SHOT_SEC = 8;
export const HOOK_WINDOW_SEC = 15;

export const TEMPLATE_IDS = ['hook', 'title', 'bigNumber', 'chips', 'compareBars', 'evidenceList', 'terminal', 'toggles', 'strikeList', 'browser', 'photo', 'cta', 'flow'] as const;
export type TemplateId = (typeof TEMPLATE_IDS)[number];

const text = z.string().trim().min(1).max(60);
const short = z.string().trim().min(1).max(24);
/** 徽章、标签、选项等短词，最长 12 字 */
const chip = z.string().trim().min(1).max(12);
/** 持续演进：各条目依次出现的时刻（镜头内秒数，归一化后；模型输出的是成片时间轴上的秒数，由归一化换算） */
const reveal = z.array(z.number().finite().min(0)).min(1).max(5).optional();
/** 证据清单徽章：「证据」「来源」只给带数据或出处的行，普通观点用「要点」 */
export const BADGES = ['成本', '收益', '证据', '来源', '要点'] as const;

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

/** 画面角标：网页截图标来源站点（kind=source），AI 生成标「AI 生成」（kind=ai）；镜头 B-roll 与卡片自带的图（钩子、图片卡）共用同一种角标 */
export const MediaLabelSchema = z.object({ kind: z.enum(['source', 'ai']), text: z.string().trim().min(1).max(30) });
/** 卡片自带的图或视频的角标（由素材步骤按授权记录填写） */
const mediaLabel = MediaLabelSchema.optional();

const card = <T extends TemplateId, P extends z.ZodTypeAny>(template: T, props: P) => z.object({ template: z.literal(template), props });

export const CardSpecSchema = z.discriminatedUnion('template', [
  card('hook', z.object({ index: z.number().int().min(1).max(3), total: z.number().int().min(1).max(3), headline: text, highlight: z.array(chip).max(3), kicker: text.optional(), stat: z.object({ value: short, label: short }).optional(), image: z.string().optional(), video: z.string().optional(), visual: HookVisual.optional(), source: short.optional(), mediaLabel })),
  card('title', z.object({ title: text, subtitle: text.optional(), crumb: short.optional() })),
  card('bigNumber', z.object({ value: z.string().trim().min(1).max(10), unit: short.optional(), label: text, chips: z.array(chip).max(18).optional(), highlight: z.array(chip).max(6).optional() })),
  card('chips', z.object({ groups: z.array(z.object({ label: chip, items: z.array(z.object({ text: chip, mark: z.enum(['yes', 'no', 'maybe']) })).min(1).max(5) })).min(1).max(2) })),
  card('compareBars', z.object({ crumb: short.optional(), items: z.array(z.object({ name: chip, note: short.optional(), value: z.number().min(0).max(1), annotation: chip.optional(), tone: z.enum(['bad', 'warn', 'good']) })).min(1).max(3), verdict: chip.optional(), reveal })),
  card('evidenceList', z.object({ crumb: short.optional(), title: text, rows: z.array(z.object({ badge: z.enum(BADGES), text })).min(1).max(5), highlight: z.array(z.number().int().min(0).max(4)).max(5).optional(), tags: z.array(chip).max(3).optional(), reveal })),
  card('terminal', z.object({ title: short.optional(), lines: z.array(z.string().trim().min(1).max(40)).min(1).max(6) })),
  card('toggles', z.object({ title: short.optional(), rows: z.array(z.object({ label: chip, on: z.boolean() })).min(1).max(4), footnote: text.optional() })),
  card('strikeList', z.object({ title: short.optional(), items: z.array(chip).min(1).max(5), reveal })),
  card('browser', z.object({ url: z.string().trim().min(1).max(80), title: text.optional(), image: z.string().optional(), visual: BrowserVisual.optional() })),
  card('photo', z.object({ image: z.string().min(1).optional(), video: z.string().min(1).optional(), visual: PhotoVisual.optional(), label: short.optional(), sublabel: text.optional(), mediaLabel })),
  /** placed：CTA 已提前到倒数第 5–8 秒（见 compose/ending 的 placeCta），归一化时不再把它拉回末尾，也不当作位置错误降级 */
  card('cta', z.object({ actions: z.array(z.string().trim().min(1).max(6)).min(1).max(3), placed: z.boolean().optional() })),
  card('flow', z.object({ crumb: short.optional(), title: short.optional(), steps: z.array(z.object({ label: chip, note: short.optional() })).min(2).max(5), loop: z.boolean().optional(), reveal })),
]);
export type CardSpec = z.infer<typeof CardSpecSchema>;

/**
 * 镜头版式：split 上卡下人、full 人物全屏、broll 素材全屏插入（人声继续）、pip 素材全屏 + 人物画中画、overlay 人物全屏 + 顶部浮层卡。
 * broll/pip/overlay 由 B-roll 编排填写，缺素材时渲染层按 full 处理（见 compose/layout.ts 的 visualLayout）
 */
export const LAYOUTS = ['split', 'full', 'broll', 'pip', 'overlay'] as const;
export type Layout = (typeof LAYOUTS)[number];

const unit = z.number().min(0).max(1);
/** 裁框容差：浮点误差内视为合法 */
const RECT_EPS = 1e-6;
/** Ken Burns 裁框：相对素材铺满画面后的归一化坐标（0–1）；w 必须等于 h（与画面同比例），且不出画 */
const RectSchema = z.object({ x: unit, y: unit, w: z.number().gt(0).max(1), h: z.number().gt(0).max(1) })
  .refine((r) => Math.abs(r.w - r.h) <= RECT_EPS, '裁框须与画面同比例（w 等于 h）')
  .refine((r) => r.x + r.w <= 1 + RECT_EPS && r.y + r.h <= 1 + RECT_EPS, '裁框超出画面');
export type Rect = z.infer<typeof RectSchema>;
/** 素材扩展名白名单（按类型） */
export const BROLL_EXTS = { photo: ['.jpg', '.jpeg', '.png', '.webp'], video: ['.mp4', '.mov', '.webm'] } as const;
const extOf = (file: string): string => /\.[a-z0-9]+$/i.exec(file)?.[0].toLowerCase() ?? '';
/** 项目内相对路径：不以 / 开头、不带盘符或协议、不含反斜杠与 .. 段 */
const isProjectPath = (file: string): boolean => !/^[/\\]|^[a-z][a-z0-9+.-]*:/i.test(file) && !file.includes('\\') && !file.split('/').includes('..');
/**
 * 镜头素材（只由 B-roll 编排层写入，归一化时还要对照可用素材列表）：file 为工作目录内的相对路径；focal 为主体位置（0–1）；
 * kenBurns 省略时由 focal 计算（只用于静图）；durationSec 为视频素材时长，给出时镜头比素材长就循环，否则停在末帧；label 为画面角标
 */
export const BrollSchema = z.object({
  file: z.string().trim().min(1).max(200).refine(isProjectPath, '素材必须是项目内的相对路径'),
  kind: z.enum(['video', 'photo']),
  focal: z.object({ x: unit, y: unit }),
  kenBurns: z.object({ from: RectSchema, to: RectSchema }).optional(),
  durationSec: z.number().finite().positive().optional(),
  /** 画面角标：网页截图标来源站点（kind=source），AI 生成标「AI 生成」（kind=ai）；图库素材不标（署名在 credits 与导出文本里） */
  label: MediaLabelSchema.optional(),
  /** 铺图变体：卡片铺在这张素材上时底部压暗加深、玻璃卡几乎不透明（整片自检发现图上文字对比度不够时切换） */
  legible: z.boolean().optional(),
}).refine((b) => (BROLL_EXTS[b.kind] as readonly string[]).includes(extOf(b.file)), '素材扩展名与类型不符');
export type Broll = z.infer<typeof BrollSchema>;

/**
 * lead：卡片内部时钟的起点（秒）。整片自检把静止的卡片镜头切成两段、后段换版式时，后段延续前段的卡片（计数、弹入、逐条出现不重放）；
 * 缺省按 compose/card-carry 的 cardLead 规则
 */
export const ShotSchema = z.object({ start: z.number().finite(), end: z.number().finite(), layout: z.enum(LAYOUTS), card: CardSpecSchema.optional(), broll: BrollSchema.optional(), lead: z.number().min(0).max(MAX_SHOT_SEC).optional() });
export type Shot = { start: number; end: number; layout: Layout; card?: CardSpec; broll?: Broll; lead?: number };
/** 背景乐情绪；模型漏写或写错时按 chill */
export const MOODS = ['chill', 'tech', 'upbeat'] as const satisfies readonly Mood[];
export const DEFAULT_MOOD: Mood = 'chill';
export const COVER_TITLE_MAX = 12;
export const COVER_SUBTITLE_MAX = 16;
/** 封面标题：由分镜模型顺带给出，主标题 ≤12 字、小标题 ≤16 字 */
export const CoverTitleSchema = z.object({ title: z.string().trim().min(1).max(COVER_TITLE_MAX), subtitle: z.string().trim().min(1).max(COVER_SUBTITLE_MAX).optional() });
export type CoverTitle = z.infer<typeof CoverTitleSchema>;
/** bgm 经归一化后必有值（缺省 chill），类型上可选是为了让只关心镜头的调用方与测试不必填写；coverTitle 缺省时由出片流程用 hook 卡片或第一句字幕兜底 */
export interface Storyboard { shots: Shot[]; bgm?: Mood; coverTitle?: CoverTitle }

/** 传给 Remotion 主合成的全部数据；person 与图片都是相对 publicDir（工作目录）的文件名；grain 为颗粒质感层开关（缺省见 compose/layout 的 grainOn）；durationSec 是整片时长，有 outro 时包含最后一句后的留白与片尾，镜头只覆盖口播内容 */
export type TalkProps = { person: string; personWidth: number; personHeight: number; subject: SubjectBox | null; captions: TimedCaption[]; shots: Shot[]; durationSec: number; bgm?: { file: string; keys: VolumeKey[]; durationSec: number }; sfx?: SfxCue[]; captionStyle?: CaptionStyleId; captionFontFile?: string; grain?: boolean; outro?: OutroProps };
