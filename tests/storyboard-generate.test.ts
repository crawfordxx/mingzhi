import { describe, expect, it } from 'vitest';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { CATALOG, generateStoryboard, STORYBOARD_MODEL } from '../src/storyboard/generate.js';
import { TEMPLATE_IDS } from '../src/storyboard/schema.js';

const caps = [
  { start: 0, end: 2.5, text: 'FDE 这个岗位' },
  { start: 2.5, end: 5, text: '现在看来基本定性了' },
  { start: 5, end: 9, text: '而且生命周期可能会很长' },
];
const scripted = (...replies: unknown[]) => {
  const calls: ChatOptions[] = [];
  const client: LlmClient = { chatJson: async (o) => { calls.push(o); return replies[calls.length - 1]; } };
  return { client, calls };
};
const good = { shots: [
  { start: 0, end: 5, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: 'FDE 岗位基本定性了', highlight: ['定性'] } } },
  { start: 5, end: 9, layout: 'split', card: { template: 'title', props: { title: '生命周期很长' } } },
] };

describe('CATALOG', () => {
  it('覆盖全部 12 个模板', () => {
    expect(CATALOG.map((c) => c.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });
});

describe('generateStoryboard', () => {
  it('用 gemini-3.5-flash（low），用户消息含带时间的字幕、总时长与可用图片；返回归一化后的分镜', async () => {
    const { client, calls } = scripted(good);
    const res = await generateStoryboard(client, caps, 9, ['broll/a.jpg']);
    expect(calls[0]).toMatchObject({ model: STORYBOARD_MODEL, reasoningEffort: 'low' });
    expect(calls[0].user).toContain('[0.00-2.50] FDE 这个岗位');
    expect(calls[0].user).toContain('9.00');
    expect(calls[0].user).toContain('broll/a.jpg');
    for (const id of TEMPLATE_IDS) expect(calls[0].system).toContain(id);
    expect(res.attempts).toBe(1);
    expect(res.storyboard.shots.map((s) => s.card?.template)).toEqual(['hook', 'title']);
  });
  it('不合格镜头过多时带原因重试 1 次，取 dropped 较少的结果', async () => {
    const bad = { shots: [{ start: 0, end: 5, layout: 'split', card: { template: 'title', props: {} } }, { start: 5, end: 9, layout: 'split', card: { template: 'nope', props: {} } }] };
    const { client, calls } = scripted(bad, good);
    const res = await generateStoryboard(client, caps, 9, []);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('不合格');
    expect(res.attempts).toBe(2);
    expect(res.dropped).toBe(0);
  });
  it('模型请求失败时抛出（由流程决定是否降级）', async () => {
    const client: LlmClient = { chatJson: async () => { throw new Error('超时'); } };
    await expect(generateStoryboard(client, caps, 9, [])).rejects.toThrow('超时');
  });
});
