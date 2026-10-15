import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { LlmClient } from '../llm/kexiang.js';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import type { Download } from '../broll/generate-media.js';
import type { Storyboard } from '../storyboard/schema.js';
import type { TimedCaption } from '../captions/lines.js';
import { renderCoverStills } from '../compose/render.js';
import { COVER_STYLES, slotRegion, type CoverStyleId } from './styles.js';
import { cutoutPerson, pickPersonFrame } from './person.js';

export const COVER_MODEL = 'GPT-Image-2-Official';
export const TITLE_CHECK_MODEL = 'google/gemini-3.5-flash';
export type CoverAspect = '3:4' | '4:3';

/** 标题核对不通过时最多生成几次（含第一次） */
const MAX_ART_ATTEMPTS = 2;
const TITLE_MAX = 14;
const SUBTITLE_MAX = 16;
const ORIENT: Record<CoverAspect, string> = { '3:4': '竖版 3:4', '4:3': '横版 4:3' };
const FILE_TAG: Record<CoverAspect, string> = { '3:4': '3x4', '4:3': '4x3' };
const PERSON_FILE = 'cover-person.png';

const pct = (v: number): number => Math.round(v * 100);

/** 生图提示词：风格描述 + 标题原文 + 小标题 + 与人物放置区一致的留白 + 不要人物 + 印刷质感 */
export function coverPrompt(style: CoverStyleId, title: string, subtitle: string | undefined, aspect: CoverAspect): string {
  const { prompt, personSlot } = COVER_STYLES[style];
  const region = slotRegion(personSlot);
  const sub = subtitle ? `，标题下方配小字「${subtitle}」` : '';
  return [
    `${prompt}。短视频封面，${ORIENT[aspect]}。`,
    `${region.title}大号中文标题「${title}」（逐字照抄，不增删、不改字）${sub}。`,
    `画面${region.blank}留出一大片干净的空白区域（约占画面宽度的 ${pct(personSlot.w)}%、高度的 ${pct(personSlot.h)}%），用于之后放置人物照片，这片区域里不要放文字和主要图形。`,
    `画面中不要出现任何人物、人脸、手或身体部位；除${subtitle ? '标题与小字' : '标题'}外不要出现其他文字、字母或 logo，无水印。排版严谨，印刷级海报质感。`,
  ].join('');
}

/** GPT Image 2 文生图：对应比例 / 1k / medium / png，约 50 秒、¥0.6 一张 */
export async function generateCoverArt(task: TaskClient, style: CoverStyleId, title: string, subtitle: string | undefined, aspect: CoverAspect, dest: string, download: Download = downloadTo): Promise<{ cost?: number }> {
  const { url, cost } = await task.run(
    { modelName: COVER_MODEL, modelType: 'text2img', prompt: coverPrompt(style, title, subtitle, aspect), size: aspect, resolution: '1k', quality: 'medium', output_format: 'png' },
    { kind: 'image' },
  );
  await download(url, dest);
  return cost !== undefined ? { cost } : {};
}

/** 标题比对用的归一化：全角转半角（NFKC）、拉丁字母转小写、去掉空白与标点 */
export function normalizeTitle(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[\s\p{P}]/gu, '');
}

/** 读图模型识别底图上的标题，归一化后与原文相等才算通过；模型出错或答非所问都算不通过 */
export async function verifyTitle(client: LlmClient, png: string, title: string): Promise<boolean> {
  const image = `data:image/png;base64,${readFileSync(png).toString('base64')}`;
  const user = '读出这张封面图上最大、最醒目的标题文字，逐字照录（不要纠错、不要补全，换行处直接连起来）。只输出 JSON：{"title": "标题原文"}';
  try {
    const res = await client.chatJson({ model: TITLE_CHECK_MODEL, system: '你是图片文字识别助手，只输出 JSON。', user, images: [image], reasoningEffort: 'low' });
    const seen = (res as { title?: unknown } | null)?.title;
    return typeof seen === 'string' && normalizeTitle(seen) === normalizeTitle(title);
  } catch {
    return false;
  }
}

const clip = (text: string, max: number): string => Array.from(text.trim()).slice(0, max).join('');

/** 兜底标题：第一张 hook 卡片的 headline（kicker 作小标题），没有时取第一句字幕；精炼标题由调用方另行用 LLM 生成 */
export function coverTitle(storyboard: Storyboard, captions: TimedCaption[]): { title: string; subtitle?: string } {
  const card = storyboard.shots.find((s) => s.card?.template === 'hook')?.card;
  const hook = card?.template === 'hook' ? card.props : undefined;
  const source = hook?.headline ?? captions.find((c) => c.text.trim())?.text;
  if (!source?.trim()) throw new Error('无法确定封面标题：分镜里没有 hook 卡片，也没有字幕');
  return { title: clip(source, TITLE_MAX), ...(hook?.kicker ? { subtitle: clip(hook.kicker, SUBTITLE_MAX) } : {}) };
}

export interface ArtOptions { task: TaskClient; client: LlmClient; style: CoverStyleId; title: string; subtitle?: string; aspect: CoverAspect; dest: string; download?: Download }
export interface ArtResult { attempts: number; costYuan: number; verified: boolean }

const yuan = (v: number): number => Math.round(v * 100) / 100;

/** 生成底图并核对标题；不通过重生一次，仍不通过保留第二次结果并标注 verified=false */
export async function generateVerifiedArt(o: ArtOptions): Promise<ArtResult> {
  let costYuan = 0;
  for (let attempts = 1; ; attempts += 1) {
    const { cost } = await generateCoverArt(o.task, o.style, o.title, o.subtitle, o.aspect, o.dest, o.download);
    costYuan += cost ?? 0;
    const verified = await verifyTitle(o.client, o.dest, o.title);
    if (verified || attempts >= MAX_ART_ATTEMPTS) return { attempts, costYuan: yuan(costYuan), verified };
  }
}

export interface MakeCoversOptions {
  workDir: string; style: CoverStyleId; title: string; subtitle?: string; personVideo: string;
  cfg: AppConfig; task: TaskClient; client: LlmClient; download?: Download;
}
export interface MakeCoversResult {
  cover34: string; cover43: string;
  /** 两种比例累计的生图次数 */
  attempts: number; costYuan: number;
  /** 重生后标题仍核对不通过的比例 */
  unverified: CoverAspect[];
  /** 是否在视频里抠到了人物（没有时封面不放人物） */
  person: boolean;
}

/** 先本地抠人物（失败时不花钱），再生成两种比例的底图并核对标题，最后用 Remotion 合成人物出图 */
export async function makeCovers(opts: MakeCoversOptions): Promise<MakeCoversResult> {
  const sec = await pickPersonFrame(opts.personVideo, opts.cfg, opts.client);
  const fadeCutSides = !COVER_STYLES[opts.style].personStyle.outline;
  const person = await cutoutPerson(opts.personVideo, sec, join(opts.workDir, PERSON_FILE), opts.cfg, { fadeCutSides });
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
  };
}
