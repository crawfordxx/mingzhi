import { describe, expect, it } from 'vitest';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { STORYBOARD_MODEL } from '../src/storyboard/generate.js';
import { reviseCard } from '../src/storyboard/revise.js';
import type { CardSpec, Shot } from '../src/storyboard/schema.js';

const score = { layout: 6, hierarchy: 8, motion: 8, brand: 8, notes: '标题溢出卡片' };
const caps = [{ start: 3, end: 5, text: '成本只要三块钱' }];
const title: CardSpec = { template: 'title', props: { title: '很长的标题'.repeat(5) } };
const shot: Shot = { start: 3, end: 6, layout: 'split', card: title };
const scripted = (reply: unknown) => {
  const calls: ChatOptions[] = [];
  const client: LlmClient = { chatJson: async (o) => { calls.push(o); return reply; } };
  return { client, calls };
};

describe('reviseCard', () => {
  it('用分镜模型（low），提示词含评语、字幕、可用素材与模板目录；返回新卡片（可换模板）', async () => {
    const next = { template: 'bigNumber', props: { value: '3', unit: '元', label: '成本很低' } };
    const { client, calls } = scripted({ card: next });
    expect(await reviseCard(client, shot, caps, score, ['broll/a.jpg'])).toEqual(next);
    expect(calls[0].model).toBe(STORYBOARD_MODEL);
    expect(calls[0].reasoningEffort).toBe('low');
    expect(calls[0].user).toContain('标题溢出卡片');
    expect(calls[0].user).toContain('成本只要三块钱');
    expect(calls[0].user).toContain('broll/a.jpg');
    expect(calls[0].user).toContain('"template":"title"');
    expect(calls[0].system).toContain('bigNumber');
  });
  it('字段超长（校验失败）返回 null', async () => {
    const { client } = scripted({ card: { template: 'title', props: { title: '长'.repeat(61) } } });
    expect(await reviseCard(client, shot, caps, score)).toBeNull();
  });
  it('缺少 card 或模板不存在返回 null', async () => {
    expect(await reviseCard(scripted({}).client, shot, caps, score)).toBeNull();
    expect(await reviseCard(scripted({ card: { template: 'nope', props: {} } }).client, shot, caps, score)).toBeNull();
  });
  it('不允许 cta，也不允许非 hook 镜头换成 hook', async () => {
    expect(await reviseCard(scripted({ card: { template: 'cta', props: { actions: ['关注'] } } }).client, shot, caps, score)).toBeNull();
    const hook = { template: 'hook', props: { index: 1, total: 1, headline: '标题', highlight: [] } };
    expect(await reviseCard(scripted({ card: hook }).client, shot, caps, score)).toBeNull();
  });
  it('hook 镜头保持 hook 并沿用原来的序号；换成别的模板返回 null', async () => {
    const old: CardSpec = { template: 'hook', props: { index: 2, total: 3, headline: '旧标题', highlight: [] } };
    const hookShot: Shot = { start: 3, end: 6, layout: 'split', card: old };
    const next = { template: 'hook', props: { index: 1, total: 1, headline: '新标题抓人', highlight: ['抓人'] } };
    const res = await reviseCard(scripted({ card: next }).client, hookShot, caps, score);
    expect(res).toEqual({ template: 'hook', props: { index: 2, total: 3, headline: '新标题抓人', highlight: ['抓人'] } });
    expect(await reviseCard(scripted({ card: { template: 'title', props: { title: '标题' } } }).client, hookShot, caps, score)).toBeNull();
  });
  it('不在可用素材里的图片被去掉；photo 没有素材也没有 visual 时返回 null', async () => {
    const browser = { template: 'browser', props: { url: 'example.com', image: 'broll/ghost.jpg' } };
    expect(await reviseCard(scripted({ card: browser }).client, shot, caps, score, ['broll/a.jpg'])).toEqual({ template: 'browser', props: { url: 'example.com' } });
    expect(await reviseCard(scripted({ card: { template: 'photo', props: { image: 'broll/ghost.jpg' } } }).client, shot, caps, score)).toBeNull();
  });
  it('提示词含镜头时长，并说明不能申请新素材', async () => {
    const { client, calls } = scripted({ card: { template: 'title', props: { title: '新' } } });
    await reviseCard(client, shot, caps, score);
    expect(calls[0].user).toContain('镜头时长：3.0 秒');
    expect(calls[0].system).toContain('本次重写不能申请新素材');
  });
  it('去掉模型写的 visual；photo 只有 visual 没有可用图片时返回 null', async () => {
    const visual = { source: 'screenshot', url: 'https://example.com' };
    const browser = { template: 'browser', props: { url: 'example.com', visual } };
    expect(await reviseCard(scripted({ card: browser }).client, shot, caps, score)).toEqual({ template: 'browser', props: { url: 'example.com' } });
    expect(await reviseCard(scripted({ card: { template: 'photo', props: { visual } } }).client, shot, caps, score)).toBeNull();
    const photo = { template: 'photo', props: { image: 'broll/a.jpg', visual } };
    expect(await reviseCard(scripted({ card: photo }).client, shot, caps, score, ['broll/a.jpg'])).toEqual({ template: 'photo', props: { image: 'broll/a.jpg' } });
  });
  it('原镜头没有卡片返回 null，不调用模型', async () => {
    const { client, calls } = scripted({});
    expect(await reviseCard(client, { start: 0, end: 2, layout: 'full' }, caps, score)).toBeNull();
    expect(calls).toHaveLength(0);
  });
  it('模型请求失败时抛出', async () => {
    const client: LlmClient = { chatJson: async () => { throw new Error('boom'); } };
    await expect(reviseCard(client, shot, caps, score)).rejects.toThrow('boom');
  });
});
