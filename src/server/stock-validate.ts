import { networkReason } from '../llm/errors.js';

export type StockProvider = 'pexels' | 'pixabay';
export const STOCK_PROVIDERS: readonly StockProvider[] = ['pexels', 'pixabay'];
export const isStockProvider = (v: unknown): v is StockProvider => typeof v === 'string' && (STOCK_PROVIDERS as readonly string[]).includes(v);

const VALIDATE_TIMEOUT_MS = 15_000;
const UNSURE = '暂时无法校验';
const NAME: Record<StockProvider, string> = { pexels: 'Pexels', pixabay: 'Pixabay' };

/** Pexels 取 1 条；Pixabay 的 per_page 下限是 3 */
const PEXELS_URL = 'https://api.pexels.com/v1/search?query=nature&per_page=1';
const pixabayUrl = (key: string): string => `https://pixabay.com/api/?key=${encodeURIComponent(key)}&q=nature&per_page=3`;

function request(provider: StockProvider, key: string, fetchImpl: typeof fetch): Promise<Response> {
  const signal = AbortSignal.timeout(VALIDATE_TIMEOUT_MS);
  return provider === 'pexels'
    ? fetchImpl(PEXELS_URL, { headers: { Authorization: key }, signal })
    : fetchImpl(pixabayUrl(key), { signal });
}

/** Pixabay 对无效 key 回 400 + 一句话（如 "Invalid or missing API key"）；只有正文明确说 key 才判无效 */
async function badKeyBody(res: Response): Promise<boolean> {
  const text = await res.text().catch(() => '');
  return /api key|key.*invalid|invalid.*key/i.test(text);
}

/**
 * 各调一次最便宜的搜索接口：200 有效；401/403 无效；
 * 其余（429、5xx、网络错误）无法判断，抛错让调用方提示「暂时无法校验」而不是误判无效。错误文案不含 key
 */
export async function validateStockKey(provider: StockProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const name = NAME[provider];
  let res: Response;
  try {
    res = await request(provider, key, fetchImpl);
  } catch (err) {
    throw new Error(`${UNSURE} ${name} key：${networkReason(err).split(key).join('***')}`);
  }
  if (res.ok) {
    void res.body?.cancel().catch(() => undefined);
    return true;
  }
  if (res.status === 401 || res.status === 403) return false;
  if (provider === 'pixabay' && res.status === 400 && (await badKeyBody(res))) return false;
  void res.body?.cancel().catch(() => undefined);
  throw new Error(`${UNSURE} ${name} key：${name} 返回 HTTP ${res.status}，请稍后重试`);
}
