import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { searchUrls } from '../src/broll/search.js';
import { CostMeter } from '../src/cost/meter.js';
import { FALLBACK_PRICES, loadPrices, parsePrices } from '../src/cost/prices.js';
import { KexiangClient } from '../src/llm/kexiang.js';
import { KexiangTaskClient } from '../src/llm/kexiang-task.js';

const GEMINI = 'google/gemini-3.5-flash';
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'mz-cost-')), 'sub', 'prices.json');
const modelsBody = { total: 3, list: [
  { model: GEMINI, mode: 'token', input_price: '0.02', output_price: '0.1' },
  { model: 'x/tiered', mode: 'tiered', input_price: '-', output_price: '-' },
  { model: 'x/dash', mode: 'token', input_price: '-', output_price: '-' },
] };

describe('CostMeter', () => {
  const meter = (budget = 10) => new CostMeter(FALLBACK_PRICES, budget);

  it('1000 输入 + 2000 输出按 gemini 价换算为 0.0105 + 0.126 元', () => {
    const e = meter().addChat(GEMINI, { prompt_tokens: 1000, completion_tokens: 2000 }, '视觉自检');
    expect(e.yuan).toBeCloseTo(0.1365, 10);
    expect(e).toMatchObject({ kind: 'chat', label: '视觉自检', tokens: { input: 1000, output: 2000 } });
  });

  it('推理 token 已含在 completion_tokens 里，不重复计', () => {
    const e = meter().addChat(GEMINI, { prompt_tokens: 1000, completion_tokens: 2000, completion_tokens_details: { reasoning_tokens: 1500 } });
    expect(e.yuan).toBeCloseTo(0.1365, 10);
  });

  it('兼容 Responses 的 input_tokens / output_tokens', () => {
    expect(meter().addChat('openai/gpt-5.6-luna', { input_tokens: 1000, output_tokens: 1000 }).yuan).toBeCloseTo(0.0098, 10);
  });

  it('未知模型按最贵价格估算并标注', () => {
    const e = meter().addChat('foo/bar', { prompt_tokens: 1000, completion_tokens: 1000 }, '某用途');
    expect(e.yuan).toBeCloseTo(0.168, 10);
    expect(e.label).toBe('某用途（价格未知，按上限估）');
  });

  it('用量缺失或格式不对记 0 元并标注无用量', () => {
    const m = meter();
    expect(m.addChat(GEMINI, undefined, 'a')).toMatchObject({ yuan: 0, label: 'a（无用量）' });
    expect(m.addChat(GEMINI, { prompt_tokens: 'x' }).yuan).toBe(0);
    expect(m.addChat(GEMINI, { prompt_tokens: -1, completion_tokens: 1 }).yuan).toBe(0);
  });

  it('任务花费累加；没有花费数据记 0 并标注', () => {
    const m = meter();
    m.addTask('seedance', 2.4, '开头钩子');
    expect(m.addTask('img', undefined, '配图')).toMatchObject({ kind: 'task', yuan: 0, label: '配图（无花费数据）' });
    m.addChat(GEMINI, { prompt_tokens: 1000, completion_tokens: 0 });
    expect(m.total).toBeCloseTo(2.4105, 10);
    expect(m.entries).toHaveLength(3);
  });

  it('canSpend 边界：恰好用完可以，多一分钱不行；remaining 不为负', () => {
    const m = meter(3);
    m.addTask('img', 2.4);
    expect(m.canSpend(0.6)).toBe(true);
    expect(m.canSpend(0.61)).toBe(false);
    expect(m.remaining()).toBeCloseTo(0.6, 10);
    m.addTask('img', 5);
    expect(m.remaining()).toBe(0);
    expect(m.canSpend(0)).toBe(false);
  });

  it('entries 是冻结的快照：数组与条目都改不动，也不影响账本', () => {
    const m = meter();
    m.addChat(GEMINI, { prompt_tokens: 1000, completion_tokens: 1 });
    const snapshot = m.entries;
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(() => (snapshot as unknown[]).push({})).toThrow(TypeError);
    expect(() => { (snapshot[0] as { yuan: number }).yuan = 99; }).toThrow(TypeError);
    expect(() => { (snapshot[0].tokens as { input: number }).input = 99; }).toThrow(TypeError);
    m.addTask('img', 1);
    expect(snapshot).toHaveLength(1); // 旧快照不随新记账变化
    expect(m.entries).toHaveLength(2);
  });

  it('对话花费四舍五入到 0.0001 元，没有浮点尾巴', () => {
    expect(meter().addChat(GEMINI, { prompt_tokens: 1000, completion_tokens: 2000 }).yuan).toBe(0.1365);
    expect(meter().addChat('openai/gpt-5.6-luna', { prompt_tokens: 3, completion_tokens: 3 }).yuan).toBe(0);
  });
});

describe('loadPrices', () => {
  it('parsePrices 逐条校验：坏条目、空价格、负价格都只跳过那一条；带单位的价格取开头的数字', () => {
    const body = { list: [
      42, { model: 7 }, null,
      { model: 'x/empty', input_price: '', output_price: '0.1' },
      { model: 'x/neg', input_price: '-0.5', output_price: '0.1' },
      { model: 'x/space', input_price: '  ', output_price: '0.1' },
      { model: 'x/unit', input_price: '0.0105元', output_price: 0.063 },
      { model: 'x/free', input_price: '0', output_price: '0' },
    ] };
    expect(parsePrices(body)).toEqual({ 'x/unit': { input: 0.0105, output: 0.063 }, 'x/free': { input: 0, output: 0 } });
  });

  it('价格缓存原子写入：写完后目录里没有临时文件', async () => {
    const file = tmpFile();
    await loadPrices(file, (async () => json(modelsBody)) as never, () => 0);
    expect(readdirSync(dirname(file))).toEqual(['prices.json']);
  });

  it('parsePrices 把字符串价格转数字，跳过 tiered 与 "-"', () => {
    expect(parsePrices(modelsBody)).toEqual({ [GEMINI]: { input: 0.02, output: 0.1 } });
    expect(parsePrices({ nope: 1 })).toEqual({});
  });

  it('无缓存时请求并写缓存（带 key），线上价格覆盖兜底价', async () => {
    const file = tmpFile();
    const fetchImpl = vi.fn(async () => json(modelsBody));
    const prices = await loadPrices(file, fetchImpl as never, () => 1000, 'abc');
    expect(prices[GEMINI]).toEqual({ input: 0.02, output: 0.1 });
    expect(prices['openai/gpt-5.6-sol']).toEqual(FALLBACK_PRICES['openai/gpt-5.6-sol']);
    expect((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].headers).toEqual({ Authorization: 'Bearer sk-abc' });
    expect(JSON.parse(readFileSync(file, 'utf8')).fetchedAt).toBe(1000);
  });

  it('24 小时内用缓存不请求；过期后重新请求', async () => {
    const file = tmpFile();
    await loadPrices(file, (async () => json(modelsBody)) as never, () => 0);
    const fetchImpl = vi.fn(async () => json({ list: [{ model: GEMINI, input_price: '0.5', output_price: '0.5' }] }));
    expect((await loadPrices(file, fetchImpl as never, () => 23 * 3600_000))[GEMINI].input).toBe(0.02);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect((await loadPrices(file, fetchImpl as never, () => 25 * 3600_000))[GEMINI].input).toBe(0.5);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('请求失败退回过期缓存，没有缓存再退回兜底价', async () => {
    const file = tmpFile();
    await loadPrices(file, (async () => json(modelsBody)) as never, () => 0);
    const failing = (async () => { throw new Error('断网'); }) as never;
    expect((await loadPrices(file, failing, () => 99 * 3600_000))[GEMINI].input).toBe(0.02);
    expect(await loadPrices(tmpFile(), failing)).toEqual(FALLBACK_PRICES);
    expect(await loadPrices(tmpFile(), (async () => json({}, 500)) as never)).toEqual(FALLBACK_PRICES);
  });

  it('缓存文件损坏时当作没有缓存', async () => {
    const file = tmpFile();
    await loadPrices(file, (async () => json(modelsBody)) as never, () => 0);
    writeFileSync(file, '{坏的');
    expect((await loadPrices(file, (async () => json(modelsBody)) as never, () => 1))[GEMINI].input).toBe(0.02);
  });
});

describe('接入记账', () => {
  it('KexiangClient 成功后记一笔，重试只记最终成功的一次，label 生效', async () => {
    const m = new CostMeter(FALLBACK_PRICES, 10);
    const ok = json({ choices: [{ message: { content: '{"a":1}' } }], usage: { prompt_tokens: 1000, completion_tokens: 2000 } });
    const responses = [json({}, 503), ok];
    const client = new KexiangClient('k', (async () => responses.shift()) as never, async () => {}, m);
    await client.chatJson({ model: GEMINI, system: 's', user: 'u', label: '自检' });
    expect(m.entries).toHaveLength(1);
    expect(m.entries[0]).toMatchObject({ label: '自检', model: GEMINI });
    expect(m.total).toBeCloseTo(0.1365, 10);
  });

  it('响应成功但内容格式异常（缺 content）时仍先记账再报错', async () => {
    const m = new CostMeter(FALLBACK_PRICES, 10);
    const bad = json({ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 0 } });
    const client = new KexiangClient('k', (async () => bad) as never, async () => {}, m);
    await expect(client.chatJson({ model: GEMINI, system: 's', user: 'u' })).rejects.toThrow('返回格式异常');
    expect(m.total).toBeCloseTo(0.0105, 10);
  });

  it('不传 meter 的 KexiangClient 照常工作', async () => {
    const client = new KexiangClient('k', (async () => json({ choices: [{ message: { content: '{}' } }] })) as never);
    await expect(client.chatJson({ model: GEMINI, system: 's', user: 'u' })).resolves.toEqual({});
  });

  it('KexiangTaskClient 任务成功后记 cost，失败不记', async () => {
    const m = new CostMeter(FALLBACK_PRICES, 10);
    const seq = [json({ id: 1 }), json({ task_status: 'success', cost: '2.4', service_output: { videoUrl: 'u' } }), json({ id: 2 }), json({ task_status: 'failed', service_output: { failReason: '审核' } })];
    const client = new KexiangTaskClient('k', (async () => seq.shift()) as never, async () => {}, 1, m);
    await client.run({ modelName: 'seedance-mini', modelType: 'text2video' }, { kind: 'video', label: '开头钩子' });
    await expect(client.run({ modelName: 'seedance-mini', modelType: 'text2video' }, { kind: 'video' })).rejects.toThrow('审核');
    expect(m.entries).toEqual([{ kind: 'task', model: 'seedance-mini', label: '开头钩子', yuan: 2.4 }]);
  });

  it('searchUrls 传入 meter 时按 luna 价记账', async () => {
    const m = new CostMeter(FALLBACK_PRICES, 10);
    const body = { output_text: 'https://example.com/a', usage: { input_tokens: 1000, output_tokens: 1000 } };
    await searchUrls('k', 'q', { fetchImpl: (async () => json(body)) as never, meter: m });
    expect(m.entries[0]).toMatchObject({ model: 'openai/gpt-5.6-luna', label: '联网搜索' });
    expect(m.total).toBeCloseTo(0.0098, 10);
  });
});
