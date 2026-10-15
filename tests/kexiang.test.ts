import { describe, expect, it, vi } from 'vitest';
import { InsufficientBalanceError } from '../src/llm/errors.js';
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

  it('带图片时用户消息改为多模态内容数组（文字在前、图片按顺序在后）', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{"title":"x"}'));
    const images = ['data:image/png;base64,AAAA', 'data:image/jpeg;base64,BBBB'];
    await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u', images });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 's' },
      { role: 'user', content: [{ type: 'text', text: 'u' }, { type: 'image_url', image_url: { url: images[0] } }, { type: 'image_url', image_url: { url: images[1] } }] },
    ]);
  });

  it('images 为空数组时仍发纯文本', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{}'));
    await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u', images: [] });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).messages[1]).toEqual({ role: 'user', content: 'u' });
  });

  it('key 已带 sk- 前缀时不重复添加', async () => {
    const fetchMock = vi.fn().mockResolvedValue(ok('{}'));
    await new KexiangClient('sk-abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer sk-abc');
  });

  it('5xx/429 重试，之后成功', async () => {
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

  it('重试耗尽时抛「可想 AI 暂时不可用」，最后一次失败后不再等待', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => new Response('busy', { status: 503 }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    await expect(new KexiangClient('abc', fetchMock, sleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('可想 AI 暂时不可用');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[2000], [5000], [10000]]);
  });

  it('网络错误按同样退避重试，之后成功', async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(ok('{"x":2}'));
    const out = await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(out).toEqual({ x: 2 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('超时与响应体不是 JSON 也重试，耗尽后报中文原因', async () => {
    const timeout = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(timeout)
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }))
      .mockResolvedValueOnce(new Response('<html>', { status: 200 }));
    await expect(new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('可想 AI 暂时不可用：响应不是合法 JSON');
    expect(fetchMock).toHaveBeenCalledTimes(4);
    const onlyTimeout = vi.fn().mockRejectedValue(timeout);
    await expect(new KexiangClient('abc', onlyTimeout, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('可想 AI 暂时不可用：请求超时');
  });

  it('返回结构异常时直接报错', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ choices: [] }), { status: 200 }));
    await expect(new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('可想 AI 返回格式异常');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('网络中断持续几秒时耐心重试：前 3 次 fetch failed，第 4 次成功，退避 2s/5s/10s', async () => {
    const down = (): TypeError => new TypeError('fetch failed', { cause: Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }) });
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(down()).mockRejectedValueOnce(down()).mockRejectedValueOnce(down())
      .mockResolvedValueOnce(ok('{"x":3}'));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const out = await new KexiangClient('abc', fetchMock, sleep).chatJson({ model: 'm', system: 's', user: 'u' });
    expect(out).toEqual({ x: 3 });
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleep.mock.calls).toEqual([[2000], [5000], [10000]]);
  });

  it('网络错误的报错带上 cause 的错误码与信息', async () => {
    const cause = Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('fetch failed', { cause }));
    await expect(new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }))
      .rejects.toThrow('网络错误 fetch failed（UND_ERR_SOCKET other side closed）');
  });

  it('400 且响应 JSON 的 msg 或 message 含「余额不足」时抛 InsufficientBalanceError，不重试', async () => {
    for (const body of [{ msg: '余额不足，请充值' }, { message: '账户余额不足' }]) {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(body), { status: 400 }));
      const err = await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(InsufficientBalanceError);
      expect((err as Error).message).toBe('可想 AI 账户余额不足，请充值后重试');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  });

  it('其他 400（含不含「余额不足」的 JSON）仍是普通错误', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ msg: '参数错误' }), { status: 400 }));
    const err = await new KexiangClient('abc', fetchMock, noSleep).chatJson({ model: 'm', system: 's', user: 'u' }).catch((e: unknown) => e);
    expect(err).not.toBeInstanceOf(InsufficientBalanceError);
  });
});
