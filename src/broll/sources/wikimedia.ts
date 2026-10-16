import { getJson, settleAll } from './http.js';
import { classifyLicense } from './license.js';
import { kindsOf, type Candidate, type Source, type SourceOptions } from './types.js';

export { classifyLicense } from './license.js';

const NAME = 'Wikimedia';
/** Wikimedia 要求 User-Agent 带项目名与联系方式（这里用仓库地址），API 与文件下载都要带 */
export const WIKIMEDIA_USER_AGENT = 'mingzhi/0.1 (https://github.com/crawfordxx/mingzhi; open-source video editing workbench)';
const API = 'https://commons.wikimedia.org/w/api.php';
const THUMB_WIDTH = 640;

interface MetaValue { value?: string }
interface ImageInfo {
  url?: string; descriptionurl?: string; thumburl?: string; width?: number; height?: number; size?: number; mime?: string; duration?: number;
  extmetadata?: Record<string, MetaValue | undefined>;
}
interface WikiPage { pageid?: number; index?: number; imageinfo?: ImageInfo[] }

const PHOTO_MIME = /^image\/(jpeg|png|webp)$/;
const UNKNOWN_AUTHOR = /^(unknown|anonymous|unknown author|\?)$/i;
const ENTITIES: Record<string, string> = { amp: '&', quot: '"', lt: '<', gt: '>', nbsp: ' ', apos: "'" };

/** 给下载请求加 User-Agent 的 fetch（传给 downloadTo 用），原有请求头保留 */
export function wikimediaFetch(fetchImpl: typeof fetch = fetch): typeof fetch {
  return ((input: Parameters<typeof fetch>[0], init?: RequestInit) =>
    fetchImpl(input, { ...init, headers: { ...(init?.headers as Record<string, string> | undefined), 'User-Agent': WIKIMEDIA_USER_AGENT } })) as typeof fetch;
}

/** Commons 的 Restrictions 元数据：商标、人格权（可识别人物）等非版权限制，商用有风险，一律排除 */
const RESTRICTED = /trademark|personality|insignia|costume|ignore-copyright-restrictions/i;
export const restricted = (value: string | undefined): boolean => !!value && RESTRICTED.test(value);

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&([a-z]+);/gi, (m, name: string) => ENTITIES[name.toLowerCase()] ?? m);
}

function stripHtml(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

function toCandidate(page: WikiPage, kind: 'video' | 'photo'): Candidate | undefined {
  const info = page.imageinfo?.[0];
  if (!info?.url || !info.width || !info.height || !info.descriptionurl) return undefined;
  const mimeOk = kind === 'video' ? !!info.mime?.startsWith('video/') : PHOTO_MIME.test(info.mime ?? '');
  if (!mimeOk) return undefined;
  const meta = info.extmetadata ?? {};
  const licenseName = meta.LicenseShortName?.value?.trim() ?? '';
  const verdict = classifyLicense(licenseName);
  if (!verdict || restricted(meta.Restrictions?.value)) return undefined;
  const rawAuthor = stripHtml(meta.Artist?.value ?? '');
  const author = UNKNOWN_AUTHOR.test(rawAuthor) ? '' : rawAuthor;
  const attributionRequired = verdict.attributionRequired || meta.AttributionRequired?.value === 'true';
  if (attributionRequired && !author) return undefined; // 要署名却没有作者，无法合规
  const licenseUrl = meta.LicenseUrl?.value;
  return {
    id: `wikimedia:${page.pageid ?? info.descriptionurl}`, source: 'wikimedia', kind, thumb: info.thumburl ?? info.url, url: info.url,
    width: info.width, height: info.height,
    ...(kind === 'video' && info.duration !== undefined ? { durationSec: info.duration } : {}),
    ...(info.size ? { sizeBytes: info.size } : {}),
    page: info.descriptionurl, ...(author ? { author } : {}),
    license: licenseName, ...(licenseUrl ? { licenseUrl } : {}), attributionRequired, aiGenerated: false,
  };
}

/** Wikimedia Commons 检索（免 key）：按 extmetadata 的许可过滤，没有方向参数，由后续裁切处理 */
export function wikimediaSource(opts: SourceOptions = {}): Source {
  return (q, signal) => settleAll(kindsOf(q.kind).map(async (kind): Promise<Candidate[]> => {
    const params = new URLSearchParams({
      action: 'query', format: 'json', generator: 'search', gsrnamespace: '6',
      gsrsearch: `${q.text} filetype:${kind === 'video' ? 'video' : 'bitmap'}`, gsrlimit: String(q.perPage),
      prop: 'imageinfo', iiprop: 'url|size|mime|extmetadata', iiurlwidth: String(THUMB_WIDTH), iiextmetadatafilter: 'LicenseShortName|LicenseUrl|Artist|AttributionRequired|Restrictions',
    });
    const json = await getJson<{ query?: { pages?: Record<string, WikiPage> } }>(NAME, `${API}?${params}`, { headers: { 'User-Agent': WIKIMEDIA_USER_AGENT } }, opts, signal);
    return Object.values(json.query?.pages ?? {})
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((p) => toCandidate(p, kind))
      .filter((c): c is Candidate => c !== undefined);
  }));
}
