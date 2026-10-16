import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config.js';
import { getJson, settleAll } from './http.js';
import { kindsOf, matchesOrientation, MIN_SHORT_EDGE, pickClosest, type Candidate, type Source, type SourceOptions, type SourceQuery } from './types.js';

const NAME = 'Pixabay';
const LICENSE = 'Pixabay Content License';
const LICENSE_URL = 'https://pixabay.com/service/license-summary/';
/** API 条款：结果须缓存 24 小时 */
const CACHE_TTL_MS = 24 * 3600_000;
/** API 的 per_page 范围 3–200 */
const MIN_PER_PAGE = 3;
const MAX_PER_PAGE = 200;
/** 视频没有方向参数，竖版要多取再本地过滤 */
const PORTRAIT_VIDEO_OVERFETCH = 4;
/** largeImageURL / fullHDURL 的最长边上限（文档值） */
const LARGE_MAX_EDGE = 1280;
const FULL_HD_MAX_EDGE = 1920;
const ORIENTATION: Record<SourceQuery['orientation'], string> = { portrait: 'vertical', landscape: 'horizontal', square: 'all' };

export interface PixabayOptions extends SourceOptions {
  /** 数据目录，缓存放 <dataDir>/cache/pixabay/；默认取配置里的数据目录 */
  dataDir?: string;
  now?: () => number;
}

interface PixabayVideoSize { url?: string; width?: number; height?: number; size?: number; thumbnail?: string }
interface PixabayHit {
  id: number; pageURL: string; user?: string; user_id?: number; duration?: number;
  videos?: Record<string, PixabayVideoSize>;
  imageWidth?: number; imageHeight?: number; imageSize?: number;
  imageURL?: string; fullHDURL?: string; largeImageURL?: string; webformatURL?: string; previewURL?: string;
}

/** 最长边超过 maxEdge 时按比例缩小，否则原样 */
function fitLongEdge(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const long = Math.max(width, height);
  if (long <= maxEdge) return { width, height };
  const scale = maxEdge / long;
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function authorOf(h: PixabayHit): Pick<Candidate, 'author' | 'authorUrl'> {
  if (!h.user) return {};
  return { author: h.user, ...(h.user_id ? { authorUrl: `https://pixabay.com/users/${h.user}-${h.user_id}/` } : {}) };
}

function toVideo(h: PixabayHit): Candidate | undefined {
  const sizes = Object.values(h.videos ?? {}).filter((s): s is Required<Pick<PixabayVideoSize, 'url' | 'width' | 'height'>> & PixabayVideoSize => !!s.url && !!s.width && !!s.height);
  const best = pickClosest(sizes);
  if (!best?.thumbnail) return undefined;
  return {
    id: `pixabay:${h.id}`, source: 'pixabay', kind: 'video', thumb: best.thumbnail, url: best.url, width: best.width, height: best.height,
    ...(h.duration !== undefined ? { durationSec: h.duration } : {}),
    ...(best.size ? { sizeBytes: best.size } : {}),
    page: h.pageURL, ...authorOf(h),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

/** 图片文件与真实尺寸：有原图权限用 imageURL，其次 fullHDURL（最长边 1920），否则 largeImageURL（最长边 1280） */
function photoFile(h: PixabayHit): { url: string; width: number; height: number; sizeBytes?: number } | undefined {
  const { imageWidth: w, imageHeight: h2 } = h;
  if (!w || !h2) return undefined;
  if (h.imageURL) return { url: h.imageURL, width: w, height: h2, ...(h.imageSize ? { sizeBytes: h.imageSize } : {}) };
  if (h.fullHDURL) return { url: h.fullHDURL, ...fitLongEdge(w, h2, FULL_HD_MAX_EDGE) };
  if (h.largeImageURL) return { url: h.largeImageURL, ...fitLongEdge(w, h2, LARGE_MAX_EDGE) };
  return undefined;
}

function toPhoto(h: PixabayHit): Candidate | undefined {
  const file = photoFile(h);
  if (!file) return undefined;
  return {
    id: `pixabay:${h.id}`, source: 'pixabay', kind: 'photo', thumb: h.webformatURL ?? h.previewURL ?? file.url, ...file,
    page: h.pageURL, ...authorOf(h),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

function readCache(file: string, nowMs: number): unknown | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const { fetchedAt, body } = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: number; body: unknown };
    return nowMs - fetchedAt < CACHE_TTL_MS ? body : undefined;
  } catch {
    return undefined; // 缓存损坏当作未命中
  }
}

/** 缓存只是加速：读写失败（只读盘、磁盘满）都当没有缓存，不让成功的搜索失败；顺手清掉过期文件 */
function writeCache(dir: string, file: string, fetchedAt: number, body: unknown): void {
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ fetchedAt, body }));
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (Date.now() - statSync(path).mtimeMs > CACHE_TTL_MS) rmSync(path, { force: true });
    }
  } catch {
    // 忽略
  }
}

/** Pixabay 视频/图片检索（用户自备 key）。结果缓存 24 小时到 <dataDir>/cache/pixabay/，缓存文件名与内容都不含 key */
export function pixabaySource(key: string, opts: PixabayOptions = {}): Source {
  const now = opts.now ?? Date.now;
  const cacheDir = join(opts.dataDir ?? loadConfig().dataDir, 'cache', 'pixabay');

  async function get(endpoint: string, params: URLSearchParams, signal?: AbortSignal): Promise<{ hits?: PixabayHit[] }> {
    const file = join(cacheDir, `${createHash('sha256').update(`${endpoint}?${params}`).digest('hex').slice(0, 32)}.json`);
    const cached = readCache(file, now());
    if (cached) return cached as { hits?: PixabayHit[] };
    const body = await getJson<{ hits?: PixabayHit[] }>(NAME, `https://pixabay.com/api/${endpoint}?${new URLSearchParams({ key, ...Object.fromEntries(params) })}`, {}, opts, signal);
    writeCache(cacheDir, file, now(), body);
    return body;
  }

  const perPageOf = (n: number) => String(Math.min(MAX_PER_PAGE, Math.max(n, MIN_PER_PAGE)));

  return (q, signal) => settleAll(kindsOf(q.kind).map(async (kind): Promise<Candidate[]> => {
    if (kind === 'video') {
      const fetchCount = q.orientation === 'portrait' ? q.perPage * PORTRAIT_VIDEO_OVERFETCH : q.perPage;
      const params = new URLSearchParams({ q: q.text, per_page: perPageOf(fetchCount), safesearch: 'true', video_type: 'film', min_width: String(MIN_SHORT_EDGE) });
      const body = await get('videos/', params, signal);
      return (body.hits ?? []).map(toVideo).filter((c): c is Candidate => !!c && matchesOrientation(c.width, c.height, q.orientation)).slice(0, q.perPage);
    }
    const params = new URLSearchParams({ q: q.text, per_page: perPageOf(q.perPage), safesearch: 'true', image_type: 'photo', orientation: ORIENTATION[q.orientation] });
    return ((await get('', params, signal)).hits ?? []).map(toPhoto).filter((c): c is Candidate => !!c).slice(0, q.perPage);
  }));
}
