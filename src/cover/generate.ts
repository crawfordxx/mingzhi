import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { COVER_ART_YUAN } from '../cost/estimate.js';
import type { CostMeter } from '../cost/meter.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import type { Download } from '../broll/generate-media.js';
import { COVER_SUBTITLE_MAX, COVER_TITLE_MAX, type Storyboard } from '../storyboard/schema.js';
import type { TimedCaption } from '../captions/lines.js';
import { renderCoverStills } from '../compose/render.js';
import { COVER_STYLES, slotRegion, type CoverStyleId } from './styles.js';
import { cutoutPersonWithRetry, pickPersonFrame } from './person.js';

export const COVER_MODEL = 'GPT-Image-2-Official';
export const TITLE_CHECK_MODEL = 'google/gemini-3.5-flash';
export type CoverAspect = '3:4' | '4:3';

/** 标题核对不通过时最多生成几次（含第一次） */
const MAX_ART_ATTEMPTS = 2;
/** 生图任务等待上限：单张约 50 秒，5 分钟足够排队 */
const COVER_TASK_TIMEOUT_MS = 5 * 60_000;
const ORIENT: Record<CoverAspect, string> = { '3:4': '竖版 3:4', '4:3': '横版 4:3' };
const FILE_TAG: Record<CoverAspect, string> = { '3:4': '3x4', '4:3': '4x3' };
const PERSON_FILE = 'cover-person.png';

const pct = (v: number): number => Math.round(v * 100);

/** 人物在左右一侧时，把标题限制在另一侧约 45% 宽度内，避免长标题伸进留白区 */
function titleWidthRule(blank: string, hasSubtitle: boolean): string {
  const side = blank.startsWith('右') ? '左' : blank.startsWith('左') ? '右' : '';
  return side ? `标题${hasSubtitle ? '和小字' : ''}只放在画面${side}侧约 45% 的宽度内，标题可以折成 2–3 行。` : '';
}

/** 生图提示词：风格描述 + 标题原文 + 小标题 + 与人物放置区一致的留白 + 不要人物 + 印刷质感 */
export function coverPrompt(style: CoverStyleId, title: string, subtitle: string | undefined, aspect: CoverAspect): string {
  const { prompt, personSlot } = COVER_STYLES[style];
  const region = slotRegion(personSlot);
  const sub = subtitle ? `，标题下方配小字「${subtitle}」` : '';
  return [
    `${prompt}。短视频封面，${ORIENT[aspect]}。`,
    `${region.title}大号中文标题「${title}」（逐字照抄，不增删、不改字）${sub}。${titleWidthRule(region.blank, Boolean(subtitle))}`,
    `画面${region.blank}留出一大片干净的空白区域（约占画面宽度的 ${pct(personSlot.w)}%、高度的 ${pct(personSlot.h)}%），用于之后放置人物照片，这片区域里不要放文字和主要图形。`,
    `画面中不要出现任何人物、人脸、手或身体部位；除${subtitle ? '标题与小字' : '标题'}外不要出现其他文字、字母或 logo，无水印。排版严谨，印刷级海报质感。`,
  ].join('');
}

/** GPT Image 2 文生图：对应比例 / 1k / medium / png，约 50 秒、¥0.6 一张 */
export async function generateCoverArt(task: TaskClient, style: CoverStyleId, title: string, subtitle: string | undefined, aspect: CoverAspect, dest: string, download: Download = downloadTo): Promise<{ cost?: number }> {
  const { url, cost } = await task.run(
    { modelName: COVER_MODEL, modelType: 'text2img', prompt: coverPrompt(style, title, subtitle, aspect), size: aspect, resolution: '1k', quality: 'medium', output_format: 'png' },
    { kind: 'image', timeoutMs: COVER_TASK_TIMEOUT_MS, label: '封面底图', estimateYuan: COVER_ART_YUAN },
  );
  await download(url, dest);
  return cost !== undefined ? { cost } : {};
}

/** 标题比对用的归一化：全角转半角（NFKC）、拉丁字母转小写、去掉空白、标点与符号 */
export function normalizeTitle(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}

/** ok：标题一致；mismatch：识别结果不一致或答非所问（值得重生）；error：读图模型出错（重生也核对不了，不重生） */
export type TitleCheck = 'ok' | 'mismatch' | 'error';

/** 读图模型识别底图上的标题，归一化后与原文比较 */
export async function verifyTitle(client: LlmClient, png: string, title: string): Promise<TitleCheck> {
  const image = `data:image/png;base64,${readFileSync(png).toString('base64')}`;
  const user = '读出这张封面图上最大、最醒目的标题文字，逐字照录（不要纠错、不要补全，换行处直接连起来）。只输出 JSON：{"title": "标题原文"}';
  let res: unknown;
  try {
    res = await client.chatJson({ model: TITLE_CHECK_MODEL, system: '你是图片文字识别助手，只输出 JSON。', user, images: [image], reasoningEffort: 'low', label: '封面核对' });
  } catch (err) {
    rethrowIfBalance(err);
    return 'error';
  }
  const seen = (res as { title?: unknown } | null)?.title;
  return typeof seen === 'string' && normalizeTitle(seen) === normalizeTitle(title) ? 'ok' : 'mismatch';
}

const clip = (text: string, max: number): string => Array.from(text.trim()).slice(0, max).join('');

/** 兜底标题：第一张 hook 卡片的 headline（kicker 作小标题），没有时取第一句字幕；精炼标题由调用方另行用 LLM 生成 */
export function coverTitle(storyboard: Storyboard, captions: TimedCaption[]): { title: string; subtitle?: string } {
  const card = storyboard.shots.find((s) => s.card?.template === 'hook')?.card;
  const hook = card?.template === 'hook' ? card.props : undefined;
  const source = hook?.headline ?? captions.find((c) => c.text.trim())?.text;
  if (!source?.trim()) throw new Error('无法确定封面标题：分镜里没有 hook 卡片，也没有字幕');
  return { title: clip(source, COVER_TITLE_MAX), ...(hook?.kicker ? { subtitle: clip(hook.kicker, COVER_SUBTITLE_MAX) } : {}) };
}

export interface ArtOptions {
  task: TaskClient; client: LlmClient; style: CoverStyleId; title: string; subtitle?: string; aspect: CoverAspect; dest: string; download?: Download;
  /** 每次生图前检查预算；缺省不检查 */
  meter?: CostMeter;
}
export interface ArtResult {
  /** 本次实际生图次数（复用时为 0） */
  attempts: number; costYuan: number; verified: boolean;
  /** 最后一次标题核对结果（复用时按旁注：verified 为 ok，否则 mismatch） */
  check: TitleCheck;
  /** 是否直接复用了磁盘上已付费的底图 */
  reused: boolean;
}

/** 底图旁注（cover-art-<比例>.json）：记录这张已付费底图对应的风格、标题与核对结果，下次同参数直接复用 */
interface ArtNote { style: CoverStyleId; title: string; subtitle: string | null; aspect: CoverAspect; verified: boolean }

const notePath = (dest: string): string => dest.replace(/\.png$/i, '.json');
const noteOf = (o: ArtOptions, verified: boolean): ArtNote => ({ style: o.style, title: o.title, subtitle: o.subtitle ?? null, aspect: o.aspect, verified });
const writeNote = (o: ArtOptions, verified: boolean): void => writeFileSync(notePath(o.dest), `${JSON.stringify(noteOf(o, verified))}\n`);

/** 底图存在且旁注参数一致时返回旁注；旁注缺失、损坏或参数不同都返回 null（重新生成） */
function reusableNote(o: ArtOptions): ArtNote | null {
  if (!existsSync(o.dest) || !existsSync(notePath(o.dest))) return null;
  try {
    const note = JSON.parse(readFileSync(notePath(o.dest), 'utf8')) as ArtNote;
    const want = noteOf(o, note.verified);
    const same = (['style', 'title', 'subtitle', 'aspect'] as const).every((k) => note[k] === want[k]);
    return same && typeof note.verified === 'boolean' ? note : null;
  } catch {
    return null;
  }
}

const yuan = (v: number): number => Math.round(v * 100) / 100;

/**
 * 生成底图并核对标题：识别不一致时重生一次，仍不一致保留第二次结果并标注 verified=false；
 * 读图模型出错时不重生（保留第一张，标注未核对）。磁盘上已有同参数的底图（见旁注）时直接复用，不再花钱。
 * 每次生图前都查预算：重生时预算不够就不重生，保留当前底图并标注未核对；第一张就没预算则报错。
 */
export async function generateVerifiedArt(o: ArtOptions): Promise<ArtResult> {
  const note = reusableNote(o);
  if (note) return { attempts: 0, costYuan: 0, verified: note.verified, check: note.verified ? 'ok' : 'mismatch', reused: true };
  let costYuan = 0;
  let kept: ArtResult | undefined;
  for (let attempts = 1; ; attempts += 1) {
    if (o.meter && !o.meter.canSpend(COVER_ART_YUAN)) {
      if (kept) return kept;
      throw new Error(`预算不足，无法生成封面底图（剩余 ¥${o.meter.remaining().toFixed(2)}，约需 ¥${COVER_ART_YUAN.toFixed(2)}）`);
    }
    const { cost } = await generateCoverArt(o.task, o.style, o.title, o.subtitle, o.aspect, o.dest, o.download);
    costYuan += cost ?? 0;
    writeNote(o, false); // 下载成功即记账：之后哪一步失败，重跑都能复用这张已付费的底图
    const check = await verifyTitle(o.client, o.dest, o.title);
    if (check === 'ok') writeNote(o, true);
    const result: ArtResult = { attempts, costYuan: yuan(costYuan), verified: check === 'ok', check, reused: false };
    if (check !== 'mismatch' || attempts >= MAX_ART_ATTEMPTS) return result;
    kept = result;
  }
}

export interface MakeCoversOptions {
  workDir: string; style: CoverStyleId; title: string; subtitle?: string; personVideo: string;
  cfg: AppConfig; task: TaskClient; client: LlmClient; download?: Download;
  /** 统一记账；生图前据此检查预算 */
  meter?: CostMeter;
}
export interface MakeCoversResult {
  cover34: string; cover43: string;
  /** 两种比例累计的生图次数 */
  attempts: number; costYuan: number;
  /** 重生后标题仍核对不通过的比例 */
  unverified: CoverAspect[];
  /** 是否在视频里抠到了人物（没有时封面不放人物，由调用方决定如何提示） */
  person: boolean;
  /** 直接复用磁盘上已付费底图的比例 */
  reused: CoverAspect[];
}

/**
 * 先本地选帧抠人物（不花钱；没抠到人时再试 2 个候选帧），再生成两种比例的底图并核对标题，最后用 Remotion 合成人物出图。
 * 抛错约定：生图、下载或渲染失败时直接抛出，此时可能已经花了钱；已下载的底图连同旁注留在 workDir，
 * 用相同的风格与标题重跑会直接复用，不会重复付费。
 */
export async function makeCovers(opts: MakeCoversOptions): Promise<MakeCoversResult> {
  const sec = await pickPersonFrame(opts.personVideo, opts.cfg, opts.client);
  const fadeCutSides = !COVER_STYLES[opts.style].personStyle.outline;
  const person = await cutoutPersonWithRetry(opts.personVideo, sec, join(opts.workDir, PERSON_FILE), opts.cfg, { fadeCutSides });
  const art = (aspect: CoverAspect): Promise<ArtResult> => generateVerifiedArt({ ...opts, aspect, dest: join(opts.workDir, `cover-art-${FILE_TAG[aspect]}.png`) });
  const art34 = await art('3:4');
  const art43 = await art('4:3');
  const cover34 = join(opts.workDir, 'cover-3x4.png');
  const cover43 = join(opts.workDir, 'cover-4x3.png');
  const props = (aspect: CoverAspect) => ({ bg: `cover-art-${FILE_TAG[aspect]}.png`, person: person ? PERSON_FILE : '', style: opts.style });
  await renderCoverStills(opts.workDir, [{ id: 'Cover34', props: props('3:4'), output: cover34 }, { id: 'Cover43', props: props('4:3'), output: cover43 }]);
  return {
    cover34, cover43, person,
    attempts: art34.attempts + art43.attempts,
    costYuan: yuan(art34.costYuan + art43.costYuan),
    unverified: ([['3:4', art34], ['4:3', art43]] as const).filter(([, a]) => !a.verified).map(([aspect]) => aspect),
    reused: ([['3:4', art34], ['4:3', art43]] as const).filter(([, a]) => a.reused).map(([aspect]) => aspect),
  };
}
