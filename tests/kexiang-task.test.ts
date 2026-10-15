// tests/kexiang-task.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { downloadTo, KexiangTaskClient, KEXIANG_TASK_BASE } from '../src/llm/kexiang-task.js';

type Reply = { status?: number; body: unknown };
/** 按顺序回放响应，并记录请求 */
function fakeFetch(replies: Reply[]) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const impl = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = replies[calls.length - 1];
    if (!r) throw new Error('多余的请求');
    return new Response(JSON.stringify(r.body), { status: r.status ?? 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}
const noSleep = async (): Promise<void> => {};

describe('KexiangTaskClient', () => {
  it('提交后轮询，拿到 imgUrl 即返回；头带 x-api-key（去掉 sk- 前缀），体包在 user_input 里', async () => {
    const { impl, calls } = fakeFetch([
      { body: { id: 77, cost: 0.2 } },
      { body: { task_status: 'running', service_output: {} } },
      { body: { task_status: 'success', cost: 0.2, service_output: { imgUrl: 'https://x/1.jpg' } } },
    ]);
    const client = new KexiangTaskClient('sk-abc', impl, noSleep, 1);
    const statuses: string[] = [];
    const res = await client.run({ modelName: 'M', modelType: 'text2img', prompt: 'p' }, { kind: 'image', onStatus: (s) => statuses.push(s) });
    expect(res).toEqual({ taskId: '77', url: 'https://x/1.jpg', cost: 0.2 });
    expect(calls[0].url).toBe(`${KEXIANG_TASK_BASE}/asyncCreateWithCost`);
    expect((calls[0].init?.headers as Record<string, string>)['x-api-key']).toBe('abc');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ user_input: { modelName: 'M', modelType: 'text2img', prompt: 'p' } });
    expect(calls[1].url).toBe(`${KEXIANG_TASK_BASE}/get/passAuth/77`);
    expect(statuses).toEqual(['running']);
  });

  it('视频任务取 videoUrl', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', service_output: { videoUrl: 'https://x/v.mp4' } } }]);
    const res = await new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'V', modelType: 'text2video' }, { kind: 'video' });
    expect(res.url).toBe('https://x/v.mp4');
  });

  it('失败状态或 failReason 时报错并带原因', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'failed', service_output: { failReason: '内容审核未通过' } } }]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('内容审核未通过');
  });

  it('提交返回非 2xx（如余额不足 400）或没有 id 时报错', async () => {
    const a = fakeFetch([{ status: 400, body: { msg: '余额不足' } }]);
    await expect(new KexiangTaskClient('k', a.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('余额不足');
    const b = fakeFetch([{ body: { msg: '任务超过套餐限制' } }]);
    await expect(new KexiangTaskClient('k', b.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('任务超过套餐限制');
  });

  it('轮询总时长超过 timeoutMs 时报超时', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, ...Array.from({ length: 5 }, () => ({ body: { task_status: 'running' } }))]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 10).run({ modelName: 'M', modelType: 't' }, { kind: 'image', timeoutMs: 30 })).rejects.toThrow('超时');
  });

  it('多个任务串行执行：前一个结束后才提交下一个，前一个失败不影响后一个', async () => {
    const order: string[] = [];
    let n = 0;
    const impl = (async (url: string) => {
      n += 1;
      const isSubmit = url.endsWith('asyncCreateWithCost');
      order.push(isSubmit ? 'submit' : 'poll');
      if (isSubmit) return new Response(JSON.stringify({ id: n }));
      const fail = order.filter((o) => o === 'submit').length === 1;
      return new Response(JSON.stringify(fail ? { task_status: 'failed' } : { task_status: 'success', service_output: { imgUrl: 'u' } }));
    }) as unknown as typeof fetch;
    const client = new KexiangTaskClient('k', impl, noSleep, 1);
    const p1 = client.run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
    const p2 = client.run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
    await expect(p1).rejects.toThrow();
    await expect(p2).resolves.toMatchObject({ url: 'u' });
    expect(order).toEqual(['submit', 'poll', 'submit', 'poll']);
  });

  it('没有 key 时构造报错', () => {
    expect(() => new KexiangTaskClient('')).toThrow('MINGZHI_KX_KEY');
  });
});

describe('downloadTo', () => {
  it('写到目标路径，不留 .part 文件；非 2xx 报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-dl-'));
    const ok = (async () => new Response('hello')) as unknown as typeof fetch;
    await downloadTo('https://x/a.jpg', join(dir, 'a.jpg'), ok);
    expect(readFileSync(join(dir, 'a.jpg'), 'utf8')).toBe('hello');
    expect(existsSync(join(dir, 'a.jpg.part'))).toBe(false);
    const bad = (async () => new Response('no', { status: 404 })) as unknown as typeof fetch;
    await expect(downloadTo('https://x/b.jpg', join(dir, 'b.jpg'), bad)).rejects.toThrow('404');
  });
});
