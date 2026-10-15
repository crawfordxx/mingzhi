export const SEARCH_MODEL = 'openai/gpt-5.6-luna';
export const KEXIANG_RESPONSES_URL = 'https://kexiangai.com/api/v1/responses';
const DEFAULT_MAX = 3;
const SEARCH_TIMEOUT_MS = 90_000;
const NON_PAGE_EXT = /\.(pdf|zip|png|jpe?g|gif|webp|svg|bmp|ico)$/i;
const TRAILING_PUNCT = /[`'"”’)\]}>,.;:!?，。；：！？、）】》]+$/u;

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

/** 提取正文里的 http/https 网址：去掉末尾标点与反引号，去重保序 */
export function extractUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s`'"<>，。；！？、）】》]+/gu) ?? [];
  return dedupe(matches.map((m) => m.replace(TRAILING_PUNCT, '')).filter((u) => /^https?:\/\/.+/.test(u)));
}

function dedupe(items: string[]): string[] {
  return [...new Set(items)];
}

function isWebPage(url: string): boolean {
  try {
    return !NON_PAGE_EXT.test(new URL(url).pathname);
  } catch {
    return false;
  }
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
  if (!apiKey) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
  const max = opts.max ?? DEFAULT_MAX;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const input = `请联网搜索「${query}」，只给出最权威、最相关的 ${max} 个网页网址（官方网站、项目主页、权威报道优先），每行一个网址，不要其他文字。`;
  let res: Response;
  try {
    res = await fetchImpl(KEXIANG_RESPONSES_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey.startsWith('sk-') ? apiKey : `sk-${apiKey}`}`, 'Content-Type': 'application/json' },
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
  return dedupe(collectUrls(data).filter(isWebPage)).slice(0, max);
}
