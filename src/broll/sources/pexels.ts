import { kindsOf, pickClosest, requestSignal, type Candidate, type Source, type SourceOptions, type SourceQuery } from './types.js';

const LICENSE = 'Pexels License';
const LICENSE_URL = 'https://www.pexels.com/license/';

interface PexelsVideoFile { file_type?: string; width?: number; height?: number; fps?: number; link?: string }
interface PexelsVideo {
  id: number; url: string; duration?: number; image?: string;
  user?: { name?: string };
  video_files?: PexelsVideoFile[];
  video_pictures?: { picture?: string }[];
}
interface PexelsPhoto {
  id: number; width: number; height: number; url: string; photographer?: string;
  src?: { original?: string; large2x?: string; medium?: string };
}

function toVideo(v: PexelsVideo): Candidate | undefined {
  const mp4s = (v.video_files ?? []).filter((f): f is Required<Pick<PexelsVideoFile, 'width' | 'height' | 'link'>> & PexelsVideoFile =>
    f.file_type === 'video/mp4' && !!f.width && !!f.height && !!f.link);
  const file = pickClosest(mp4s);
  if (!file) return undefined;
  return {
    id: `pexels:${v.id}`, source: 'pexels', kind: 'video',
    thumb: v.video_pictures?.[0]?.picture ?? v.image ?? '', url: file.link, width: file.width, height: file.height,
    ...(v.duration !== undefined ? { durationSec: v.duration } : {}),
    ...(file.fps !== undefined ? { fps: file.fps } : {}),
    page: v.url, ...(v.user?.name ? { author: v.user.name } : {}),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

function toPhoto(p: PexelsPhoto): Candidate | undefined {
  const url = p.src?.large2x ?? p.src?.original;
  if (!url) return undefined;
  return {
    id: `pexels:${p.id}`, source: 'pexels', kind: 'photo', thumb: p.src?.medium ?? url, url, width: p.width, height: p.height,
    page: p.url, ...(p.photographer ? { author: p.photographer } : {}),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

/** Pexels 视频/图片检索（用户自备 key）。Pexels License 免费商用，API 条款要求尽量署名摄影师 */
export function pexelsSource(key: string, opts: SourceOptions = {}): Source {
  const fetchImpl = opts.fetchImpl ?? fetch;
  async function get<T>(endpoint: string, q: SourceQuery, signal?: AbortSignal): Promise<T> {
    const params = new URLSearchParams({ query: q.text, orientation: q.orientation, per_page: String(q.perPage) });
    const res = await fetchImpl(`https://api.pexels.com/${endpoint}?${params}`, { headers: { Authorization: key }, signal: requestSignal(signal) });
    if (!res.ok) throw new Error(`Pexels 搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
    return (await res.json()) as T;
  }
  return async (q, signal) => {
    const groups = await Promise.all(kindsOf(q.kind).map(async (kind) => {
      if (kind === 'video') return ((await get<{ videos?: PexelsVideo[] }>('videos/search', q, signal)).videos ?? []).map(toVideo);
      return ((await get<{ photos?: PexelsPhoto[] }>('v1/search', q, signal)).photos ?? []).map(toPhoto);
    }));
    return groups.flat().filter((c): c is Candidate => c !== undefined);
  };
}
