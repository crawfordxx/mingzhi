export const SEARCH_MODEL = 'openai/gpt-5.6-luna';
export const KEXIANG_RESPONSES_URL = 'https://kexiangai.com/api/v1/responses';
const DEFAULT_MAX = 3;
const SEARCH_TIMEOUT_MS = 90_000;
const MAX_LIMIT = 10;
const NON_PAGE_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const TRAILING_STRIP = /[`'"”’\]}>,.;:!?*_]$/u;
// markdown 链接 [text](url)，url 内允许一层成对括号
const MARKDOWN_LINK = /\[[^\]]*\]\((https?:\/\/(?:[^\s()]|\([^\s()]*\))*)\)/gu;
// 网址字符：排除空白、引号、方括号、星号、中日韩字符与全角标点
const URL_PATTERN = /https?:\/\/[^\s`'"<>\[\]*\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]+/gu;

interface ResponsesMessageContent {
  text?: unknown;
  annotations?: { type?: unknown; url?: unknown }[];
}
interface ResponsesBody {
  output?: { type?: string; content?: ResponsesMessageContent[] }[];
  output_text?: unknown;
}

export interface SearchOptions {
  fetchImpl?: typeof fetch;
  max?: number;
}

/** 去掉网址末尾的标点、星号；右括号只有在网址里有配对的左括号时才保留 */
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

const PRIVATE_IPV4 = [/^127\./, /^10\./, /^192\.168\./, /^169\.254\./, /^0\./, /^172\.(1[6-9]|2\d|3[01])\./];
const PRIVATE_IPV6 = [/^\[::1?\]$/, /^\[::ffff:/i, /^\[f[cd][0-9a-f]{2}:/i, /^\[fe[89ab][0-9a-f]:/i];

/** 仅从语法上判断主机是否为本机或内网（不做 DNS 解析） */
function isPrivateHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  return PRIVATE_IPV4.some((re) => re.test(host)) || PRIVATE_IPV6.some((re) => re.test(host));
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
  if (!res.ok) throw new Error(`联网搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  let data: ResponsesBody;
  try {
    data = (await res.json()) as ResponsesBody;
  } catch {
    throw new Error('联网搜索返回格式异常：响应不是合法 JSON');
  }
  return dedupe(collectUrls(data).filter(isWebPage).map(stripTracking)).slice(0, max);
}
