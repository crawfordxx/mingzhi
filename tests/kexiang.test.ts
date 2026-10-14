import { describe, expect, it, vi } from 'vitest';
import { KexiangClient, KEXIANG_CHAT_URL, parseJsonContent } from '../src/llm/kexiang.js';

const ok = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
const noSleep = async () => {};

describe('parseJsonContent', () => {
  it('去掉 ```json 代码块包裹', () => {
    expect(parseJsonContent('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });
  it('非 JSON 时报错', () => {
    expect(() => parseJsonContent('hello')).toThrow('不是合法 JSON');
  });
});

describe('KexiangClient', () => {
  it('没有 key 时构造即报错', () => {
    expect(() => new KexiangClient('')).toThrow('MINGZHI_KX_KEY');
  });

  it('发送正确的请求并解析 JSON', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"cuts":[]}'));
    const client = new KexiangClient('abc', fetchMock, noSleep);
    const out = await client.chatJson({ model: 'google/gemini-3.5-flash', system: 's', user: 'u', reasoningEffort: 'low' });
    expect(out).toEqual({ cuts: [] });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(KEXIANG_CHAT_URL);
    expect(init.headers.Authorization).toBe('Bearer sk-abc');
    const body = JSON.parse(init.body);
    expect(body).toMatchObject({ model: 'google/gemini-3.5-flash', temperature: 0, reasoning_effort: 'low', response_format: { type: 'json_object' } });
    expect(body.messages).toEqual([{ role: 'system', content: 's' }, { role: 'user', content: 'u' }]);
  });

  it('key 已带 sk- 前缀时不重复添加', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{}'));
    await new KexiangClient('sk-abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-abc');
  });

  it('5xx/429 重试，最多 3 次', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('busy', { status: 502 }))
      .mockResolvedValueOnce(new Response('limit', { status: 429 }))
      .mockResolvedValueOnce(ok('{"x":1}'));
    const out = await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(out).toEqual({ x: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('4xx 直接报错并带上响应内容', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('余额不足', { status: 400 }));
    await expect(new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('可想 AI 请求失败 400：余额不足');
  });
});
