import { describe, expect, it } from 'vitest';
import type { Track } from '../src/assets/catalog.js';
import { buildEditContext, formatContext } from '../src/edit/context.js';
import { applyOps } from '../src/edit/apply.js';
import { EDIT_MODEL, planEdit } from '../src/edit/plan.js';
import type { ChatOptions, LlmClient } from '../src/llm/kexiang.js';
import { makeState } from './helpers/edit-state.js';

const tracks: Track[] = [{ id: 'track-7', title: '夜航', zip: 'chill', entry: 'a.mp3', mood: 'chill', energy: 2, durationSec: 100 }];
const state = makeState();
const ctx = buildEditContext(state, '把这里换掉 @00:05', tracks);
const scripted = (reply: unknown) => {
  const calls: ChatOptions[] = [];
  const client: LlmClient = { chatJson: async (o) => { calls.push(o); return reply; } };
  return { client, calls };
};

describe('buildEditContext', () => {
  it('汇总分镜、字幕、设置，并把 @ 引用解析到镜头和字幕', () => {
    expect(ctx.shots[0]).toMatchObject({ index: 0, template: 'title', title: '开场标题' });
    expect(ctx.captions).toHaveLength(3);
    expect(ctx.refs).toEqual([{ sec: 5, shotIndex: 1, captionIndex: 1 }]);
    expect(ctx.settings).toMatchObject({ captionStyle: 'blade', coverStyle: 'bauhaus', bgm: 'auto' });
    expect(ctx.presets.map((p) => p.id)).toContain('study');
    expect(ctx.captionStyles.map((p) => p.id)).toContain('wenkai');
    expect(ctx.coverStyles.map((p) => p.id)).toContain('swiss');
    expect(ctx.tracks).toEqual([{ id: 'track-7', title: '夜航', mood: 'chill' }]);
  });
  it('超出成片时长的 @ 引用不解析到镜头，在提示词里标注已忽略；落在字幕空隙时不写字幕序号', () => {
    const c = buildEditContext({ ...state, captions: [{ start: 0, end: 3, text: '只有一句' }] }, '@00:05, @05:00', tracks);
    expect(c.refs).toEqual([{ sec: 5, shotIndex: 1 }, { sec: 300, shotIndex: -1, outOfRange: true }]);
    const text = formatContext(c);
    expect(text).toContain('@300 秒 超出成片时长，已忽略');
    expect(text).toContain('@5 秒 → 镜头 #1\n'.trim());
    expect(text).toContain('仅列出前 30 段');
    expect(text).not.toContain('字幕 #-1');
    expect(text).not.toContain('字幕 #undefined');
  });
  it('已剪掉的片段按原片时间列出（keep 之外的空隙）', () => {
    expect(ctx.cutGaps).toEqual([{ start: 0, end: 1 }, { start: 5, end: 7 }, { start: 13, end: 14 }]);
  });
});

describe('planEdit', () => {
  it('用 gemini-3.5-flash（low），提示词含用户的话、分镜、引用与可用预设', async () => {
    const { client, calls } = scripted({ reply: '好的', ops: [{ type: 'setCaptionStyle', id: 'wenkai' }] });
    const plan = await planEdit(client, '字幕换文楷 @00:05', state, tracks);
    expect(calls[0]).toMatchObject({ model: EDIT_MODEL, reasoningEffort: 'low' });
    expect(calls[0].user).toContain('字幕换文楷');
    expect(calls[0].user).toContain('开场标题');
    expect(calls[0].user).toContain('镜头 #1');
    expect(calls[0].user).toContain('study');
    expect(calls[0].system).toContain('replaceCard');
    expect(plan).toEqual({ reply: '好的', ops: [{ type: 'setCaptionStyle', id: 'wenkai' }] });
  });

  it('合法的 options 原样返回', async () => {
    const options = [{ label: '更紧凑', ops: [{ type: 'pace', direction: 'tighter' }] }, { label: '去掉这段', ops: [{ type: 'removeSpan', fromSec: 1, toSec: 2 }] }];
    const { client } = scripted({ reply: '你想怎么剪？', ops: [], options });
    expect(await planEdit(client, '节奏不对', state, tracks)).toEqual({ reply: '你想怎么剪？', ops: [], options });
  });

  it('非法操作逐条丢弃，合法的保留，回复末尾说明丢了什么', async () => {
    const { client } = scripted({ reply: '改好了', ops: [
      { type: 'setCaptionStyle', id: 'wenkai' },
      { type: 'setCaptionStyle', id: '不存在的样式' },
      { type: 'setBackground', spec: { kind: 'preset', id: 'nope' } },
      { type: 'editCaption', index: 99, text: '改' },
      { type: 'setLayout', shotIndex: 1, layout: 'split' },
      { type: 'regenerateVisual', shotIndex: 0, visual: { source: 'generate', prompt: 'a red apple on desk' } },
      { type: 'setBgm', bgm: 'ghost-track' },
      { type: 'removeSpan', fromSec: 50, toSec: 60 },
      { type: '乱写' },
    ] });
    const plan = await planEdit(client, '随便改改', state, tracks);
    expect(plan.ops).toEqual([{ type: 'setCaptionStyle', id: 'wenkai' }]);
    expect(plan.reply.startsWith('改好了')).toBe(true);
    expect(plan.reply).toContain('8 处');
    for (const hint of ['setCaptionStyle', 'nope', '第 99 句', '没有卡片', '不支持素材', 'ghost-track', '成片内', '乱写']) expect(plan.reply).toContain(hint);
  });

  it('option 里的非法操作也丢弃；没有可执行操作的 option 整个丢弃', async () => {
    const { client } = scripted({ reply: '选一个', ops: [], options: [
      { label: 'A', ops: [{ type: 'pace', direction: 'looser' }, { type: 'setCoverStyle', id: 'bad' }] },
      { label: 'B', ops: [{ type: 'setCoverStyle', id: 'bad' }] },
      '坏选项',
    ] });
    const plan = await planEdit(client, 'x', state, tracks);
    expect(plan.options).toEqual([{ label: 'A', ops: [{ type: 'pace', direction: 'looser' }] }]);
    expect(plan.reply).toContain('选项「B」');
  });

  it('合法的情绪、曲目 id 与 none 都能通过', async () => {
    const { client } = scripted({ reply: '换乐', ops: [{ type: 'setBgm', bgm: 'upbeat' }, { type: 'setBgm', bgm: 'track-7' }, { type: 'setBgm', bgm: 'none' }] });
    expect((await planEdit(client, '换配乐', state, tracks)).ops).toHaveLength(3);
  });

  it('replaceCard 的卡片必须过卡片 schema', async () => {
    const { client } = scripted({ reply: 'r', ops: [
      { type: 'replaceCard', shotIndex: 0, card: { template: 'title', props: { title: '新标题' } } },
      { type: 'replaceCard', shotIndex: 0, card: { template: 'title', props: {} } },
      { type: 'replaceCard', shotIndex: 0, card: { template: 'nonexistent', props: {} } },
    ] });
    const plan = await planEdit(client, '换卡', state, tracks);
    expect(plan.ops).toHaveLength(1);
    expect(plan.reply).toContain('2 处');
  });

  it('换模板：replaceCard 能把图片卡（photo）换成标题卡（title），校验与版式整理都不会把模板改回去', async () => {
    const { client } = scripted({ reply: '已把 @00:07 换成标题卡', ops: [
      { type: 'replaceCard', shotIndex: 2, card: { template: 'title', props: { title: '2. 手机放到另一个房间' } } },
    ] });
    const plan = await planEdit(client, '@00:07 这张卡换成大字标题「2. 手机放到另一个房间」', state, tracks);
    expect(plan.reply).toBe('已把 @00:07 换成标题卡');
    expect(applyOps(state, plan.ops).storyboard.shots[2].card).toEqual({ template: 'title', props: { title: '2. 手机放到另一个房间' } });
  });

  it('提示词要求换模板写新模板、回复只说 ops 里真正写了的修改', async () => {
    const { client, calls } = scripted({ reply: '好', ops: [] });
    await planEdit(client, 'x', state, tracks);
    expect(calls[0].system).toContain('换模板');
    expect(calls[0].system).toContain('只描述 ops');
  });

  it('模型说改了、但写的操作全都没法执行：回复里明确说这次没有执行任何修改，而不是只在末尾补一句', async () => {
    const { client } = scripted({ reply: '已替换为图片卡', ops: [
      { type: 'replaceCard', shotIndex: 2, card: { template: 'photo', props: { label: '方法二' } } },
    ] });
    const plan = await planEdit(client, '换成图片', state, tracks);
    expect(plan.ops).toEqual([]);
    expect(plan.reply).toContain('这次没有执行任何修改');
    expect(plan.reply).toContain('photo 卡片需要 visual');
  });

  it('整个输出非法时抛中文错误', async () => {
    for (const bad of [null, '一段话', [], { ops: [] }, { reply: '', ops: [] }, { reply: 'ok', ops: '不是数组' }]) {
      await expect(planEdit(scripted(bad).client, 'x', state, tracks)).rejects.toThrow('修改方案格式不对');
    }
  });

  it('缺省 ops 视为空列表（纯回答）', async () => {
    expect(await planEdit(scripted({ reply: '这个镜头是标题卡' }).client, '这是什么', state, tracks)).toEqual({ reply: '这个镜头是标题卡', ops: [] });
  });
});
