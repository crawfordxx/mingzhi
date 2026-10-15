import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CostMeter } from '../src/cost/meter.js';
import { KexiangClient, type ChatOptions, type LlmClient } from '../src/llm/kexiang.js';
import type { CardSpec, Storyboard } from '../src/storyboard/schema.js';

const dir = mkdtempSync(join(tmpdir(), 'mz-qa-visual-'));
const PNG = join(dir, 'strip.png');
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
writeFileSync(PNG, PNG_BYTES);

// 每次渲染都写出新的三联图文件（qaCards 打完分会删除它）
const made = vi.hoisted(() => ({ files: [] as string[] }));
vi.mock('../src/compose/render.js', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  return {
    renderCardFrames: vi.fn(async () => {
      const f = path.join(fs.mkdtempSync(path.join((await import('node:os')).tmpdir(), 'mz-fake-strip-')), 'strip.png');
      fs.writeFileSync(f, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      made.files.push(f);
      return f;
    }),
    withBundle: vi.fn(async (_dir: string, fn: (url: string) => Promise<unknown>) => fn('bundle://test')),
  };
});
const { MAX_REVISIONS, PASS_SCORE, QA_MODEL, qaCards, scoreCard } = await import('../src/qa/visual.js');
const { renderCardFrames, withBundle } = await import('../src/compose/render.js');

const sc = (n: number, notes = '问题') => ({ layout: n, hierarchy: n, motion: n, brand: n, notes });
const card = (title: string): CardSpec => ({ template: 'title', props: { title } });
const storyboard: Storyboard = { bgm: 'chill', shots: [
  { start: 0, end: 3, layout: 'split', card: card('原始') },
  { start: 3, end: 5, layout: 'full' },
  { start: 5, end: 8, layout: 'split', card: card('第二张') },
  { start: 8, end: 10, layout: 'full', card: { template: 'cta', props: { actions: ['关注'] } } },
] };
const caps = [{ start: 0, end: 3, text: '第一句' }];
const meter = (budget = 10) => new CostMeter({}, budget);

/** 按调用内容回放：打分请求（带图片）取 scores 队列，重写请求取 revisions 队列 */
function fake(scores: unknown[], revisions: unknown[] = []) {
  const calls: ChatOptions[] = [];
  const client: LlmClient = { chatJson: async (o) => {
    calls.push(o);
    return o.images?.length ? scores.shift() : revisions.shift();
  } };
  return { client, calls };
}
const run = (client: LlmClient, m = meter(), sb: Storyboard = storyboard) => qaCards({ client, workDir: dir, storyboard: sb, captions: caps, meter: m });

beforeEach(() => { vi.mocked(renderCardFrames).mockClear(); vi.mocked(withBundle).mockClear(); made.files.length = 0; });

describe('常量', () => {
  it('模型、及格线与重写上限', () => {
    expect([QA_MODEL, PASS_SCORE, MAX_REVISIONS]).toEqual(['google/gemini-3.5-flash', 8, 2]);
  });
});

describe('scoreCard', () => {
  it('图片以 data URI 随请求发送，返回四维分数与评语', async () => {
    const { client, calls } = fake([sc(9, '无')]);
    expect(await scoreCard(client, PNG, card('x'))).toEqual(sc(9, '无'));
    expect(calls[0].model).toBe(QA_MODEL);
    expect(calls[0].images).toEqual([`data:image/png;base64,${PNG_BYTES.toString('base64')}`]);
    expect(calls[0].system).toContain('版式');
    expect(calls[0].system).toContain('品牌一致性');
  });
  it('分数缺失或不是数字时抛错', async () => {
    await expect(scoreCard(fake([{ layout: 9 }]).client, PNG, card('x'))).rejects.toThrow('格式不对');
    await expect(scoreCard(fake([{ ...sc(9), motion: 'abc' }]).client, PNG, card('x'))).rejects.toThrow('格式不对');
  });
  it('数字字符串转数字、小数四舍五入、越界夹到 1-10', async () => {
    const raw = { layout: '8', hierarchy: 7.6, motion: 11, brand: 0, notes: '无' };
    expect(await scoreCard(fake([raw]).client, PNG, card('x'))).toEqual({ layout: 8, hierarchy: 8, motion: 10, brand: 1, notes: '无' });
  });
  it('提示词只评三帧可见的展开进度，要求挑剔', async () => {
    const { client, calls } = fake([sc(9)]);
    await scoreCard(client, PNG, card('x'));
    expect(calls[0].system).toContain('展开进度');
    expect(calls[0].system).toContain('默认不超过 7 分');
    expect(calls[0].system).not.toContain('下半屏');
    expect(calls[0].system).not.toContain('出场');
  });
  it('KexiangClient 把图片放进 image_url（多模态请求体）', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(sc(9)) } }] }), { status: 200 }));
    await scoreCard(new KexiangClient('abc', fetchMock as unknown as typeof fetch, async () => {}), PNG, card('x'));
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    const content = body.messages[1].content;
    expect(content[0].type).toBe('text');
    expect(content[1]).toEqual({ type: 'image_url', image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) } });
  });
});

describe('qaCards', () => {
  it('只检查分屏卡片；首次 6 分、重写后 9 分 → revised=1、passed，并换上新卡片', async () => {
    const next = card('重写后');
    const { client } = fake([sc(6), sc(9), sc(9)], [{ card: next }]);
    const res = await run(client);
    expect(res.report.map((r) => r.shotIndex)).toEqual([0, 2]);
    expect(res.report[0]).toMatchObject({ revised: 1, passed: true });
    expect(res.report[0].scores).toEqual([sc(6), sc(9)]);
    expect(res.report[1]).toMatchObject({ revised: 0, passed: true });
    expect(res.storyboard.shots[0].card).toEqual(next);
    expect(res.storyboard.shots[2].card).toEqual(card('第二张'));
    expect(res.storyboard.shots[3]).toEqual(storyboard.shots[3]);
    expect(storyboard.shots[0].card).toEqual(card('原始'));
  });
  it('任一维度 <8 即不通过', async () => {
    const { client } = fake([{ ...sc(9), motion: 7 }, sc(9)], []);
    const res = await run(client, meter(), { ...storyboard, shots: [storyboard.shots[0]] });
    expect(res.report[0].passed).toBe(false);
  });
  it('连续不过线：最多重写 2 次，保留得分最高的版本', async () => {
    const { client, calls } = fake([sc(6), sc(7), sc(5)], [{ card: card('版本B') }, { card: card('版本C') }]);
    const res = await run(client, meter(), { ...storyboard, shots: [storyboard.shots[0]] });
    expect(res.report[0]).toMatchObject({ revised: 2, passed: false });
    expect(res.report[0].scores).toHaveLength(3);
    expect(res.storyboard.shots[0].card).toEqual(card('版本B'));
    expect(calls).toHaveLength(5);
  });
  it('重写后更差、原版最高时保留原卡片', async () => {
    const { client } = fake([sc(7), sc(5), sc(6)], [{ card: card('B') }, { card: card('C') }]);
    const res = await run(client, meter(), { ...storyboard, shots: [storyboard.shots[0]] });
    expect(res.storyboard.shots[0].card).toEqual(card('原始'));
  });
  it('重写结果无效时停止并保留现有卡片', async () => {
    const { client } = fake([sc(6)], [{ card: { template: 'title', props: { title: '' } } }]);
    const res = await run(client, meter(), { ...storyboard, shots: [storyboard.shots[0]] });
    expect(res.report[0]).toMatchObject({ revised: 0, passed: false });
    expect(res.report[0].skipped).toContain('重写结果无效');
    expect(res.storyboard.shots[0].card).toEqual(card('原始'));
  });
  it('预算不足：不发任何请求，报告标注跳过', async () => {
    const { client, calls } = fake([]);
    const res = await run(client, meter(0.01));
    expect(calls).toHaveLength(0);
    expect(renderCardFrames).not.toHaveBeenCalled();
    expect(res.report).toHaveLength(2);
    expect(res.report.every((r) => !r.passed && r.skipped?.includes('预算不足'))).toBe(true);
    expect(res.storyboard).toEqual(storyboard);
  });
  it('预算在中途耗尽：后面的卡片跳过', async () => {
    const m = meter(1);
    const calls: ChatOptions[] = [];
    const client: LlmClient = { chatJson: async (o) => { calls.push(o); m.addTask('x', 0.97); return sc(9); } };
    const res = await run(client, m);
    expect(res.report[0]).toMatchObject({ passed: true });
    expect(res.report[1].skipped).toContain('预算不足');
    expect(calls).toHaveLength(1);
  });
  it('打分请求失败：标注原因，保留原卡片，不影响其他卡片', async () => {
    let n = 0;
    const client: LlmClient = { chatJson: async () => { n += 1; if (n === 1) throw new Error('网络断了'); return sc(9); } };
    const res = await run(client);
    expect(res.report[0].skipped).toContain('网络断了');
    expect(res.report[0].passed).toBe(false);
    expect(res.report[1].passed).toBe(true);
    expect(res.storyboard.shots[0].card).toEqual(card('原始'));
  });
  it('按镜头时长渲染三联图；所有卡片共用一次打包，打完分删除三联图', async () => {
    await run(fake([sc(9), sc(9)]).client);
    expect(vi.mocked(renderCardFrames).mock.calls.map((c) => [c[2], c[3]])).toEqual([[3, 'bundle://test'], [3, 'bundle://test']]);
    expect(withBundle).toHaveBeenCalledTimes(1);
    expect(made.files).toHaveLength(2);
    expect(made.files.some((f) => existsSync(f))).toBe(false);
  });
  it('打包失败：不抛出，分镜原样返回，每个目标镜头标注并 passed=false', async () => {
    vi.mocked(withBundle).mockRejectedValueOnce(new Error('webpack 炸了'));
    const { client, calls } = fake([]);
    const res = await run(client);
    expect(res.storyboard).toEqual(storyboard);
    expect(res.report.map((r) => r.shotIndex)).toEqual([0, 2]);
    expect(res.report.every((r) => !r.passed && r.revised === 0 && r.skipped === '打包失败：webpack 炸了')).toBe(true);
    expect(calls).toHaveLength(0);
  });
  it('打分抛错时三联图仍被删除', async () => {
    const client: LlmClient = { chatJson: async () => { throw new Error('网络断了'); } };
    await run(client, meter(), { ...storyboard, shots: [storyboard.shots[0]] });
    expect(made.files).toHaveLength(1);
    expect(existsSync(made.files[0])).toBe(false);
  });
  it('没有分屏卡片时不打包', async () => {
    await run(fake([]).client, meter(), { ...storyboard, shots: [storyboard.shots[1]] });
    expect(withBundle).not.toHaveBeenCalled();
  });
  it('第 2 次重写以得分最高的版本为基础（而不是最近一版）', async () => {
    const { client, calls } = fake([sc(7), sc(5), sc(6)], [{ card: card('B') }, { card: card('C') }]);
    await run(client, meter(), { ...storyboard, shots: [storyboard.shots[0]] });
    const revises = calls.filter((c) => !c.images?.length);
    expect(revises[1].user).toContain('"title":"原始"');
    expect(revises[1].user).toContain('版式 7');
  });
  it('预算在打分之后、重写之前耗尽：停止重写并标注，保留现有卡片', async () => {
    const m = meter(1);
    const client: LlmClient = { chatJson: async () => { m.addTask('x', 0.97); return sc(6); } };
    const res = await run(client, m, { ...storyboard, shots: [storyboard.shots[0]] });
    expect(res.report[0]).toMatchObject({ revised: 0, passed: false });
    expect(res.report[0].scores).toHaveLength(1);
    expect(res.report[0].skipped).toContain('预算不足，停止重写');
    expect(res.storyboard.shots[0].card).toEqual(card('原始'));
  });
});
