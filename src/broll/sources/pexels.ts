import { getJson, settleAll } from './http.js';
import { kindsOf, pickClosest, type Candidate, type Source, type SourceOptions, type SourceQuery } from './types.js';

const NAME = 'Pexels';
const LICENSE = 'Pexels License';
const LICENSE_URL = 'https://www.pexels.com/license/';

interface PexelsVideoFile { file_type?: string; width?: number; height?: number; fps?: number; link?: string }
interface PexelsVideo {
  id: number; url: string; duration?: number; image?: string;
  user?: { name?: string; url?: string };
  video_files?: PexelsVideoFile[];
  video_pictures?: { picture?: string }[];
}
interface PexelsPhoto {
  id: number; width: number; height: number; url: string; photographer?: string; photographer_url?: string;
  src?: { original?: string; medium?: string };
}

function toVideo(v: PexelsVideo): Candidate | undefined {
  const mp4s = (v.video_files ?? []).filter((f): f is Required<Pick<PexelsVideoFile, 'width' | 'height' | 'link'>> & PexelsVideoFile =>
    f.file_type === 'video/mp4' && !!f.width && !!f.height && !!f.link);
  const file = pickClosest(mp4s);
  // 预览取中间那张（video_pictures 按时间排列，第一张常是黑场或片头）
  const pictures = v.video_pictures ?? [];
  const thumb = pictures[Math.floor(pictures.length / 2)]?.picture ?? v.image;
  if (!file || !thumb) return undefined;
  return {
    id: `pexels:${v.id}`, source: 'pexels', kind: 'video', thumb, url: file.link, width: file.width, height: file.height,
    ...(v.duration !== undefined ? { durationSec: v.duration } : {}),
    ...(file.fps !== undefined ? { fps: file.fps } : {}),
    page: v.url, ...(v.user?.name ? { author: v.user.name } : {}), ...(v.user?.url ? { authorUrl: v.user.url } : {}),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

/** 图片用 original：宽高就是该文件的真实尺寸（large2x 等缩放版尺寸不在响应里，不能拿原图宽高冒充） */
function toPhoto(p: PexelsPhoto): Candidate | undefined {
  const url = p.src?.original;
  if (!url) return undefined;
  return {
    id: `pexels:${p.id}`, source: 'pexels', kind: 'photo', thumb: p.src?.medium ?? url, url, width: p.width, height: p.height,
    page: p.url, ...(p.photographer ? { author: p.photographer } : {}), ...(p.photographer_url ? { authorUrl: p.photographer_url } : {}),
    license: LICENSE, licenseUrl: LICENSE_URL, attributionRequired: false, aiGenerated: false,
  };
}

/** Pexels 视频/图片检索（用户自备 key）。Pexels License 免费商用，API 条款要求尽量署名摄影师 */
export function pexelsSource(key: string, opts: SourceOptions = {}): Source {
  function get<T>(endpoint: string, q: SourceQuery, signal?: AbortSignal): Promise<T> {
    const params = new URLSearchParams({ query: q.text, orientation: q.orientation, per_page: String(q.perPage) });
    return getJson<T>(NAME, `https://api.pexels.com/${endpoint}?${params}`, { headers: { Authorization: key } }, opts, signal);
  }
  return (q, signal) => settleAll(kindsOf(q.kind).map(async (kind) => {
    if (kind === 'video') return ((await get<{ videos?: PexelsVideo[] }>('videos/search', q, signal)).videos ?? []).map(toVideo).filter((c): c is Candidate => !!c);
    return ((await get<{ photos?: PexelsPhoto[] }>('v1/search', q, signal)).photos ?? []).map(toPhoto).filter((c): c is Candidate => !!c);
  }));
}
