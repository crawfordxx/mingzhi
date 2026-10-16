import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../../config.js';
import { kindsOf, matchesOrientation, MIN_SHORT_EDGE, pickClosest, requestSignal, type Candidate, type Source, type SourceOptions, type SourceQuery } from './types.js';

const LICENSE = 'Pixabay Content License';
const LICENSE_URL = 'https://pixabay.com/service/license-summary/';
/** API 条款：结果须缓存 24 小时 */
const CACHE_TTL_MS = 24 * 3600_000;
const ORIENTATION: Record<SourceQuery['orientation'], string> = { portrait: 'vertical', landscape: 'horizontal', square: 'all' };

export interface PixabayOptions extends SourceOptions {
  /** 数据目录，缓存放 <dataDir>/cache/pixabay/；默认取配置里的数据目录 */
  dataDir?: string;
  now?: () => number;
}

interface PixabayVideoSize { url?: string; width?: number; height?: number; thumbnail?: string }
interface PixabayHit {
  id: number; pageURL: string; user?: string; duration?: number;
  videos?: Record<string, PixabayVideoSize>;
  imageWidth?: number; imageHeight?: number; largeImageURL?: string; webformatURL?: string; previewURL?: string;
}

function toVideo(h: PixabayHit): Candidate | undefined {
  const sizes = Object.values(h.videos ?? {}).filter((s): s is Required<Pick<PixabayVideoSize, 'url' | 'width' | 'height'>> & PixabayVideoSize => !!s.url && !!s.width && !!s.height);
  const best = pickClosest(sizes);
  if (!best) return undefined;
  return {
    id: `pixabay:${h.id}`, source: 'pixabay', kind: 'video', thumb: best.thumbnail ?? '', url: best.url, width: best.width, height: best.height,
    ...(h.duration !== undefined ? { durationSec: h.duration } : {}),
    page: h.pageURL, ...(h.user ? { author: h.user } : {}),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

function toPhoto(h: PixabayHit): Candidate | undefined {
  const url = h.largeImageURL ?? h.webformatURL;
  if (!url || !h.imageWidth || !h.imageHeight) return undefined;
  return {
    id: `pixabay:${h.id}`, source: 'pixabay', kind: 'photo', thumb: h.webformatURL ?? h.previewURL ?? url, url, width: h.imageWidth, height: h.imageHeight,
    page: h.pageURL, ...(h.user ? { author: h.user } : {}),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

/** Pixabay 视频/图片检索（用户自备 key）。结果缓存 24 小时到 <dataDir>/cache/pixabay/，缓存文件名与内容都不含 key */
export function pixabaySource(key: string, opts: PixabayOptions = {}): Source {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const cacheDir = join(opts.dataDir ?? loadConfig().dataDir, 'cache', 'pixabay');

  function readCache(file: string): unknown | undefined {
    if (!existsSync(file)) return undefined;
    try {
      const { fetchedAt, body } = JSON.parse(readFileSync(file, 'utf8')) as { fetchedAt: number; body: unknown };
      return now() - fetchedAt < CACHE_TTL_MS ? body : undefined;
    } catch {
      return undefined; // 缓存损坏当作未命中
    }
  }

  async function get(endpoint: string, params: URLSearchParams, signal?: AbortSignal): Promise<{ hits?: PixabayHit[] }> {
    const file = join(cacheDir, `${createHash('sha256').update(`${endpoint}?${params}`).digest('hex').slice(0, 32)}.json`);
    const cached = readCache(file);
    if (cached) return cached as { hits?: PixabayHit[] };
    const res = await fetchImpl(`https://pixabay.com/api/${endpoint}?${new URLSearchParams({ key, ...Object.fromEntries(params) })}`, { signal: requestSignal(signal) });
    if (!res.ok) throw new Error(`Pixabay 搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
    const body = (await res.json()) as { hits?: PixabayHit[] };
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(file, JSON.stringify({ fetchedAt: now(), body }));
    return body;
  }

  return async (q, signal) => {
    const base = { q: q.text, per_page: String(Math.max(q.perPage, 3)), safesearch: 'true' };
    const groups = await Promise.all(kindsOf(q.kind).map(async (kind): Promise<Candidate[]> => {
      if (kind === 'video') {
        const body = await get('videos/', new URLSearchParams({ ...base, video_type: 'film', min_width: String(MIN_SHORT_EDGE) }), signal);
        return (body.hits ?? []).map(toVideo).filter((c): c is Candidate => !!c && matchesOrientation(c.width, c.height, q.orientation));
      }
      const body = await get('', new URLSearchParams({ ...base, image_type: 'photo', orientation: ORIENTATION[q.orientation] }), signal);
      return (body.hits ?? []).map(toPhoto).filter((c): c is Candidate => c !== undefined);
    }));
    return groups.flat();
  };
}
