export const KEXIANG_CHAT_URL = 'https://kexiangai.com/api/v1/chat/completions';
const MAX_ATTEMPTS = 3;

export interface ChatOptions {
  model: string;
  system: string;
  user: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  timeoutMs?: number;
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
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
    });
    let lastError = new Error('可想 AI 请求失败');
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      const res = await this.fetchImpl(KEXIANG_CHAT_URL, {
        method: 'POST',
        headers: { Authorization: this.auth, 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(opts.timeoutMs ?? 180_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = new Error(`可想 AI 暂时不可用 ${res.status}：${(await res.text()).slice(0, 200)}`);
        await this.sleep(1000 * 2 ** attempt);
        continue;
      }
      if (!res.ok) throw new Error(`可想 AI 请求失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: unknown } }[] };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string') throw new Error('可想 AI 返回格式异常：缺少 choices[0].message.content');
      return parseJsonContent(content);
    }
    throw lastError;
  }
}
