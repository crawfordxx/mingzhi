import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { EST_TASK_YUAN } from '../cost/constants.js';
import { SEARCH_YUAN } from '../cost/estimate.js';
import type { CostMeter } from '../cost/meter.js';
import { rethrowIfBalance } from '../llm/errors.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import type { Storyboard, Visual } from '../storyboard/schema.js';
import { visualsOf, type VisualNeed } from '../storyboard/visuals.js';
import { generateImage, generateVideo, searchPexels } from './generate-media.js';
import { screenshotUrl } from './screenshot.js';
import { searchUrls } from './search.js';

export interface BrollAsset { key: string; file: string; source: 'screenshot' | 'generate' | 'pexels' | 'video'; url?: string; cost?: number; cached?: boolean }
export interface BrollDeps {
  screenshot(url: string, out: string): Promise<void>;
  search(query: string): Promise<string[]>;
  image(prompt: string, out: string): Promise<{ cost?: number }>;
  /** onStatus：长任务的状态回调（轮询到的状态文字），可选 */
  video(prompt: string, out: string, onStatus?: (status: string) => void): Promise<{ cost?: number }>;
  pexels?(query: string, out: string): Promise<boolean>;
}
export interface FulfillOptions {
  workDir: string;
  /** 分镜总时长（秒），最后一次归一化要用 */
  durationSec: number;
  maxVideos: number;
  /** 没有 meter 时才用它做预算检查（按本步已花费累计）；有 meter 时以 meter 为准 */
  budgetYuan: number;
  /** 统一记账：预算检查读 meter.canSpend（含前面步骤已花的钱）；costYuan 仅用于展示，不再参与预算判断 */
  meter?: CostMeter;
  /** 预算检查时给后续步骤（如封面）预留的花费（元），缺省 0 */
  reserveYuan?: number;
  /** 某个素材开始获取前回调（缓存命中不回调） */
  onStart?: (need: VisualNeed) => void;
  onAsset?: (a: BrollAsset | { key: string; failed: string }) => void;
  /** 视频任务的状态变化 */
  onStatus?: (status: string) => void;
}
/** failures[].shotIndex 指输入分镜（传入 fulfillVisuals 的 storyboard）的镜头下标；归一化可能合并或丢弃镜头，返回的 storyboard 下标可能不同 */
export interface FulfillResult { storyboard: Storyboard; assets: BrollAsset[]; failures: { shotIndex: number; reason: string }[]; costYuan: number }

/** 单次付费请求的预估花费（元），用于发起前的预算检查；接口没返回 cost 时也按它计 */
const EST_IMAGE_YUAN = EST_TASK_YUAN.image;
const EST_VIDEO_YUAN = EST_TASK_YUAN.video;
const EST_SEARCH_YUAN = SEARCH_YUAN;
const OVER_BUDGET = '超出预算';
const SEARCH_TRIES = 2;
const PEXELS_WORDS = 6;

type Attempt = { asset: BrollAsset } | { reason: string };
interface Env { deps: BrollDeps; workDir: string; budgetYuan: number; maxVideos: number; meter?: CostMeter; reserveYuan: number; onStatus?: (status: string) => void }
/** yuan：已花费；videos：已发起（含失败、含缓存命中）的视频请求数 */
interface Spend { yuan: number; videos: number }

/** 递归按键名排序后序列化，字段顺序不同的同一需求得到同一个缓存键 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 素材需求的缓存键：需求内容相同（与字段顺序无关）则文件相同 */
export function visualKey(v: Visual): string {
  return createHash('sha1').update(canonical(v)).digest('hex').slice(0, 12);
}

export function makeDeps(opts: { apiKey: string; task: TaskClient; cfg: AppConfig; pexelsKey?: string; meter?: CostMeter }): BrollDeps {
  const { apiKey, task, cfg, pexelsKey, meter } = opts;
  return {
    screenshot: (url, out) => screenshotUrl(url, out),
    search: (query) => searchUrls(apiKey, query, { max: SEARCH_TRIES, meter }),
    image: (prompt, out) => generateImage(task, prompt, out),
    video: (prompt, out, onStatus) => generateVideo(task, prompt, out, cfg, undefined, onStatus),
    ...(pexelsKey ? { pexels: (query: string, out: string) => searchPexels(pexelsKey, query, out) } : {}),
  };
}

/** 再花 estimate 元（并为后续步骤留出 reserveYuan）是否仍在预算内：有 meter 以 meter 为准，否则按本步已花费累计 */
const canAfford = (env: Env, spend: Spend, estimate: number): boolean => (env.meter ? env.meter.canSpend(estimate + env.reserveYuan) : spend.yuan + estimate + env.reserveYuan <= env.budgetYuan);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const relFile = (key: string, ext: string): string => `broll/${key}.${ext}`;
const yuanOf = (assets: BrollAsset[]): number => assets.reduce((s, a) => s + (a.cost ?? 0), 0);

/**
 * 执行一次产出：deps 先写到同目录的临时文件（key.part.ext，保留扩展名供 ffmpeg 判断格式），
 * 校验非空后再改名为正式文件，这样中途失败或进程被杀都不会留下看似有效的缓存。
 * 失败（抛错、没结果、没写出文件或文件为空）返回原因。
 */
async function produce<T extends { cost?: number } | boolean | void>(out: string, fn: (tmp: string) => Promise<T>): Promise<{ result: T } | string> {
  const tmp = out.replace(/\.(\w+)$/, '.part.$1');
  rmSync(tmp, { force: true });
  try {
    const result = await fn(tmp);
    if (result === false) return '没有结果';
    if (!existsSync(tmp)) return '未生成文件';
    if (statSync(tmp).size === 0) return '生成的文件为空';
    renameSync(tmp, out);
    return { result };
  } catch (err) {
    rethrowIfBalance(err); // 余额不足：不逐项重试，整条流程停下来让用户充值
    return message(err);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const costOf = (result: unknown, estimate: number): number => (typeof result === 'object' && result !== null && typeof (result as { cost?: unknown }).cost === 'number' ? (result as { cost: number }).cost : estimate);

/** 缓存文件必须存在且非空；空文件（异常中断的残留）删除后视为缺失 */
function validCache(path: string): boolean {
  if (!existsSync(path)) return false;
  if (statSync(path).size > 0) return true;
  rmSync(path, { force: true });
  return false;
}

/** 按来源在缓存里找已有文件：截图 png（或退化成的 jpg）、生图 jpg、视频 mp4（或退化成的 jpg）；视频已达 maxVideos 时不用缓存的 mp4 */
function findCached(env: Env, key: string, source: Visual['source'], videoRequests: number): BrollAsset | undefined {
  const videoAllowed = videoRequests < env.maxVideos;
  const candidates: [string, BrollAsset['source']][] = source === 'screenshot' ? [['png', 'screenshot'], ['jpg', 'generate']] : source === 'video' ? [...(videoAllowed ? [['mp4', 'video'] as [string, BrollAsset['source']]] : []), ['jpg', 'generate']] : [['jpg', 'generate']];
  const hit = candidates.find(([ext]) => validCache(join(env.workDir, relFile(key, ext))));
  return hit ? { key, file: relFile(key, hit[0]), source: hit[1], cached: true } : undefined;
}

async function tryScreenshot(env: Env, key: string, need: { url?: string; query?: string }, spend: Spend): Promise<Attempt> {
  const file = relFile(key, 'png');
  if (!need.url && !canAfford(env, spend, EST_SEARCH_YUAN)) return { reason: OVER_BUDGET };
  let urls: string[];
  try {
    urls = need.url ? [need.url] : (await env.deps.search(need.query ?? '')).slice(0, SEARCH_TRIES);
  } catch (err) {
    rethrowIfBalance(err);
    return { reason: `搜索失败：${message(err)}` };
  }
  if (urls.length === 0) return { reason: '没有找到可截图的网址' };
  let lastReason = '';
  for (const url of urls) {
    const r = await produce(join(env.workDir, file), (tmp) => env.deps.screenshot(url, tmp));
    if (typeof r !== 'string') return { asset: { key, file, source: 'screenshot', url } };
    lastReason = r;
  }
  return { reason: `截图失败：${lastReason}` };
}

async function tryImage(env: Env, key: string, prompt: string, spend: Spend): Promise<Attempt> {
  if (!canAfford(env, spend, EST_IMAGE_YUAN)) return { reason: OVER_BUDGET };
  const file = relFile(key, 'jpg');
  const r = await produce(join(env.workDir, file), (tmp) => env.deps.image(prompt, tmp));
  return typeof r === 'string' ? { reason: `生图失败：${r}` } : { asset: { key, file, source: 'generate', cost: costOf(r.result, EST_IMAGE_YUAN) } };
}

async function tryPexels(env: Env, key: string, term: string): Promise<Attempt> {
  const pexels = env.deps.pexels;
  if (!pexels) return { reason: '未配置图库' };
  const file = relFile(key, 'jpg');
  const r = await produce(join(env.workDir, file), (tmp) => pexels(term, tmp));
  return typeof r === 'string' ? { reason: `图库失败：${r}` } : { asset: { key, file, source: 'pexels' } };
}

const firstWords = (prompt: string): string => prompt.split(/\s+/).slice(0, PEXELS_WORDS).join(' ');

/** 生图优先，失败再试 Pexels（有依赖时），都失败放弃；Pexels 搜索词默认取提示词前 6 个单词，截图退化时传原始 query */
async function tryGenerate(env: Env, key: string, prompt: string, spend: Spend, pexelsTerm: string = firstWords(prompt)): Promise<Attempt> {
  const img = await tryImage(env, key, prompt, spend);
  if ('asset' in img || !env.deps.pexels) return img;
  const px = await tryPexels(env, key, pexelsTerm);
  return 'asset' in px ? px : { reason: `${img.reason}；${px.reason}` };
}

/** 视频：达到 maxVideos（尝试次数）或预算不够时不发起请求（tried=false），由调用方退到生图 */
async function tryVideo(env: Env, key: string, prompt: string, spend: Spend): Promise<{ attempt: Attempt; tried: boolean }> {
  if (spend.videos >= env.maxVideos) return { attempt: { reason: '视频数量已达上限' }, tried: false };
  if (!canAfford(env, spend, EST_VIDEO_YUAN)) return { attempt: { reason: OVER_BUDGET }, tried: false };
  const file = relFile(key, 'mp4');
  const r = await produce(join(env.workDir, file), (tmp) => env.deps.video(prompt, tmp, env.onStatus));
  const attempt: Attempt = typeof r === 'string' ? { reason: `生视频失败：${r}` } : { asset: { key, file, source: 'video', cost: costOf(r.result, EST_VIDEO_YUAN) } };
  return { attempt, tried: true };
}

/** 按优先级取一份素材：截图（photo 失败退生图）、生成、视频（失败退生图）；videoTried 表示是否发起过视频请求 */
async function fetchAsset(env: Env, need: VisualNeed, key: string, spend: Spend): Promise<{ outcome: Attempt; videoTried: boolean }> {
  const v = need.visual;
  if (v.source === 'generate') return { outcome: await tryGenerate(env, key, v.prompt, spend), videoTried: false };
  if (v.source === 'video') {
    const { attempt, tried } = await tryVideo(env, key, v.prompt, spend);
    return { outcome: 'asset' in attempt ? attempt : await tryGenerate(env, key, v.prompt, spend), videoTried: tried };
  }
  const shot = await tryScreenshot(env, key, v, spend);
  if ('asset' in shot || need.template !== 'photo') return { outcome: shot, videoTried: false };
  const original = v.query ?? v.url ?? '';
  const gen = await tryGenerate(env, key, `Editorial photo illustrating: ${original}`, spend, original);
  return { outcome: 'asset' in gen ? gen : { reason: `${shot.reason}；${gen.reason}` }, videoTried: false };
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
  return { ...storyboard, shots };
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
  return { ...storyboard, shots };
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
  const env: Env = { deps, workDir: opts.workDir, budgetYuan: opts.budgetYuan, maxVideos: opts.maxVideos, meter: opts.meter, reserveYuan: opts.reserveYuan ?? 0, onStatus: opts.onStatus };
  let current = storyboard;
  let assets: BrollAsset[] = [];
  let failures: FulfillResult['failures'] = [];
  let videoRequests = 0;
  for (const need of visualsOf(storyboard)) {
    const key = visualKey(need.visual);
    const cached = findCached(env, key, need.visual.source, videoRequests);
    if (!cached) opts.onStart?.(need);
    const { outcome, videoTried } = cached ? { outcome: { asset: cached } as Attempt, videoTried: cached.source === 'video' } : await fetchAsset(env, need, key, { yuan: yuanOf(assets), videos: videoRequests });
    videoRequests += videoTried ? 1 : 0;
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
  // 注意：最终归一化会去掉已取到素材的 photo 的 visual（既定行为：P5 的 regenerateVisual 编辑操作自带 visual）
  const normalized = normalizeStoryboard(current, opts.durationSec, files).storyboard;
  return { storyboard: normalized, assets, failures, costYuan: yuanOf(assets) };
}
