import { getJson } from './http.js';
import { classifyLicense } from './license.js';
import { WIKIMEDIA_USER_AGENT } from './wikimedia.js';
import type { Candidate, Source, SourceOptions, SourceQuery } from './types.js';

const NAME = 'Openverse';
const API = 'https://api.openverse.org/v1/images/';
/** 匿名请求 page_size 上限 20，超过服务端直接 4xx */
const MAX_PAGE_SIZE = 20;
/** 服务端许可过滤只放这三种；NC、ND、SA 本就不在列表里。license_type=commercial 会放进 BY-SA，所以不用它 */
const LICENSES = 'cc0,pdm,by';
const ASPECT: Record<SourceQuery['orientation'], string> = { portrait: 'tall', landscape: 'wide', square: 'square' };

interface OpenverseImage {
  id?: string; url?: string | null; thumbnail?: string | null; foreign_landing_url?: string | null;
  creator?: string | null; creator_url?: string | null;
  license?: string | null; license_version?: string | null; license_url?: string | null;
  width?: number | null; height?: number | null; mature?: boolean | null;
}

/** 把 Openverse 的 license/version 转成 classifyLicense 认得的名字；不在白名单里的返回 undefined */
function licenseName(license: string | null | undefined, version: string | null | undefined): string | undefined {
  if (license === 'pdm') return 'Public domain';
  if (!version) return undefined; // 没有版本号的 CC 许可无法确认条款
  if (license === 'cc0') return `CC0 ${version}`;
  if (license === 'by') return `CC BY ${version}`;
  return undefined;
}

function toCandidate(img: OpenverseImage): Candidate | undefined {
  if (img.mature || !img.id || !img.url || !img.foreign_landing_url || !img.width || !img.height) return undefined;
  const name = licenseName(img.license, img.license_version);
  const verdict = classifyLicense(name);
  if (!name || !verdict) return undefined;
  const author = img.creator?.trim() ?? '';
  if (verdict.attributionRequired && !author) return undefined; // 要署名却没有作者，无法合规
  return {
    id: `openverse:${img.id}`, source: 'openverse', kind: 'photo', thumb: img.thumbnail || img.url, url: img.url,
    width: img.width, height: img.height, page: img.foreign_landing_url,
    ...(author ? { author } : {}), ...(author && img.creator_url ? { authorUrl: img.creator_url } : {}),
    license: name, ...(img.license_url ? { licenseUrl: img.license_url } : {}), attributionRequired: verdict.attributionRequired, aiGenerated: false,
  };
}

/**
 * Openverse 图片检索（免 key，匿名）：只有照片。匿名限额 20 次/分钟、200 次/天（响应头 x-ratelimit-*）。
 * 排除 Wikimedia 来源（已有专门的 wikimedia 来源，避免同图两个 id）；许可在服务端与本地各过滤一次。
 */
export function openverseSource(opts: SourceOptions = {}): Source {
  return async (q, signal) => {
    if (q.kind === 'video') return [];
    const params = new URLSearchParams({
      q: q.text, license: LICENSES, mature: 'false', aspect_ratio: ASPECT[q.orientation], size: 'medium,large',
      extension: 'jpg,jpeg,png,webp', excluded_source: 'wikimedia', page_size: String(Math.min(q.perPage, MAX_PAGE_SIZE)),
    });
    const json = await getJson<{ results?: OpenverseImage[] }>(NAME, `${API}?${params}`, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } }, opts, signal);
    return (json.results ?? []).map(toCandidate).filter((c): c is Candidate => c !== undefined);
  };
}
