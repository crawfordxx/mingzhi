export const KEXIANG_CHAT_URL = 'https://kexiangai.com/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
  /** 随用户消息一起发送的图片（data URI），模型需支持读图 */
  images?: string[];
}

export interface LlmClient {
  chatJson(opts: ChatOptions): Promise<unknown>;
}

export function parseJsonContent(content: string): unknown {
  const cleaned = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(cleaned);
  } catch {
    throw new Error(`模型返回的不是合法 JSON：${cleaned.slice(0, 120)}`);
  }
}

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type UserContent = string | ({ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } })[];

/** 有图片时用多模态内容数组（文字在前、图片在后），否则保持纯文本 */
function userContent(opts: ChatOptions): UserContent {
  if (!opts.images?.length) return opts.user;
  return [{ type: 'text', text: opts.user }, ...opts.images.map((url) => ({ type: 'image_url' as const, image_url: { url } }))];
}

/** 可重试的失败（网络错误、超时、429/5xx、响应体不是 JSON）；其他错误直接抛出 */
class RetryableError extends Error {}

function networkReason(err: unknown): string {
  if (err instanceof Error && err.name === 'TimeoutError') return '请求超时';
  return `网络错误 ${err instanceof Error ? err.message : String(err)}`;
}

export class KexiangClient implements LlmClient {
  private readonly auth: string;

  constructor(apiKey: string, private readonly fetchImpl: typeof fetch = fetch, private readonly sleep = defaultSleep) {
    if (!apiKey) throw new Error('未配置可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
    this.auth = `Bearer ${apiKey.startsWith('sk-') ? apiKey : `sk-${apiKey}`}`;
  }

  async chatJson(opts: ChatOptions): Promise<unknown> {
    const body = JSON.stringify({
      model: opts.model,
      temperature: 0,
      response_format: { type: 'json_object' },
      ...(opts.reasoningEffort ? { reasoning_effort: opts.reasoningEffort } : {}),
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: userContent(opts) }],
    });
    let lastError = new Error('可想 AI 请求失败');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await this.sleep(1000 * 2 ** (attempt - 1)); // 只在两次请求之间退避，最后一次失败后不再等待
      try {
        return await this.requestOnce(body, opts.timeoutMs ?? 180_000);
      } catch (err) {
        if (!(err instanceof RetryableError)) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  /** 发一次请求；可重试的失败抛 RetryableError */
  private async requestOnce(body: string, timeoutMs: number): Promise<unknown> {
    let res: Response;
    try {
      res = await this.fetchImpl(KEXIANG_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw new RetryableError(`可想 AI 暂时不可用：${networkReason(err)}`);
    }
    if (res.status === 429 || res.status >= 500) throw new RetryableError(`可想 AI 暂时不可用 ${res.status}：${(await res.text()).slice(0, 200)}`);
    if (!res.ok) throw new Error(`可想 AI 请求失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
    let data: { choices?: { message?: { content?: unknown } }[] };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new RetryableError('可想 AI 暂时不可用：响应不是合法 JSON');
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string') throw new Error('可想 AI 返回格式异常：缺少 choices[0].message.content');
    return parseJsonContent(content);
  }
}
