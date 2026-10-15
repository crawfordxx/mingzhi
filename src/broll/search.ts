import type { CostMeter } from '../cost/meter.js';
import { balanceErrorFrom } from '../llm/errors.js';

export const SEARCH_MODEL = 'openai/gpt-5.6-luna';
export const KEXIANG_RESPONSES_URL = 'https://kexiangai.com/api/v1/responses';
const DEFAULT_MAX = 3;
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_LIMIT = 10;
const NON_PAGE_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const TRAILING_STRIP = /[`'"”’\]}>,.;:!?*]$/u;
// markdown 链接 [text](url)，url 内允许一层成对括号
const MARKDOWN_LINK = /\[[^\]]*\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)/gu;
// 网址字符：排除空白、引号、方括号、中日韩字符与全角标点（星号允许出现在中间，末尾会被剥离）
const URL_PATTERN = /https?:\/\/[^\s`'"<>\[\]\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/gu;

interface ResponsesMessageContent {
  text?: unknown;
  annotations?: { type?: unknown; url?: unknown }[];
}
interface ResponsesBody {
  output?: { type?: string; content?: ResponsesMessageContent[] }[];
  output_text?: unknown;
  usage?: unknown;
}

export interface SearchOptions {
  fetchImpl?: typeof fetch;
  max?: number;
  meter?: CostMeter;
}

/** 去掉网址末尾的标点与星号；右括号只有在网址里有配对的左括号时才保留 */
function trimUrl(raw: string): string {
  let url = raw;
  for (;;) {
    if (TRAILING_STRIP.test(url)) url = url.slice(0, -1);
    else if (url.endsWith(')') && count(url, ')') > count(url, '(')) url = url.slice(0, -1);
    else return url;
  }
}

function count(text: string, ch: string): number {
  return text.split(ch).length - 1;
}

/** 提取正文里的 http/https 网址：先取 markdown 链接，再去掉反引号、星号与末尾标点，去重保序 */
export function extractUrls(text: string): string[] {
  const plain = text.replace(MARKDOWN_LINK, ' $1 ');
  const urls = (plain.match(URL_PATTERN) ?? []).map(trimUrl).filter((u) => /^https?:\/\/.+/.test(u));
  return dedupe(urls);
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

const RESERVED_HOST_SUFFIXES = ['.localhost', '.local', '.internal'];

/** IPv4 是否落在本机、内网、保留或组播网段 */
function isPrivateIpv4(o: readonly number[]): boolean {
  const [a, b, c] = o;
  return (
    a === 0 || a === 10 || a === 127 || a >= 224 || // 0/8、10/8、127/8、组播 224/4 与保留 240/4（含 255.255.255.255）
    (a === 100 && b >= 64 && b <= 127) || // 100.64/10 运营商级 NAT
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) // 198.18/15 基准测试网段
  );
}

function parseIpv4(host: string): number[] | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  const octets = m ? m.slice(1).map(Number) : [];
  return octets.length === 4 && octets.every((n) => n <= 255) ? octets : undefined;
}

/** 把 IPv6 文本展开成 8 个 16 位组；解析失败返回 undefined */
function parseIpv6(text: string): number[] | undefined {
  let body = text;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(body);
  if (dotted) {
    const v4 = parseIpv4(dotted[1]);
    if (!v4) return undefined;
    body = body.slice(0, -dotted[1].length) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16);
  }
  const halves = body.split('::');
  if (halves.length > 2) return undefined;
  const side = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = side(halves[0]);
  const tail = halves.length === 2 ? side(halves[1]) : [];
  const fill = 8 - head.length - tail.length;
  if (halves.length === 2 ? fill < 1 : fill !== 0) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? fill : 0).fill('0'), ...tail];
  const nums = groups.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? parseInt(g, 16) : Number.NaN));
  return nums.length === 8 && nums.every((n) => !Number.isNaN(n)) ? nums : undefined;
}

const embeddedV4 = (hi: number, lo: number): number[] => [hi >> 8, hi & 255, lo >> 8, lo & 255];

/** IPv6 是否为本机、内网、保留地址；内嵌 IPv4 的形式（映射、NAT64、6to4）按 IPv4 规则判断 */
function isPrivateIpv6(g: readonly number[]): boolean {
  if (g.slice(0, 6).every((n) => n === 0)) return true; // ::、::1 以及 IPv4 兼容地址 ::/96
  if (g.slice(0, 5).every((n) => n === 0) && g[5] === 0xffff) return isPrivateIpv4(embeddedV4(g[6], g[7]));
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((n) => n === 0)) return isPrivateIpv4(embeddedV4(g[6], g[7]));
  if (g[0] === 0x2002) return isPrivateIpv4(embeddedV4(g[1], g[2]));
  return (
    (g[0] & 0xfe00) === 0xfc00 || // fc00::/7 唯一本地
    (g[0] & 0xffc0) === 0xfe80 || // fe80::/10 链路本地
    (g[0] & 0xffc0) === 0xfec0 || // fec0::/10 站点本地（已弃用）
    (g[0] & 0xff00) === 0xff00 // ff00::/8 组播
  );
}

/**
 * 仅从语法上判断主机是否为本机或内网（不做 DNS 解析）。
 * 域名解析到内网地址（DNS rebinding）与重定向到内网不在本函数范围内。
 */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.+$/, '');
  if (host === 'localhost' || RESERVED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) return true;
  if (host.startsWith('[') && host.endsWith(']')) {
    const groups = parseIpv6(host.slice(1, -1));
    return groups === undefined || isPrivateIpv6(groups);
  }
  const v4 = parseIpv4(host);
  return v4 !== undefined && isPrivateIpv4(v4);
}

/** 是否为公网 http(s) 网址：拒绝其他协议、本机与内网地址 */
export function isPublicHttpUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:') && !isPrivateHost(parsed.hostname);
  } catch {
    return false;
  }
}

function isWebPage(url: string): boolean {
  return isPublicHttpUrl(url) && !NON_PAGE_EXT.test(new URL(url).pathname);
}

/** 去掉 utm_* 跟踪参数；没有这类参数时原样返回 */
function stripTracking(url: string): string {
  const parsed = new URL(url);
  const tracked = [...parsed.searchParams.keys()].filter((k) => k.toLowerCase().startsWith('utm_'));
  if (tracked.length === 0) return url;
  tracked.forEach((k) => parsed.searchParams.delete(k));
  return parsed.toString();
}

function collectContents(data: ResponsesBody): ResponsesMessageContent[] {
  return (data.output ?? []).filter((o) => o?.type === 'message').flatMap((o) => o.content ?? []);
}

/** 优先取 url_citation 标注，其次从正文提取 */
function collectUrls(data: ResponsesBody): string[] {
  const contents = collectContents(data);
  const cited = contents.flatMap((c) => (c.annotations ?? []).filter((a) => a?.type === 'url_citation' && typeof a.url === 'string').map((a) => a.url as string));
  const texts = contents.map((c) => (typeof c.text === 'string' ? c.text : '')).filter(Boolean);
  if (texts.length === 0 && typeof data.output_text === 'string') texts.push(data.output_text);
  return [...cited, ...texts.flatMap(extractUrls)];
}

/** 用可想 AI 的联网搜索（Responses + web_search）找出最权威的网页网址 */
export async function searchUrls(apiKey: string, query: string, opts: SearchOptions = {}): Promise<string[]> {
  const key = apiKey.trim();
  if (!key) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
  const max = opts.max ?? DEFAULT_MAX;
  if (!Number.isInteger(max) || max < 1 || max > MAX_LIMIT) throw new Error(`max 必须是 1 到 ${MAX_LIMIT} 的整数`);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const input = `请联网搜索「${query}」，只给出最权威、最相关的 ${max} 个网页网址（官方网站、项目主页、权威报道优先），每行一个网址，不要其他文字。`;
  let res: Response;
  try {
    res = await fetchImpl(KEXIANG_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key.startsWith('sk-') ? key : `sk-${key}`}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: SEARCH_MODEL, tools: [{ type: 'web_search' }], input }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`联网搜索请求失败：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) {
    const text = await res.text();
    throw balanceErrorFrom(res.status, text) ?? new Error(`联网搜索失败 ${res.status}：${text.slice(0, 200)}`);
  }
  let data: ResponsesBody;
  try {
    data = (await res.json()) as ResponsesBody;
  } catch {
    throw new Error('联网搜索返回格式异常：响应不是合法 JSON');
  }
  opts.meter?.addChat(SEARCH_MODEL, data.usage, '联网搜索');
  return dedupe(collectUrls(data).filter(isWebPage).map(stripTracking)).slice(0, max);
}
