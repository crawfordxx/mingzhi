import { kindsOf, requestSignal, type Candidate, type Source, type SourceOptions } from './types.js';

/** Wikimedia 要求 User-Agent 带项目名与联系方式（这里用仓库地址） */
export const WIKIMEDIA_USER_AGENT = 'mingzhi/0.1 (https://github.com/crawfordxx/mingzhi; open-source video editing workbench)';
const API = 'https://commons.wikimedia.org/w/api.php';
const THUMB_WIDTH = 640;

interface MetaValue { value?: string }
interface ImageInfo {
  url?: string; descriptionurl?: string; thumburl?: string; width?: number; height?: number; mime?: string; duration?: number;
  extmetadata?: Record<string, MetaValue | undefined>;
}
interface WikiPage { pageid?: number; index?: number; imageinfo?: ImageInfo[] }

const PHOTO_MIME = /^image\/(jpeg|png|webp)$/;

type Allowed = { attributionRequired: boolean };

/**
 * 许可过滤：只收公有领域、CC0、CC BY。含 NC、ND、SA（BY-SA）以及 GFDL 等其它许可一律排除。
 * CC BY 必须署名。
 */
export function classifyLicense(shortName: string): Allowed | undefined {
  const name = shortName.trim().toLowerCase().replace(/[-_]/g, ' ');
  if (!name) return undefined;
  if (name === 'cc0' || name.startsWith('cc0 ') || name.startsWith('public domain') || /^pd( |$)/.test(name)) return { attributionRequired: false };
  if (/^cc by( |$)/.test(name) && !/\b(nc|nd|sa)\b/.test(name)) return { attributionRequired: true };
  return undefined;
}

function stripHtml(html: string): string {
  return html.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/\s+/g, ' ').trim();
}

function toCandidate(page: WikiPage, kind: 'video' | 'photo'): Candidate | undefined {
  const info = page.imageinfo?.[0];
  if (!info?.url || !info.width || !info.height || !info.descriptionurl) return undefined;
  const mimeOk = kind === 'video' ? !!info.mime?.startsWith('video/') : PHOTO_MIME.test(info.mime ?? '');
  if (!mimeOk) return undefined;
  const meta = info.extmetadata ?? {};
  const license = classifyLicense(meta.LicenseShortName?.value ?? '');
  if (!license) return undefined;
  const author = stripHtml(meta.Artist?.value ?? '');
  const licenseUrl = meta.LicenseUrl?.value;
  const attributionRequired = license.attributionRequired || meta.AttributionRequired?.value === 'true';
  return {
    id: `wikimedia:${page.pageid ?? info.descriptionurl}`, source: 'wikimedia', kind, thumb: info.thumburl ?? info.url, url: info.url,
    width: info.width, height: info.height,
    ...(kind === 'video' && info.duration !== undefined ? { durationSec: info.duration } : {}),
    page: info.descriptionurl, ...(author ? { author } : {}),
    license: meta.LicenseShortName!.value!.trim(), ...(licenseUrl ? { licenseUrl } : {}), attributionRequired, aiGenerated: false,
  };
}

/** Wikimedia Commons 检索（免 key）：按 extmetadata 的许可过滤，没有方向参数，由后续裁切处理 */
export function wikimediaSource(opts: SourceOptions = {}): Source {
  const fetchImpl = opts.fetchImpl ?? fetch;
  return async (q, signal) => {
    const groups = await Promise.all(kindsOf(q.kind).map(async (kind): Promise<Candidate[]> => {
      const params = new URLSearchParams({
        action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
        gsrsearch: `${q.text} filetype:${kind === 'video' ? 'video' : 'bitmap'}`, gsrlimit: String(q.perPage),
        prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|AttributionRequired',
      });
      const res = await fetchImpl(`${API}?${params}`, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT }, signal: requestSignal(signal) });
      if (!res.ok) throw new Error(`Wikimedia 搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
      const json = (await res.json()) as { query?: { pages?: Record<string, WikiPage> } };
      return Object.values(json.query?.pages ?? {})
        .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
        .map((p) => toCandidate(p, kind))
        .filter((c): c is Candidate => c !== undefined);
    }));
    return groups.flat();
  };
}
