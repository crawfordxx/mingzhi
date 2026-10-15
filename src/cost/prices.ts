import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';

export const KEXIANG_MODELS_URL = 'https://kexiangai.com/api/v1/models';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** 单价，单位：元 / 千 token */
export interface Price { input: number; output: number }

/** 离线兜底价格（实测值，元 / 千 token） */
export const FALLBACK_PRICES: Record<string, Price> = {
  'google/gemini-3.5-flash': { input: 0.0105, output: 0.063 },
  'openai/gpt-5.6-sol': { input: 0.028, output: 0.14 },
  'openai/gpt-5.6-luna': { input: 0.0014, output: 0.0084 },
};

const ModelsBody = z.object({
  list: z.array(z.object({ model: z.string(), mode: z.string().optional(), input_price: z.unknown(), output_price: z.unknown() }).passthrough()),
});
const Cache = z.object({ fetchedAt: z.number(), prices: z.record(z.object({ input: z.number(), output: z.number() })) });

const priceNumber = (v: unknown): number => (typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN);

/** 解析价格表响应；阶梯计价（tiered）或价格为 '-' 的模型跳过 */
export function parsePrices(body: unknown): Record<string, Price> {
  const parsed = ModelsBody.safeParse(body);
  if (!parsed.success) return {};
  const entries = parsed.data.list.flatMap((m): [string, Price][] => {
    const input = priceNumber(m.input_price);
    const output = priceNumber(m.output_price);
    if (m.mode === 'tiered' || !Number.isFinite(input) || !Number.isFinite(output)) return [];
    return [[m.model, { input, output }]];
  });
  return Object.fromEntries(entries);
}

function readCache(cacheFile: string): z.infer<typeof Cache> | undefined {
  try {
    const parsed = Cache.safeParse(JSON.parse(readFileSync(cacheFile, 'utf8')));
    return parsed.success ? parsed.data : undefined;
  } catch {
    return undefined; // 缓存不存在或损坏都当作没有缓存
  }
}

async function fetchPrices(fetchImpl: typeof fetch, apiKey?: string): Promise<Record<string, Price>> {
  const headers = apiKey ? { Authorization: `Bearer ${apiKey.startsWith('sk-') ? apiKey : `sk-${apiKey}`}` } : undefined;
  const res = await fetchImpl(KEXIANG_MODELS_URL, { headers, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`价格表请求失败 ${res.status}`);
  const prices = parsePrices(await res.json());
  if (Object.keys(prices).length === 0) throw new Error('价格表为空');
  return prices;
}

/**
 * 读取价格表：缓存 24 小时内直接用；过期则重新请求；请求失败退回旧缓存，再失败用内置兜底价。
 * 返回值始终包含 FALLBACK_PRICES 里的模型（线上价格优先）。
 */
export async function loadPrices(cacheFile: string, fetchImpl: typeof fetch = fetch, now: () => number = Date.now, apiKey?: string): Promise<Record<string, Price>> {
  const cached = readCache(cacheFile);
  if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return { ...FALLBACK_PRICES, ...cached.prices };
  try {
    const prices = await fetchPrices(fetchImpl, apiKey);
    try {
      mkdirSync(dirname(cacheFile), { recursive: true });
      writeFileSync(cacheFile, JSON.stringify({ fetchedAt: now(), prices }));
    } catch {
      // 缓存写不进去不影响本次使用
    }
    return { ...FALLBACK_PRICES, ...prices };
  } catch {
    return { ...FALLBACK_PRICES, ...(cached?.prices ?? {}) };
  }
}
