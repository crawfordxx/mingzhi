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
  it('覆盖全部模板', () => {
    expect(CATALOG.map((c) => c.id).sort()).toEqual([...TEMPLATE_IDS].sort());
  });
});

describe('generateStoryboard', () => {
  it('用 gemini-3.5-flash（low），用户消息含带时间的字幕、总时长与可用素材；返回归一化后的分镜', async () => {
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

const bad = { shots: [{ start: 0, end: 5, layout: 'split', card: { template: 'title', props: {} } }, { start: 5, end: 9, layout: 'split', card: { template: 'nope', props: {} } }] };
const oneCard = { shots: [{ start: 0, end: 9, layout: 'split', card: { template: 'title', props: { title: '只有一个' } } }] };

describe('generateStoryboard：重试保护与择优', () => {
  it('重试请求失败时返回首次结果，attempts 为 2 并带 retryError', async () => {
    let n = 0;
    const client: LlmClient = { chatJson: async () => { n += 1; if (n === 1) return bad; throw new Error('超时'); } };
    const res = await generateStoryboard(client, caps, 9, []);
    expect(res.attempts).toBe(2);
    expect(res.retryError).toContain('超时');
    expect(res.dropped).toBe(2);
  });
  it('第二次更差时保留首次；dropped 相同则取带卡片更多的', async () => {
    const worse = { shots: [{ start: 0, end: 9, layout: 'split', card: { template: 'nope', props: {} } }] };
    const first = await generateStoryboard(scripted(oneCard, worse).client, caps, 9, []);
    expect(first.storyboard.shots[0].card?.template).toBe('title');
    expect(first.attempts).toBe(2);
    const tie = await generateStoryboard(scripted(oneCard, good).client, caps, 9, []);
    expect(tie.storyboard.shots.filter((s) => s.card)).toHaveLength(2);
  });
  it('带卡片镜头不足 2 个触发重试，提示按原因区分；非数组回复也触发', async () => {
    const { client, calls } = scripted(oneCard, good);
    await generateStoryboard(client, caps, 9, []);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('带卡片的镜头只有 1 个');
    expect(calls[1].user).not.toContain('个镜头不合格');
    const arr = scripted('不是对象', good);
    await generateStoryboard(arr.client, caps, 9, []);
    expect(arr.calls).toHaveLength(2);
  });
  it('重试消息带前几个 zod 错误摘要', async () => {
    const { client, calls } = scripted(bad, good);
    await generateStoryboard(client, caps, 9, []);
    expect(calls[1].user).toContain('2 个镜头不合格');
    expect(calls[1].user).toContain('card.props.title');
  });
  it('可用素材为空时写「可用素材：无」，且不再含镜头数提示', async () => {
    const { client, calls } = scripted(good);
    await generateStoryboard(client, caps, 9, []);
    expect(calls[0].user).toContain('可用素材：无');
    expect(calls[0].user).not.toContain('镜头数约');
  });
  it('cta 的 actions 固定为 关注/点赞/收藏', async () => {
    const withCta = { shots: [...good.shots.slice(0, 1), { start: 5, end: 9, layout: 'full', card: { template: 'cta', props: { actions: ['联系我'] } } }] };
    const res = await generateStoryboard(scripted(withCta).client, caps, 9, []);
    expect(res.storyboard.shots[res.storyboard.shots.length - 1].card).toEqual({ template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } });
  });
});

describe('generateStoryboard：背景乐情绪与封面标题', () => {
  it('提示词要求 bgm 与 coverTitle；回复里的值经归一化保留', async () => {
    const { client, calls } = scripted({ ...good, bgm: 'tech', coverTitle: { title: 'FDE 岗位定性了', subtitle: '生命周期很长' } });
    const res = await generateStoryboard(client, caps, 9, []);
    expect(calls[0].system).toContain('"bgm"');
    expect(calls[0].system).toContain('coverTitle');
    expect(res.storyboard).toMatchObject({ bgm: 'tech', coverTitle: { title: 'FDE 岗位定性了', subtitle: '生命周期很长' } });
  });
  it('缺省或非法时 bgm 为 chill、coverTitle 缺省；小标题超长只丢小标题；重试择优后仍保留', async () => {
    expect((await generateStoryboard(scripted(good).client, caps, 9, [])).storyboard).toMatchObject({ bgm: 'chill' });
    expect((await generateStoryboard(scripted({ ...good, bgm: 'loud', coverTitle: { title: '' } }).client, caps, 9, [])).storyboard.coverTitle).toBeUndefined();
    const long = await generateStoryboard(scripted({ ...good, coverTitle: { title: '短标题', subtitle: '字'.repeat(17) } }).client, caps, 9, []);
    expect(long.storyboard.coverTitle).toEqual({ title: '短标题' });
    const bad = { shots: [{ start: 0, end: 9, layout: 'split', card: { template: 'nope', props: {} } }], bgm: 'upbeat' };
    const retried = await generateStoryboard(scripted(bad, { ...good, bgm: 'upbeat' }).client, caps, 9, []);
    expect(retried.attempts).toBe(2);
    expect(retried.storyboard.bgm).toBe('upbeat');
  });
});

describe('generateStoryboard：多样性规则与持续演进', () => {
  const ev = (t: string) => ({ template: 'evidenceList', props: { title: t, rows: [{ badge: '证据', text: '都是乙方身份' }, { badge: '成本', text: '贵 3 元' }] } });
  it('提示词写明多样性、徽章、钩子画面、来源标签与 reveal 规则', async () => {
    const { client, calls } = scripted(good);
    await generateStoryboard(client, caps, 9, []);
    for (const k of ['最多连续 2 个', '20%', '4 种呈现模式', '「要点」', 'source', 'reveal', 'overlay', 'flow']) expect(calls[0].system).toContain(k);
  });
  it('违反多样性规则时带规则原因重试 1 次；规则修正后的结果不再违规', async () => {
    const broken = { shots: [0, 1, 2].map((i) => ({ start: i * 3, end: i * 3 + 3, layout: 'split', card: ev(`第 ${i} 张`) })) };
    const { client, calls } = scripted(broken, broken);
    const res = await generateStoryboard(client, caps, 9, []);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('多样性规则');
    expect(res.storyboard.shots.filter((s) => s.card?.template === 'evidenceList').length).toBeLessThanOrEqual(1);
    expect(res.storyboard.shots.flatMap((s) => (s.card?.template === 'evidenceList' ? s.card.props.rows.map((r) => r.badge) : []))).not.toContain('证据');
  });
  it('演进卡没写 reveal 时按镜头内字幕起点补齐（镜头内秒数）', async () => {
    const flow = { shots: [
      { start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '开头' } } },
      { start: 3, end: 9, layout: 'split', card: { template: 'flow', props: { steps: [{ label: '需求' }, { label: '开发' }, { label: '验收' }] } } },
    ] };
    const caps2 = [{ start: 0, end: 3, text: '开头' }, { start: 3, end: 5, text: '先提需求' }, { start: 5, end: 7, text: '再开发' }, { start: 7, end: 9, text: '最后验收' }];
    const res = await generateStoryboard(scripted(flow).client, caps2, 9, []);
    expect(res.storyboard.shots[1].card?.props).toMatchObject({ reveal: [0, 2, 4] });
  });
});

describe('generateStoryboard：卡片标题要是完整意思', () => {
  const caps3 = [{ start: 0, end: 3, text: '前面的话' }, { start: 3, end: 4, text: '每天睡前' }, { start: 4, end: 6, text: '列出明天的清单' }];
  const half = { shots: [
    { start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '开头' } } },
    { start: 3, end: 6, layout: 'split', card: { template: 'title', props: { title: '第三个习惯：每天睡前' } } },
  ] };
  it('提示词写明标题要完整（句末或完整短语）', async () => {
    const { client, calls } = scripted(good);
    await generateStoryboard(client, caps, 9, []);
    expect(calls[0].system).toContain('完整的意思');
    expect(calls[0].system).toContain('话说一半');
  });
  it('话说一半的标题按字幕整句补全，不触发重试', async () => {
    const { client, calls } = scripted(half);
    const res = await generateStoryboard(client, caps3, 6, []);
    expect(calls).toHaveLength(1);
    const second = res.storyboard.shots[1].card;
    expect(second?.template === 'title' && second.props.title).toBe('第三个习惯：每天睡前列出明天的清单');
  });
  it('补不出来的标题带原因重试 1 次', async () => {
    const bad = { shots: [{ start: 0, end: 6, layout: 'split', card: { template: 'title', props: { title: '提高效率的' } } }] };
    const { client, calls } = scripted(bad, bad);
    await generateStoryboard(client, caps3, 6, []);
    expect(calls).toHaveLength(2);
    expect(calls[1].user).toContain('话没说完');
  });
});

