// tests/kexiang-task.test.ts
import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import { CostMeter } from '../src/cost/meter.js';
import { EST_TASK_YUAN } from '../src/cost/constants.js';
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

  it('可想返回的 cost 是字符串（实测 "0.6"）时转成数字；无法解析时不带 cost', async () => {
    const a = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', cost: '0.6', service_output: { imgUrl: 'u' } } }]);
    expect((await new KexiangTaskClient('k', a.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).cost).toBe(0.6);
    const b = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', cost: 'n/a', service_output: { imgUrl: 'u' } } }]);
    expect('cost' in (await new KexiangTaskClient('k', b.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' }))).toBe(false);
  });

  it('成功但没返回 cost 时按预估价记账（生图 0.2、视频 2.4），返回给调用方的结果不变', async () => {
    const meter = new CostMeter({}, 10);
    const img = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', service_output: { imgUrl: 'u' } } }]);
    const res = await new KexiangTaskClient('k', img.impl, noSleep, 1, meter).run({ modelName: 'M', modelType: 't' }, { kind: 'image', label: '背景' });
    expect('cost' in res).toBe(false);
    expect(meter.total).toBeCloseTo(0.2);
    expect(meter.entries[0].label).toContain('按预估');
    const vid = fakeFetch([{ body: { id: 2 } }, { body: { task_status: 'success', service_output: { videoUrl: 'v' } } }]);
    await new KexiangTaskClient('k', vid.impl, noSleep, 1, meter).run({ modelName: 'V', modelType: 't' }, { kind: 'video' });
    expect(meter.total).toBeCloseTo(0.2 + 2.4);
    expect(EST_TASK_YUAN).toEqual({ image: 0.2, video: 2.4 });
  });

  it('返回了 cost 时按实际记账，不用预估价', async () => {
    const meter = new CostMeter({}, 10);
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', cost: '0.6', service_output: { imgUrl: 'u' } } }]);
    await new KexiangTaskClient('k', impl, noSleep, 1, meter).run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
    expect(meter.total).toBeCloseTo(0.6);
    expect(meter.entries[0].label).not.toContain('按预估');
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

  it('提交返回 400 且 msg 含「余额不足」时抛 InsufficientBalanceError', async () => {
    const { impl } = fakeFetch([{ status: 400, body: { msg: '余额不足' } }]);
    const err = await new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientBalanceError);
  });

  it('轮询时返回余额不足也直接抛 InsufficientBalanceError，不当作普通查询失败', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, { status: 400, body: { msg: '余额不足' } }]);
    const err = await new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InsufficientBalanceError);
  });

  it('缺 cost 时优先按调用方给的 estimateYuan 记账', async () => {
    const meter = new CostMeter({}, 10);
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'success', service_output: { imgUrl: 'u' } } }]);
    await new KexiangTaskClient('k', impl, noSleep, 1, meter).run({ modelName: 'M', modelType: 't' }, { kind: 'image', estimateYuan: 0.6 });
    expect(meter.total).toBeCloseTo(0.6);
  });

  describe('提交时的网络错误', () => {
    const netErr = (code: string): TypeError => new TypeError('fetch failed', { cause: Object.assign(new Error(code), { code }) });
    /** 前 fails 次提交抛 err，之后正常返回任务并成功 */
    function flaky(fails: number, err: Error) {
      let submits = 0;
      const impl = (async (url: string) => {
        if (url.endsWith('asyncCreateWithCost')) {
          submits += 1;
          if (submits <= fails) throw err;
          return new Response(JSON.stringify({ id: 9 }));
        }
        return new Response(JSON.stringify({ task_status: 'success', service_output: { imgUrl: 'u' } }));
      }) as unknown as typeof fetch;
      return { impl, submits: () => submits };
    }

    it('确定没送达（ECONNREFUSED / ENOTFOUND / EAI_AGAIN）时按 2s/5s/10s 退避重试', async () => {
      for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
        const f = flaky(3, netErr(code));
        const sleeps: number[] = [];
        const res = await new KexiangTaskClient('k', f.impl, async (ms) => { sleeps.push(ms); }, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
        expect(res.taskId).toBe('9');
        expect(f.submits()).toBe(4);
        expect(sleeps.filter((ms) => ms > 1)).toEqual([2000, 5000, 10000]);
      }
    });

    it('其他网络错误（可能已提交，重试会重复扣费）不重试，直接报错并带原因', async () => {
      const f = flaky(1, netErr('ECONNRESET'));
      await expect(new KexiangTaskClient('k', f.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('网络错误 fetch failed（ECONNRESET）');
      expect(f.submits()).toBe(1);
    });

    it('没送达的错误一直持续时，重试 3 次后报错', async () => {
      const f = flaky(99, netErr('ECONNREFUSED'));
      await expect(new KexiangTaskClient('k', f.impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('可想任务请求失败');
      expect(f.submits()).toBe(4);
    });
  });

  it('提交返回 id 为 null 时视为提交失败', async () => {
    const { impl } = fakeFetch([{ body: { id: null, msg: '提交被拒绝' } }]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('可想任务提交失败');
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

  it('状态大小写不敏感：FAILED 也按失败处理', async () => {
    const { impl } = fakeFetch([{ body: { id: 1 } }, { body: { task_status: 'FAILED' } }]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('可想任务失败');
  });

  it('轮询连续失败最多容忍 3 次，成功后重置计数', async () => {
    const { impl } = fakeFetch([
      { body: { id: 1 } },
      { status: 500, body: { msg: '服务繁忙' } },
      { status: 500, body: { msg: '服务繁忙' } },
      { body: { task_status: 'success', service_output: { imgUrl: 'https://x/ok.jpg' } } },
    ]);
    const res = await new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' });
    expect(res.url).toBe('https://x/ok.jpg');
  });

  it('轮询连续第 4 次失败时报错，并带任务 id', async () => {
    const { impl } = fakeFetch([
      { body: { id: 42 } },
      { status: 500, body: { msg: '服务繁忙' } },
      { status: 500, body: { msg: '服务繁忙' } },
      { status: 500, body: { msg: '服务繁忙' } },
      { status: 500, body: { msg: '服务繁忙' } },
    ]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('可想任务 42 查询失败');
  });

  it('成功状态但没有对应地址时报错', async () => {
    const { impl } = fakeFetch([{ body: { id: 9 } }, { body: { task_status: 'success', service_output: {} } }]);
    await expect(new KexiangTaskClient('k', impl, noSleep, 1).run({ modelName: 'M', modelType: 't' }, { kind: 'image' })).rejects.toThrow('可想任务 9 已完成但没有返回图片地址');
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

  it('下载中途失败时删除 .part 文件并继续抛错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-dl-'));
    const broken = (async () => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('half'));
        setTimeout(() => controller.error(new Error('连接中断')), 20);
      },
    }))) as unknown as typeof fetch;
    await expect(downloadTo('https://x/c.jpg', join(dir, 'c.jpg'), broken)).rejects.toThrow();
    expect(existsSync(join(dir, 'c.jpg.part'))).toBe(false);
    expect(existsSync(join(dir, 'c.jpg'))).toBe(false);
  });
});
