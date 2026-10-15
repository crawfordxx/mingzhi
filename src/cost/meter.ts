import { z } from 'zod';
import { FALLBACK_PRICES, type Price } from './prices.js';

export interface CostEntry {
  kind: 'chat' | 'task';
  model: string;
  label: string;
  yuan: number;
  tokens?: { input: number; output: number };
}

const count = z.number().finite().nonnegative();
/** 对话（prompt/completion）与 Responses（input/output）两种用量格式；推理 token 已含在输出里，不单独计 */
const Usage = z.union([
  z.object({ prompt_tokens: count, completion_tokens: count }),
  z.object({ input_tokens: count, output_tokens: count }),
]);

/** 价格未知时按内置价格里最贵的估算（输入 + 输出单价之和最高者） */
const MAX_PRICE: Price = Object.values(FALLBACK_PRICES).reduce((a, b) => (b.input + b.output > a.input + a.output ? b : a));

const EPSILON = 1e-9;
/** 对话花费四舍五入到 0.0001 元，去掉浮点误差（0.0105 + 0.126 不再是 0.13650000000000001） */
const roundYuan = (v: number): number => Math.round(v * 10_000) / 10_000;

/** 按实际用量累计花费；entries 只读，每次记账追加一条 */
export class CostMeter {
  private readonly log: CostEntry[] = [];

  constructor(private readonly prices: Record<string, Price>, private readonly budgetYuan: number) {}

  addChat(model: string, usage: unknown, label?: string): CostEntry {
    const base = label ?? model;
    const parsed = Usage.safeParse(usage);
    if (!parsed.success) return this.push({ kind: 'chat', model, label: `${base}（无用量）`, yuan: 0 });
    const tokens = 'prompt_tokens' in parsed.data
      ? { input: parsed.data.prompt_tokens, output: parsed.data.completion_tokens }
      : { input: parsed.data.input_tokens, output: parsed.data.output_tokens };
    const known = this.prices[model];
    const price = known ?? MAX_PRICE;
    const yuan = roundYuan((tokens.input * price.input + tokens.output * price.output) / 1000);
    return this.push({ kind: 'chat', model, label: known ? base : `${base}（价格未知，按上限估）`, yuan, tokens });
  }

  addTask(model: string, yuan: number | undefined, label?: string): CostEntry {
    const base = label ?? model;
    if (yuan === undefined || !Number.isFinite(yuan) || yuan < 0) return this.push({ kind: 'task', model, label: `${base}（无花费数据）`, yuan: 0 });
    return this.push({ kind: 'task', model, label: base, yuan });
  }

  get total(): number {
    return this.log.reduce((sum, e) => sum + e.yuan, 0);
  }

  /** 账目快照：数组与条目都冻结，调用方改不动内部账本 */
  get entries(): readonly CostEntry[] {
    return Object.freeze([...this.log]);
  }

  /** 再花 yuan 元后是否仍不超预算（恰好用完算可以） */
  canSpend(yuan: number): boolean {
    return this.total + yuan <= this.budgetYuan + EPSILON;
  }

  /** 预算上限（元）；不限时为 Infinity */
  get budget(): number {
    return this.budgetYuan;
  }

  remaining(): number {
    return Math.max(0, this.budgetYuan - this.total);
  }

  private push(entry: CostEntry): CostEntry {
    const frozen = Object.freeze({ ...entry, ...(entry.tokens ? { tokens: Object.freeze({ ...entry.tokens }) } : {}) });
    this.log.push(frozen);
    return frozen;
  }
}
