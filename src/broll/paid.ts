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
/** 全屏与画中画按手机竖屏截，分屏与浮层按 4:5 截上半部（标题区） */
const VIEWPORT = { full: { width: 1080, height: 1920 }, half: { width: 1080, height: 1350 } } as const;
const IMAGE_SIZE: Record<Beat['present'], string> = { 'broll-full': '9:16', pip: '9:16', split: '4:3', overlay: '16:9' };

const short = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 12);
const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };
const reason = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * 截图网址：模型给的 urlHint 只是记忆，必须联网核实——搜索结果里有同一域名才用它；否则用搜索给出的网址。
 * 搜索词优先中文（机构、产品名），没有就用 subject
 */
export async function verifiedUrls(deps: Pick<PaidDeps, 'search'>, beat: Beat): Promise<string[]> {
  const topic = beat.queryZh[0] ?? beat.subject;
  const hintHost = beat.urlHint ? hostOf(beat.urlHint) : '';
  const found = await deps.search(hintHost ? `${hintHost} ${topic}` : topic);
  const verified = beat.urlHint && found.some((u) => hostOf(u) === hintHost) ? [beat.urlHint, ...found.filter((u) => u !== beat.urlHint)] : found;
  return verified.slice(0, MAX_SHOTS);
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

/** 截图候选：联网核实网址后逐个截（预算不够就不搜）；失败的网址跳过，原因写进 errors */
export async function screenshotCandidates(env: BeatEnv, deps: PaidDeps, beat: Beat, errors: string[]): Promise<Candidate[]> {
  if (!env.budget.canAfford(EST_YUAN.search)) { errors.push('预算不足，跳过联网核实网址'); return []; }
  let urls: string[];
  try {
    urls = await verifiedUrls(deps, beat);
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    errors.push(`联网搜索失败：${reason(err)}`);
    return [];
  }
  const size = isFullPresent(beat.present) ? VIEWPORT.full : VIEWPORT.half;
  const dir = join(env.workDir, 'broll', 'src');
  mkdirSync(dir, { recursive: true });
  const out: Candidate[] = [];
  for (const url of urls) {
    const file = join(dir, `shot-${short(`${url}|${size.height}`)}.png`);
    try {
      if (!existsSync(file)) await produce(file, (tmp) => deps.screenshot(url, tmp, size));
      out.push({ ...baseCandidate(file, size), id: `screenshot:${url}`, source: 'screenshot', page: url, author: hostOf(url), license: SCREENSHOT_LICENSE, attributionRequired: true, aiGenerated: false });
    } catch (err) {
      rethrowIfBalance(err);
      rethrowIfCancelled(err);
      errors.push(`截图失败 ${hostOf(url)}：${reason(err).slice(0, 120)}`);
    }
  }
  return out;
}

/** 生图提示词：英文搜索词 + 画面描述 + 必须出现的元素 + 构图方向（影调模板与禁用词由生图函数统一追加） */
export function imagePrompt(beat: Beat): string {
  const must = beat.mustShow.length > 0 ? ` Must show: ${beat.mustShow.join(', ')}.` : '';
  const frame = isFullPresent(beat.present) ? 'vertical 9:16 frame, subject centered' : 'horizontal frame, subject centered';
  return `${beat.queryEn.join('; ')}. ${beat.subject}.${must} Realistic documentary photo, ${frame}, no readable text, no logos, no recognizable faces.`;
}

/** 兜底生图候选（GPT Image，按呈现方式的比例出图）；预算不够或失败返回 undefined，原因写进 errors */
export async function generatedCandidate(env: BeatEnv, deps: PaidDeps, beat: Beat, errors: string[]): Promise<{ candidate: Candidate; url?: string } | undefined> {
  if (!env.budget.canAfford(EST_YUAN.image)) { errors.push('预算不足，跳过兜底生图'); return undefined; }
  const prompt = imagePrompt(beat);
  const file = join(env.workDir, 'broll', 'src', `gen-${short(`${prompt}|${IMAGE_SIZE[beat.present]}`)}.jpg`);
  mkdirSync(dirname(file), { recursive: true });
  try {
    let url: string | undefined;
    if (!existsSync(file)) await produce(file, async (tmp) => {
      const r = await deps.image(prompt, tmp, { size: IMAGE_SIZE[beat.present] });
      env.budget.note(r.cost ?? EST_YUAN.image);
      url = r.url;
    });
    const size = await imageSize(env.ffmpeg, file);
    const candidate: Candidate = { ...baseCandidate(file, size), id: `generated:${basename(file)}`, source: 'generated', page: 'AI 生成', license: GENERATED_LICENSE, attributionRequired: false, aiGenerated: true };
    return { candidate, ...(url ? { url } : {}) };
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
    errors.push(`生图失败：${reason(err).slice(0, 120)}`);
    return undefined;
  }
}
