import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

const ModelsBody = z.object({ list: z.array(z.unknown()) });
const ModelItem = z.object({ model: z.string(), mode: z.string().optional(), input_price: z.unknown(), output_price: z.unknown() }).passthrough();
const LEADING_NUMBER = /^-?\d+(\.\d+)?/;
const Cache = z.object({ fetchedAt: z.number(), prices: z.record(z.object({ input: z.number(), output: z.number() })) });

/** 价格取开头的数字（如「0.0105元」）；空串、「-」、负数都当作没有价格，不能按 ¥0 记 */
function priceNumber(v: unknown): number {
  const text = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  const m = LEADING_NUMBER.exec(text);
  const n = m ? Number.parseFloat(m[0]) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : NaN;
}

/** 解析价格表响应：逐条校验，坏的一条不影响其他；阶梯计价（tiered）或没有有效价格的模型跳过 */
export function parsePrices(body: unknown): Record<string, Price> {
  const parsed = ModelsBody.safeParse(body);
  if (!parsed.success) return {};
  const entries = parsed.data.list.flatMap((raw): [string, Price][] => {
    const item = ModelItem.safeParse(raw);
    if (!item.success) return [];
    const m = item.data;
    const input = priceNumber(m.input_price);
    const output = priceNumber(m.output_price);
    if (m.mode === 'tiered' || Number.isNaN(input) || Number.isNaN(output)) return [];
    return [[m.model, { input, output }]];
  });
  return Object.fromEntries(entries);
}

/** 先写临时文件再改名，进程中途被杀也不会留下写了一半的缓存 */
function writeCache(cacheFile: string, fetchedAt: number, prices: Record<string, Price>): void {
  mkdirSync(dirname(cacheFile), { recursive: true });
  const tmp = `${cacheFile}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ fetchedAt, prices }));
    renameSync(tmp, cacheFile);
  } finally {
    rmSync(tmp, { force: true });
  }
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
      writeCache(cacheFile, now(), prices);
    } catch {
      // 缓存写不进去不影响本次使用
    }
    return { ...FALLBACK_PRICES, ...prices };
  } catch {
    return { ...FALLBACK_PRICES, ...(cached?.prices ?? {}) };
  }
}
