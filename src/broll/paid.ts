import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { rethrowIfCancelled } from '../cancel.js';
import { run } from '../media/exec.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { EST_YUAN } from './budget.js';
import { isFullPresent } from './gather.js';
import type { Beat } from './plan.js';
import type { BeatEnv } from './realize.js';
import type { Candidate } from './sources/types.js';
import { hostOf, verifiedOrder } from './verify-url.js';

/** 付费来源：联网核实网址后截图、GPT Image 生图（兜底）、Seedance 图生视频 */
export interface PaidDeps {
  /** 联网搜索（gpt-5.6-luna web_search），返回带出处的网址 */
  search(query: string): Promise<string[]>;
  screenshot(url: string, out: string, size?: { width: number; height: number }): Promise<void>;
  /** 生图；url 是生成图的公网地址（图生视频要用） */
  image(prompt: string, out: string, opts?: { size?: string }): Promise<{ cost?: number; url?: string }>;
}

export const SCREENSHOT_LICENSE = '网页截图（介绍性引用，标注来源）';
export const GENERATED_LICENSE = 'AI 生成（GPT Image）';
const MAX_SHOTS = 2;
/** 截图只截首屏 1080×1350（页面与标题区），配合不加载图片；全屏插入不用截图，统一铺上半屏 */
export const SCREENSHOT_VIEWPORT = { width: 1080, height: 1350 } as const;
const IMAGE_SIZE: Record<Beat['present'], string> = { 'broll-full': '9:16', pip: '9:16', split: '4:3', overlay: '16:9' };

const short = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 截图网址：模型给的 urlHint 只是记忆，必须联网核实——搜索结果里有完全相同的网址才用它；
 * 只对上域名时用搜索结果里同域名的那条（路径可能是模型编的，截出来是 404），否则用搜索给出的网址。搜索词优先中文（机构、产品名），没有就用 subject
 */
export async function verifiedUrls(deps: Pick<PaidDeps, 'search'>, beat: Beat): Promise<string[]> {
  const topic = beat.queryZh[0] ?? beat.subject;
  const hint = beat.urlHint;
  const hintHost = hint ? hostOf(hint) : '';
  const found = await deps.search(hintHost ? `${hintHost} ${topic}` : topic);
  return verifiedOrder(hint, found).slice(0, MAX_SHOTS);
}

/** 先写临时文件，非空再改名 */
async function produce(out: string, fn: (tmp: string) => Promise<unknown>): Promise<void> {
  const tmp = out.replace(/\.(\w+)$/, '.part.$1');
  rmSync(tmp, { force: true });
  try {
    await fn(tmp);
    if (!existsSync(tmp) || statSync(tmp).size === 0) throw new Error('没有生成文件');
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 读图片像素尺寸（ffprobe） */
export async function imageSize(ffmpeg: string, file: string): Promise<{ width: number; height: number }> {
  const ffprobe = join(dirname(ffmpeg), basename(ffmpeg).replace(/ffmpeg/i, 'ffprobe'));
  const { stdout } = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0:s=x', file]);
  const [width, height] = stdout.trim().split('x').map(Number);
  if (!width || !height) throw new Error(`读不出图片尺寸：${file}`);
  return { width, height };
}

const baseCandidate = (file: string, size: { width: number; height: number }): Pick<Candidate, 'kind' | 'thumb' | 'url' | 'width' | 'height'> =>
  ({ kind: 'photo', thumb: file, url: file, ...size });

export interface Paid<T> { value: T; errors: string[] }

/** 截一个网址；失败返回原因 */
async function shoot(deps: PaidDeps, dir: string, url: string): Promise<Candidate | string> {
  const size = SCREENSHOT_VIEWPORT;
  const file = join(dir, `shot-${short(`${url}|${size.height}`)}.png`);
  try {
    if (!existsSync(file)) await produce(file, (tmp) => deps.screenshot(url, tmp, size));
    return { ...baseCandidate(file, size), id: `screenshot:${url}`, source: 'screenshot', page: url, author: hostOf(url), license: SCREENSHOT_LICENSE, attributionRequired: true, aiGenerated: false };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return `截图失败 ${hostOf(url)}：${reason(err).slice(0, 120)}`;
  }
}

/** 截图候选：联网核实网址后逐个截（预算不够就不搜）；失败的网址跳过，原因放进 errors */
export async function screenshotCandidates(env: BeatEnv, deps: PaidDeps, beat: Beat): Promise<Paid<Candidate[]>> {
  if (!env.budget.canAfford(EST_YUAN.search)) return { value: [], errors: ['预算不足，跳过联网核实网址'] };
  let urls: string[];
  try {
    urls = await verifiedUrls(deps, beat);
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { value: [], errors: [`联网搜索失败：${reason(err)}`] };
  }
  const dir = join(env.workDir, 'broll', 'src');
  mkdirSync(dir, { recursive: true });
  const shots = await Promise.all(urls.map((u) => shoot(deps, dir, u)));
  return { value: shots.filter((x): x is Candidate => typeof x !== 'string'), errors: shots.filter((x): x is string => typeof x === 'string') };
}

/** 生图提示词：英文搜索词 + 画面描述 + 必须出现的元素 + 构图方向（影调模板与禁用词由生图函数统一追加）；variant > 0 时换角度重新构图（「换一张」要拿到新图） */
export function imagePrompt(beat: Beat, variant = 0): string {
  const must = beat.mustShow.length > 0 ? ` Must show: ${beat.mustShow.join(', ')}.` : '';
  const frame = isFullPresent(beat.present) ? 'vertical 9:16 frame, subject centered' : 'horizontal frame, subject centered';
  const alt = variant > 0 ? ` Variation ${variant}: a different camera angle, distance and composition from earlier shots.` : '';
  return `${beat.queryEn.join('; ')}. ${beat.subject}.${must} Realistic documentary photo, ${frame}, no readable text, no logos, no recognizable faces.${alt}`;
}

/** 生图预估：方图 1k 约 ¥0.2，竖屏横屏 2k 约 ¥0.3 */
export const imageYuan = (beat: Beat): number => (IMAGE_SIZE[beat.present] === '1:1' ? EST_YUAN.image : EST_YUAN.imageWide);

const genFile = (env: BeatEnv, beat: Beat, variant: number): string =>
  join(env.workDir, 'broll', 'src', `gen-${short(`${imagePrompt(beat, variant)}|${IMAGE_SIZE[beat.present]}`)}.jpg`);
export const generatedId = (file: string): string => `generated:${basename(file)}`;

/** 第一个没用过的变体序号：同一个 beat 第 n 次生成用第 n 个变体，缓存键随之不同 */
export function variantFor(env: BeatEnv, beat: Beat, usedIds: readonly string[]): number {
  let v = 0;
  while (usedIds.includes(generatedId(genFile(env, beat, v)))) v += 1;
  return v;
}

/** 兜底生图候选（GPT Image，按呈现方式的比例出图）；variant 见 variantFor。预算不够或失败时 value 为 undefined，原因在 errors */
export async function generatedCandidate(env: BeatEnv, deps: PaidDeps, beat: Beat, variant = 0): Promise<Paid<{ candidate: Candidate; url?: string } | undefined>> {
  const est = imageYuan(beat);
  const file = genFile(env, beat, variant);
  if (!existsSync(file) && !env.budget.canAfford(est)) return { value: undefined, errors: ['预算不足，跳过兜底生图'] };
  mkdirSync(dirname(file), { recursive: true });
  try {
    let url: string | undefined;
    if (!existsSync(file)) await produce(file, async (tmp) => {
      const r = await deps.image(imagePrompt(beat, variant), tmp, { size: IMAGE_SIZE[beat.present] });
      env.budget.note(r.cost ?? est);
      url = r.url;
    });
    const size = await imageSize(env.ffmpeg, file);
    const candidate: Candidate = { ...baseCandidate(file, size), id: generatedId(file), source: 'generated', page: 'AI 生成', license: GENERATED_LICENSE, attributionRequired: false, aiGenerated: true };
    return { value: { candidate, ...(url ? { url } : {}) }, errors: [] };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    return { value: undefined, errors: [`生图失败：${reason(err).slice(0, 120)}`] };
  }
}
