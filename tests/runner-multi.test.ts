import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Token, Transcript } from '../src/asr/types.js';
import type { EditOp } from '../src/edit/plan.js';
import { layoutClips } from '../src/media/concat.js';
import { runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { makeFixture, type Fixture } from './helpers/runner-fakes.js';

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** 三段口播（6 / 5 / 4 秒）：文字各不相同，每段语音从 0.5 秒开始 */
const SECS = [6, 5, 4];
const TEXTS = ['最后总结一下今天讲的内容要点', '大家好我今天来聊聊怎么存钱', '先说一个身边朋友的小案例吧'];
const tokensOf = (text: string): Token[] => [...text].map((ch, i) => ({ text: ch, start: 0.5 + i * 0.3, end: 0.75 + i * 0.3 }));
const transcriptOf = (text: string, sec: number): Transcript => {
  const tokens = tokensOf(text);
  return { durationSec: sec, segments: [{ start: 0.5, end: tokens[tokens.length - 1].end }], tokens };
};

/** 识别按临时 wav 名里的段号返回对应文字 */
function multiFixture(order: number[] | undefined): Fixture {
  const f = makeFixture({}, SECS);
  f.hooks.order = order;
  f.ctx.media = {
    ...f.ctx.media,
    transcribe: (wav) => {
      const i = Number(/segment-(\d+)\.wav$/.exec(wav)?.[1]);
      return transcriptOf(TEXTS[i], SECS[i]);
    },
  };
  return f;
}

describe('runFirstVersion：多段口播', () => {
  it('逐段识别 → 按模型顺序拼成合成原片存 base/ → 识别结果按偏移合并；其余流程把合成原片当单段原片', async () => {
    const f = multiFixture([1, 2, 0]);
    const inputs = f.store.get(f.spaceId).inputs;
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    const base = f.store.baseDir(f.spaceId);
    const source = join(base, 'source.mp4');
    expect(meta.status).toBe('done');

    // 拼接顺序 = 模型给的顺序；合成原片时长 = 各段 + 段间缓冲
    expect(f.calls.concat).toEqual([[inputs[1], inputs[2], inputs[0]]]);
    const layout = layoutClips([5, 4, 6]);
    expect(readJson<{ durationSec: number }>(source).durationSec).toBeCloseTo(layout.totalSec, 6);

    // 识别时间戳按段偏移：第二段（原第 3 段）从 5.3 秒起，第三段从 9.6 秒起
    const analysis = readJson<{ media: { durationSec: number }; transcript: Transcript }>(join(base, 'analysis.json'));
    expect(analysis.media.durationSec).toBeCloseTo(layout.totalSec, 6);
    expect(analysis.transcript.tokens.map((t) => t.text).join('')).toBe(TEXTS[1] + TEXTS[2] + TEXTS[0]);
    const firstOf = (text: string): Token => analysis.transcript.tokens.find((t, i) => t.text === text[0] && analysis.transcript.tokens[i + 1]?.text === text[1]) as Token;
    expect(firstOf(TEXTS[1]).start).toBeCloseTo(0.5, 3);
    expect(firstOf(TEXTS[2]).start).toBeCloseTo(5.3 + 0.5, 3);
    expect(firstOf(TEXTS[0]).start).toBeCloseTo(9.6 + 0.5, 3);
    expect(analysis.transcript.segments).toHaveLength(3);
    expect(analysis.transcript.segments[1].start).toBeCloseTo(5.8, 3);

    // 剪切与抠像都以合成原片为输入；原始各段不再被碰
    expect(f.calls.cutInputs).toEqual([source]);
    expect(f.calls.matte).toEqual([source]);
    // 排序花费进了本版本
    expect(f.calls.llm).toContain('段落排序');
    expect(meta.costYuan).toBeGreaterThan(0);
  });

  it('进度消息：逐段识别、排序结果、拼接', async () => {
    const f = multiFixture([2, 0, 1]);
    await runFirstVersion(f.ctx, f.spaceId);
    const messages = f.events.flatMap((e) => ('message' in e ? [String((e as { message: unknown }).message)] : []));
    expect(messages).toEqual(expect.arrayContaining([
      '识别第 1/3 段：14 字 · 0:06',
      expect.stringMatching(/^识别第 2\/3 段/),
      expect.stringMatching(/^识别第 3\/3 段/),
      '按语义重排：第 3 段 → 第 1 段 → 第 2 段',
    ]));
    expect(messages.some((m) => m.startsWith('已拼成一条合成原片'))).toBe(true);
    // 拼接期间按段发进度；拼接事件不占用「剪切完成」的 render 步骤
    expect(messages).toEqual(expect.arrayContaining(['拼接第 1/3 段', '拼接第 2/3 段', '拼接第 3/3 段']));
    const mergeEvents = f.events.filter((e) => e.message.startsWith('拼接第') || e.message.startsWith('已拼成'));
    expect(mergeEvents.every((e) => e.step === 'probe')).toBe(true);
    expect(f.events.filter((e) => e.step === 'render').every((e) => e.message === '剪切完成')).toBe(true);
    // 识别、排序都发生在剪口误之前
    const at = (needle: string | RegExp): number => messages.findIndex((m) => (typeof needle === 'string' ? m === needle : needle.test(m)));
    expect(at('按语义重排：第 3 段 → 第 1 段 → 第 2 段')).toBeLessThan(at(/^标记 \d+ 处气口/));
  });

  it('模型给出非法顺序时按上传顺序拼接，并如实说明', async () => {
    const f = multiFixture([0, 0, 1]);
    const inputs = f.store.get(f.spaceId).inputs;
    await runFirstVersion(f.ctx, f.spaceId);
    expect(f.calls.concat).toEqual([inputs]);
    const messages = f.events.flatMap((e) => ('message' in e ? [String((e as { message: unknown }).message)] : []));
    expect(messages).toContain('排序失败，按上传顺序拼接：第 1 段 → 第 2 段 → 第 3 段');
    expect(messages.some((m) => m.startsWith('按语义重排'))).toBe(false);
  });

  it('修改版本继续用合成原片重剪', async () => {
    const f = multiFixture([1, 2, 0]);
    await runFirstVersion(f.ctx, f.spaceId);
    const source = join(f.store.baseDir(f.spaceId), 'source.mp4');
    f.reset();
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'pace', direction: 'tighter' } as EditOp], '剪紧凑');
    expect(f.calls.cutInputs).toEqual([source]);
    expect(f.calls.concat).toEqual([]);
    expect(f.calls.llm).not.toContain('段落排序');
  });

  it('首版失败后重试：输入没变就沿用上次的排序，不再调模型、不重拼，抠像图层继续可用', async () => {
    const f = multiFixture([1, 2, 0]);
    const base = f.store.baseDir(f.spaceId);
    f.hooks.beforeComposite = () => { throw new Error('合成炸了'); };
    await expect(runFirstVersion(f.ctx, f.spaceId)).rejects.toThrow('合成炸了');
    expect(existsSync(join(base, 'order.json'))).toBe(true);
    expect(existsSync(join(base, 'fgr.mp4'))).toBe(true); // 抠像在合成之前已完成

    f.hooks.order = [0, 1, 2]; // 若再问一次模型，这次会给出另一个顺序
    f.hooks.beforeComposite = undefined;
    const inputs = f.store.get(f.spaceId).inputs;
    const source = readFileSync(join(base, 'source.mp4'), 'utf8');
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    expect(meta.status).toBe('done');
    expect(f.calls.concat).toEqual([[inputs[1], inputs[2], inputs[0]]]); // 只在第一次拼过
    expect(f.calls.llm.filter((l) => l === '段落排序')).toHaveLength(1);
    expect(f.calls.matte).toHaveLength(1);
    expect(readFileSync(join(base, 'source.mp4'), 'utf8')).toBe(source);
    const messages = f.events.flatMap((e) => [e.message]);
    expect(messages).toContain('沿用上次的段落顺序：第 2 段 → 第 3 段 → 第 1 段');
  });

  it('首版失败后输入文件变了：重新排序重拼，并删掉旧合成原片抠出的图层与分析结果', async () => {
    const f = multiFixture([1, 2, 0]);
    const base = f.store.baseDir(f.spaceId);
    f.hooks.beforeComposite = () => { throw new Error('合成炸了'); };
    await expect(runFirstVersion(f.ctx, f.spaceId)).rejects.toThrow('合成炸了');
    const layer = readFileSync(join(base, 'fgr.mp4'), 'utf8');

    const inputs = f.store.get(f.spaceId).inputs;
    writeFileSync(inputs[0], JSON.stringify({ kind: 'input', durationSec: 6, changed: true })); // 大小变了
    f.hooks.order = [0, 1, 2];
    f.hooks.beforeComposite = undefined;
    await runFirstVersion(f.ctx, f.spaceId);
    expect(f.calls.concat).toHaveLength(2);
    expect(f.calls.concat[1]).toEqual(inputs);
    expect(f.calls.llm.filter((l) => l === '段落排序')).toHaveLength(2);
    expect(f.calls.matte).toHaveLength(2); // 旧图层已删，重新抠像
    expect(readFileSync(join(base, 'fgr.mp4'), 'utf8')).not.toBe(layer);
    expect(readJson<{ order: number[] }>(join(base, 'order.json')).order).toEqual([0, 1, 2]);
  });

  it('单段口播不拼接、不排序，仍直接用上传的文件', async () => {
    const f = makeFixture();
    const [input] = f.store.get(f.spaceId).inputs;
    await runFirstVersion(f.ctx, f.spaceId);
    expect(f.calls.concat).toEqual([]);
    expect(f.calls.llm).not.toContain('段落排序');
    expect(f.calls.cutInputs).toEqual([input]);
    expect(f.calls.matte).toEqual([input]);
  });
});
