import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { EST_TASK_YUAN } from '../cost/constants.js';
import { SEARCH_YUAN } from '../cost/estimate.js';
import type { CostMeter } from '../cost/meter.js';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { rethrowIfBalance } from '../llm/errors.js';
import { normalizeStoryboard } from '../storyboard/normalize.js';
import type { Storyboard, Visual } from '../storyboard/schema.js';
import { visualsOf, type VisualNeed } from '../storyboard/visuals.js';
import type { NamedSource } from './gather.js';
import type { PexelsHit } from './generate-media.js';

/** page、author、authorUrl：图库（Pexels）素材的作品页与摄影师，写进授权记录 */
export interface BrollAsset { key: string; file: string; source: 'screenshot' | 'generate' | 'pexels' | 'video'; url?: string; cost?: number; cached?: boolean; page?: string; author?: string; authorUrl?: string }
export interface BrollDeps {
  /** size：截图视口（缺省 1080×1350） */
  screenshot(url: string, out: string, size?: { width: number; height: number }): Promise<void>;
  search(query: string): Promise<string[]>;
  /** 生图；url 为生成图的公网地址（图生视频要用），size 为比例（缺省 1:1） */
  image(prompt: string, out: string, opts?: { size?: string }): Promise<{ cost?: number; url?: string }>;
  /** Seedance 图生视频：以 imageUrl 为首帧（不做文生视频）；onStatus：长任务的状态回调 */
  video(prompt: string, imageUrl: string, out: string, onStatus?: (status: string) => void): Promise<{ cost?: number }>;
  /** Pexels 卡片兜底：返回作品页与摄影师（旧实现返回 true）；没有结果返回 false */
  pexels?(query: string, out: string): Promise<boolean | PexelsHit>;
  /** 免费图库来源（Wikimedia 免 key；Pexels、Pixabay 有 key 才有）；测试注入假来源，缺省为空 */
  sources?: NamedSource[];
  /** 下载图库素材用的 fetch（测试注入） */
  fetchImpl?: typeof fetch;
}
/** 钩子要视频时先生图，图生视频放到 B-roll 最后、预算还够时再做（videoWanted） */
export interface VideoWanted { shotIndex: number; key: string; prompt: string; imageUrl: string }
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
  /** 图生视频任务的状态变化（upgradeToVideo 用） */
  onStatus?: (status: string) => void;
  /** 取消信号：每个素材开始前检查，取消时抛 CancelledError */
  signal?: AbortSignal;
  /** 这些镜头的素材需求排到最后处理（工作台修改版本：先让没改动的卡片用上已付费的缓存，视频名额不被新卡片抢走） */
  deferShots?: number[];
  /** 统一的预算检查（B-roll 上限与项目预算）；给出时代替 meter / budgetYuan 的检查 */
  afford?: (estimate: number) => boolean;
}
/** failures[].shotIndex 指输入分镜（传入 fulfillVisuals 的 storyboard）的镜头下标；归一化可能合并或丢弃镜头，返回的 storyboard 下标可能不同 */
export interface FulfillResult { storyboard: Storyboard; assets: BrollAsset[]; failures: { shotIndex: number; reason: string }[]; costYuan: number; videoWanted: VideoWanted[] }

/** 单次付费请求的预估花费（元），用于发起前的预算检查；接口没返回 cost 时也按它计 */
const EST_IMAGE_YUAN = EST_TASK_YUAN.image;
const EST_VIDEO_YUAN = EST_TASK_YUAN.video;
const EST_SEARCH_YUAN = SEARCH_YUAN;
const OVER_BUDGET = '超出预算';
const SEARCH_TRIES = 2;
const PEXELS_WORDS = 6;

type Attempt = { asset: BrollAsset } | { reason: string };
interface Env { deps: BrollDeps; workDir: string; budgetYuan: number; maxVideos: number; meter?: CostMeter; reserveYuan: number; afford?: (estimate: number) => boolean }
/** yuan：已花费；videos：已用上的视频数（缓存命中） */
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

/** 再花 estimate 元（并为后续步骤留出 reserveYuan）是否仍在预算内：有 meter 以 meter 为准，否则按本步已花费累计 */
const canAfford = (env: Env, spend: Spend, estimate: number): boolean =>
  (env.afford ? env.afford(estimate) : env.meter ? env.meter.canSpend(estimate + env.reserveYuan) : spend.yuan + estimate + env.reserveYuan <= env.budgetYuan);

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const relFile = (key: string, ext: string): string => `broll/${key}.${ext}`;
const yuanOf = (assets: BrollAsset[]): number => assets.reduce((s, a) => s + (a.cost ?? 0), 0);

/**
 * 执行一次产出：deps 先写到同目录的临时文件（key.part.ext，保留扩展名供 ffmpeg 判断格式），
 * 校验非空后再改名为正式文件，这样中途失败或进程被杀都不会留下看似有效的缓存。
 * 失败（抛错、没结果、没写出文件或文件为空）返回原因。
 */
async function produce<T extends { cost?: number } | PexelsHit | boolean | void>(out: string, fn: (tmp: string) => Promise<T>): Promise<{ result: T } | string> {
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
    rethrowIfCancelled(err); // 取消同理：不能记成这一项失败
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

const hostOf = (url: string): string => { try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; } };

/** 截图网址：分镜给的网址只是模型记忆，必须联网核实（搜索结果里有同一域名才用它，否则用搜索给出的网址）；只有搜索词时直接搜 */
async function screenshotUrls(env: Env, need: { url?: string; query?: string }): Promise<string[]> {
  const host = need.url ? hostOf(need.url) : '';
  const found = await env.deps.search(host ? `${host} ${need.query ?? ''}`.trim() : need.query ?? '');
  const verified = need.url && found.some((u) => hostOf(u) === host) ? [need.url, ...found.filter((u) => u !== need.url)] : found;
  return verified.slice(0, SEARCH_TRIES);
}

async function tryScreenshot(env: Env, key: string, need: { url?: string; query?: string }, spend: Spend): Promise<Attempt> {
  const file = relFile(key, 'png');
  if (!canAfford(env, spend, EST_SEARCH_YUAN)) return { reason: OVER_BUDGET };
  let urls: string[];
  try {
    urls = await screenshotUrls(env, need);
  } catch (err) {
    rethrowIfBalance(err);
    rethrowIfCancelled(err);
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
  if (typeof r === 'string') return { reason: `生图失败：${r}` };
  return { asset: { key, file, source: 'generate', cost: costOf(r.result, EST_IMAGE_YUAN), ...(r.result.url ? { url: r.result.url } : {}) } };
}

async function tryPexels(env: Env, key: string, term: string): Promise<Attempt> {
  const pexels = env.deps.pexels;
  if (!pexels) return { reason: '未配置图库' };
  const file = relFile(key, 'jpg');
  const r = await produce(join(env.workDir, file), (tmp) => pexels(term, tmp));
  if (typeof r === 'string') return { reason: `图库失败：${r}` };
  const hit = typeof r.result === 'object' ? r.result : {};
  return { asset: { key, file, source: 'pexels', ...hit } };
}

const firstWords = (prompt: string): string => prompt.split(/\s+/).slice(0, PEXELS_WORDS).join(' ');

/** 生图优先，失败再试 Pexels（有依赖时），都失败放弃；Pexels 搜索词默认取提示词前 6 个单词，截图退化时传原始 query */
async function tryGenerate(env: Env, key: string, prompt: string, spend: Spend, pexelsTerm: string = firstWords(prompt)): Promise<Attempt> {
  const img = await tryImage(env, key, prompt, spend);
  if ('asset' in img || !env.deps.pexels) return img;
  const px = await tryPexels(env, key, pexelsTerm);
  return 'asset' in px ? px : { reason: `${img.reason}；${px.reason}` };
}

/** 按优先级取一份素材：截图（photo 失败退生图）、生成；视频需求先生图（图生视频由调用方在预算还够时再做） */
async function fetchAsset(env: Env, need: VisualNeed, key: string, spend: Spend): Promise<Attempt> {
  const v = need.visual;
  if (v.source === 'generate' || v.source === 'video') return tryGenerate(env, key, v.prompt, spend);
  const shot = await tryScreenshot(env, key, v, spend);
  if ('asset' in shot || need.template !== 'photo') return shot;
  const original = v.query ?? v.url ?? '';
  const gen = await tryGenerate(env, key, `Editorial photo illustrating: ${original}`, spend, original);
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

/** 分镜里已有且文件真实存在的素材引用（卡片的 image / video 与镜头的 B-roll；归一化时不能因为不在本次获取列表里被误删） */
export function existingFiles(storyboard: Storyboard, workDir: string): string[] {
  return storyboard.shots.flatMap((s) => {
    const props = s.card && 'props' in s.card ? (s.card.props as { image?: string; video?: string }) : {};
    return [props.image, props.video, s.broll?.file].filter((f): f is string => f !== undefined && existsSync(join(workDir, f)));
  });
}

/** 要取的卡片素材需求：已铺了 B-roll 的镜头（钩子做底）不再取 */
export const pendingNeeds = (storyboard: Storyboard): VisualNeed[] => visualsOf(storyboard).filter((n) => !storyboard.shots[n.shotIndex]?.broll);

/** 视频需求生图成功（拿到了公网地址、没有现成的 mp4 缓存）时，记下以后做图生视频 */
function wantVideo(need: VisualNeed, key: string, asset: BrollAsset): VideoWanted[] {
  if (need.visual.source !== 'video' || asset.source !== 'generate' || !asset.url) return [];
  return [{ shotIndex: need.shotIndex, key, prompt: need.visual.prompt, imageUrl: asset.url }];
}

/**
 * 严格串行（可想套餐同时只跑 1 个任务）取回分镜卡片上的全部素材需求并写回卡片。
 * 视频需求只生图（缓存里已有 mp4 且名额未满时直接用），图生视频由调用方在 B-roll 末尾、预算还够时用 upgradeToVideo 做。
 * 单个素材失败不抛错，只记入 failures；最后再归一化一次，拿不到图的 photo 会被丢弃并补成全屏。
 */
export async function fulfillVisuals(storyboard: Storyboard, deps: BrollDeps, opts: FulfillOptions): Promise<FulfillResult> {
  mkdirSync(join(opts.workDir, 'broll'), { recursive: true });
  const env: Env = { deps, workDir: opts.workDir, budgetYuan: opts.budgetYuan, maxVideos: opts.maxVideos, meter: opts.meter, reserveYuan: opts.reserveYuan ?? 0, afford: opts.afford };
  let current = storyboard;
  let assets: BrollAsset[] = [];
  let failures: FulfillResult['failures'] = [];
  let videoWanted: VideoWanted[] = [];
  let videoHits = 0;
  const deferred = (n: VisualNeed): boolean => opts.deferShots?.includes(n.shotIndex) ?? false;
  const needs = pendingNeeds(storyboard);
  for (const need of [...needs.filter((n) => !deferred(n)), ...needs.filter(deferred)]) {
    throwIfCancelled(opts.signal);
    const key = visualKey(need.visual);
    const cached = findCached(env, key, need.visual.source, videoHits);
    if (!cached) opts.onStart?.(need);
    const outcome: Attempt = cached ? { asset: cached } : await fetchAsset(env, need, key, { yuan: yuanOf(assets), videos: videoHits });
    if ('asset' in outcome) {
      videoHits += outcome.asset.source === 'video' ? 1 : 0;
      assets = [...assets, outcome.asset];
      videoWanted = [...videoWanted, ...wantVideo(need, key, outcome.asset)];
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
  return { storyboard: normalized, assets, failures, costYuan: yuanOf(assets), videoWanted };
}

/** 钩子卡片上与 key 对应的视频需求所在的镜头（按需求内容找，归一化后下标可能变了） */
function hookShotOf(storyboard: Storyboard, key: string): number {
  return storyboard.shots.findIndex((s) => s.card?.template === 'hook' && s.card.props.visual !== undefined && visualKey(s.card.props.visual) === key);
}

/**
 * Seedance 图生视频：只对已经生成的钩子关键图做（以它为首帧），最多 maxVideos 条，每条发起前检查预算。
 * 成功的写进钩子卡片的 video；失败只记原因，钩子保留图片
 */
export async function upgradeToVideo(storyboard: Storyboard, wanted: readonly VideoWanted[], deps: BrollDeps, opts: Pick<FulfillOptions, 'workDir' | 'maxVideos' | 'afford' | 'onStatus' | 'signal'>): Promise<{ storyboard: Storyboard; assets: BrollAsset[]; failures: string[]; skipped: string[] }> {
  let current = storyboard;
  let assets: BrollAsset[] = [];
  let failures: string[] = [];
  let skipped: string[] = [];
  for (const w of wanted.slice(0, opts.maxVideos)) {
    throwIfCancelled(opts.signal);
    const i = hookShotOf(current, w.key);
    if (i < 0) continue;
    if (opts.afford && !opts.afford(EST_VIDEO_YUAN)) { skipped = [...skipped, `钩子图生视频${OVER_BUDGET}，保留图片`]; continue; }
    const file = relFile(w.key, 'mp4');
    const r = await produce(join(opts.workDir, file), (tmp) => deps.video(w.prompt, w.imageUrl, tmp, opts.onStatus));
    if (typeof r === 'string') { failures = [...failures, `图生视频失败：${r}`]; continue; }
    const asset: BrollAsset = { key: w.key, file, source: 'video', cost: costOf(r.result, EST_VIDEO_YUAN) };
    assets = [...assets, asset];
    current = applyAsset(current, i, asset);
  }
  return { storyboard: current, assets, failures, skipped };
}
