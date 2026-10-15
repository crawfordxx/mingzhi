import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import type { Storyboard, Visual } from '../storyboard/schema.js';
import { visualsOf, type VisualNeed } from '../storyboard/visuals.js';
import { generateImage, generateVideo, searchPexels } from './generate-media.js';
import { screenshotUrl } from './screenshot.js';
import { searchUrls } from './search.js';

export interface BrollAsset { key: string; file: string; source: 'screenshot' | 'generate' | 'pexels' | 'video'; url?: string; cost?: number }
export interface BrollDeps {
  screenshot(url: string, out: string): Promise<void>;
  search(query: string): Promise<string[]>;
  image(prompt: string, out: string): Promise<{ cost?: number }>;
  video(prompt: string, out: string): Promise<{ cost?: number }>;
  pexels?(query: string, out: string): Promise<boolean>;
}
export interface FulfillOptions {
  workDir: string;
  /** 分镜总时长（秒），最后一次归一化要用 */
  durationSec: number;
  maxVideos: number;
  budgetYuan: number;
  onAsset?: (a: BrollAsset | { key: string; failed: string }) => void;
}
export interface FulfillResult { storyboard: Storyboard; assets: BrollAsset[]; failures: { shotIndex: number; reason: string }[]; costYuan: number }

/** 单次付费请求的预估花费（元），用于发起前的预算检查；接口没返回 cost 时也按它计 */
const EST_IMAGE_YUAN = 0.2;
const EST_VIDEO_YUAN = 2.4;
const OVER_BUDGET = '超出预算';
const SEARCH_TRIES = 2;
const PEXELS_WORDS = 6;

type Attempt = { asset: BrollAsset } | { reason: string };
interface Env { deps: BrollDeps; workDir: string; budgetYuan: number; maxVideos: number }
interface Spend { yuan: number; videos: number }

/** 素材需求的缓存键：需求内容相同则文件相同 */
export function visualKey(v: Visual): string {
  return createHash('sha1').update(JSON.stringify(v)).digest('hex').slice(0, 12);
}

export function makeDeps(opts: { apiKey: string; task: TaskClient; cfg: AppConfig; pexelsKey?: string }): BrollDeps {
  const { apiKey, task, cfg, pexelsKey } = opts;
  return {
    screenshot: (url, out) => screenshotUrl(url, out),
    search: (query) => searchUrls(apiKey, query, { max: SEARCH_TRIES }),
    image: (prompt, out) => generateImage(task, prompt, out),
    video: (prompt, out) => generateVideo(task, prompt, out, cfg),
    ...(pexelsKey ? { pexels: (query: string, out: string) => searchPexels(pexelsKey, query, out) } : {}),
  };
}

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const relFile = (key: string, ext: string): string => `broll/${key}.${ext}`;
const spendOf = (assets: BrollAsset[]): Spend => ({ yuan: assets.reduce((s, a) => s + (a.cost ?? 0), 0), videos: assets.filter((a) => a.source === 'video').length });

/** 执行一次产出：成功返回 deps 的结果，失败（抛错或没写出文件）返回原因，并清掉残留文件以免被当成缓存 */
async function produce<T extends { cost?: number } | boolean | void>(out: string, fn: () => Promise<T>): Promise<{ result: T } | string> {
  try {
    const result = await fn();
    if (result === false) return '没有结果';
    if (!existsSync(out)) return '未生成文件';
    return { result };
  } catch (err) {
    rmSync(out, { force: true });
    return message(err);
  }
}

const costOf = (result: unknown, estimate: number): number => (typeof result === 'object' && result !== null && typeof (result as { cost?: unknown }).cost === 'number' ? (result as { cost: number }).cost : estimate);

/** 按来源在缓存里找已有文件：截图 png（或退化成的 jpg）、生图 jpg、视频 mp4（或退化成的 jpg） */
function findCached(env: Env, key: string, source: Visual['source']): BrollAsset | undefined {
  const candidates: [string, BrollAsset['source']][] = source === 'screenshot' ? [['png', 'screenshot'], ['jpg', 'generate']] : source === 'video' ? [['mp4', 'video'], ['jpg', 'generate']] : [['jpg', 'generate']];
  const hit = candidates.find(([ext]) => existsSync(join(env.workDir, relFile(key, ext))));
  return hit ? { key, file: relFile(key, hit[0]), source: hit[1] } : undefined;
}

async function tryScreenshot(env: Env, key: string, need: { url?: string; query?: string }): Promise<Attempt> {
  const file = relFile(key, 'png');
  let urls: string[];
  try {
    urls = need.url ? [need.url] : (await env.deps.search(need.query ?? '')).slice(0, SEARCH_TRIES);
  } catch (err) {
    return { reason: `搜索失败：${message(err)}` };
  }
  if (urls.length === 0) return { reason: '没有找到可截图的网址' };
  let lastReason = '';
  for (const url of urls) {
    const out = join(env.workDir, file);
    const r = await produce(out, () => env.deps.screenshot(url, out));
    if (typeof r !== 'string') return { asset: { key, file, source: 'screenshot', url } };
    lastReason = r;
  }
  return { reason: `截图失败：${lastReason}` };
}

async function tryImage(env: Env, key: string, prompt: string, spend: Spend): Promise<Attempt> {
  if (spend.yuan + EST_IMAGE_YUAN > env.budgetYuan) return { reason: OVER_BUDGET };
  const file = relFile(key, 'jpg');
  const out = join(env.workDir, file);
  const r = await produce(out, () => env.deps.image(prompt, out));
  return typeof r === 'string' ? { reason: `生图失败：${r}` } : { asset: { key, file, source: 'generate', cost: costOf(r.result, EST_IMAGE_YUAN) } };
}

async function tryPexels(env: Env, key: string, prompt: string): Promise<Attempt> {
  const pexels = env.deps.pexels;
  if (!pexels) return { reason: '未配置图库' };
  const file = relFile(key, 'jpg');
  const out = join(env.workDir, file);
  const r = await produce(out, () => pexels(prompt.split(/\s+/).slice(0, PEXELS_WORDS).join(' '), out));
  return typeof r === 'string' ? { reason: `图库失败：${r}` } : { asset: { key, file, source: 'pexels' } };
}

/** 生图优先，失败再试 Pexels（有依赖时），都失败放弃 */
async function tryGenerate(env: Env, key: string, prompt: string, spend: Spend): Promise<Attempt> {
  const img = await tryImage(env, key, prompt, spend);
  if ('asset' in img || !env.deps.pexels) return img;
  const px = await tryPexels(env, key, prompt);
  return 'asset' in px ? px : { reason: `${img.reason}；${px.reason}` };
}

/** 视频：达到 maxVideos 或预算不够时直接返回原因，由调用方退到生图 */
async function tryVideo(env: Env, key: string, prompt: string, spend: Spend): Promise<Attempt> {
  if (spend.videos >= env.maxVideos) return { reason: '视频数量已达上限' };
  if (spend.yuan + EST_VIDEO_YUAN > env.budgetYuan) return { reason: OVER_BUDGET };
  const file = relFile(key, 'mp4');
  const out = join(env.workDir, file);
  const r = await produce(out, () => env.deps.video(prompt, out));
  return typeof r === 'string' ? { reason: `生视频失败：${r}` } : { asset: { key, file, source: 'video', cost: costOf(r.result, EST_VIDEO_YUAN) } };
}

/** 按优先级取一份素材：截图（photo 失败退生图）、生成、视频（失败退生图） */
async function fetchAsset(env: Env, need: VisualNeed, key: string, spend: Spend): Promise<Attempt> {
  const v = need.visual;
  if (v.source === 'generate') return tryGenerate(env, key, v.prompt, spend);
  if (v.source === 'video') {
    const vid = await tryVideo(env, key, v.prompt, spend);
    return 'asset' in vid ? vid : tryGenerate(env, key, v.prompt, spend);
  }
  const shot = await tryScreenshot(env, key, v);
  if ('asset' in shot || need.template !== 'photo') return shot;
  const gen = await tryGenerate(env, key, `Editorial photo illustrating: ${v.query ?? v.url ?? ''}`, spend);
  return 'asset' in gen ? gen : { reason: `${shot.reason}；${gen.reason}` };
}

/** 把文件名（相对工作目录）写回对应镜头的卡片；visual 保留，返回新分镜 */
function applyAsset(storyboard: Storyboard, shotIndex: number, asset: BrollAsset): Storyboard {
  const shots = storyboard.shots.map((shot, i) => {
    const card = shot.card;
    if (i !== shotIndex || !card) return shot;
    if (card.template === 'hook') return { ...shot, card: { ...card, props: { ...card.props, ...(asset.source === 'video' ? { video: asset.file } : { image: asset.file }) } } };
    if (card.template === 'photo') return { ...shot, card: { ...card, props: { ...card.props, image: asset.file } } };
    if (card.template === 'browser') return { ...shot, card: { ...card, props: { ...card.props, image: asset.file } } };
    return shot;
  });
  return { shots };
}

/** 取不到素材的 photo 去掉 visual：归一化时 photo 既无图也无 visual 才会被丢弃并补成全屏（browser / hook 无图也能显示，保留 visual） */
function giveUpPhoto(storyboard: Storyboard, need: VisualNeed): Storyboard {
  if (need.template !== 'photo') return storyboard;
  const shots = storyboard.shots.map((shot, i) => {
    const card = shot.card;
    if (i !== need.shotIndex || card?.template !== 'photo') return shot;
    const { visual: _visual, ...props } = card.props;
    return { ...shot, card: { ...card, props } };
  });
  return { shots };
}

/** 分镜里已有且文件真实存在的 image / video 引用（归一化时不能因为不在本次获取列表里被误删） */
function existingFiles(storyboard: Storyboard, workDir: string): string[] {
  return storyboard.shots.flatMap((s) => {
    const props = s.card && 'props' in s.card ? (s.card.props as { image?: string; video?: string }) : {};
    return [props.image, props.video].filter((f): f is string => f !== undefined && existsSync(join(workDir, f)));
  });
}

/**
 * 严格串行（可想套餐同时只跑 1 个任务）取回分镜里的全部素材需求并写回卡片。
 * 单个素材失败不抛错，只记入 failures；最后再归一化一次，拿不到图的 photo 会被丢弃并补成全屏。
 */
export async function fulfillVisuals(storyboard: Storyboard, deps: BrollDeps, opts: FulfillOptions): Promise<FulfillResult> {
  mkdirSync(join(opts.workDir, 'broll'), { recursive: true });
  const env: Env = { deps, workDir: opts.workDir, budgetYuan: opts.budgetYuan, maxVideos: opts.maxVideos };
  let current = storyboard;
  let assets: BrollAsset[] = [];
  let failures: FulfillResult['failures'] = [];
  for (const need of visualsOf(storyboard)) {
    const key = visualKey(need.visual);
    const cached = findCached(env, key, need.visual.source);
    const outcome: Attempt = cached ? { asset: cached } : await fetchAsset(env, need, key, spendOf(assets));
    if ('asset' in outcome) {
      assets = [...assets, outcome.asset];
      current = applyAsset(current, need.shotIndex, outcome.asset);
      opts.onAsset?.(outcome.asset);
    } else {
      failures = [...failures, { shotIndex: need.shotIndex, reason: outcome.reason }];
      current = giveUpPhoto(current, need);
      opts.onAsset?.({ key, failed: outcome.reason });
    }
  }
  const files = [...assets.map((a) => a.file), ...existingFiles(storyboard, opts.workDir)];
  const normalized = normalizeStoryboard(current, opts.durationSec, files).storyboard;
  return { storyboard: normalized, assets, failures, costYuan: spendOf(assets).yuan };
}
