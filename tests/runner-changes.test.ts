import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { EditOp } from '../src/edit/plan.js';
import type { VersionState } from '../src/edit/apply.js';
import { runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { makeFixture, type Fixture } from './helpers/runner-fakes.js';

const stateOf = (f: Fixture, n: number): VersionState => JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, n), 'state.json'), 'utf8')) as VersionState;
const splitShots = (s: VersionState): number[] => s.storyboard.shots.flatMap((shot, i) => (shot.layout === 'split' && shot.card ? [i] : []));
const metaOf = (f: Fixture, n: number) => f.store.get(f.spaceId).versions.find((v) => v.n === n)!;

async function afterV1(settings: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const f = makeFixture(settings);
  await runFirstVersion(f.ctx, f.spaceId);
  f.reset();
  return f;
}

const card = (k: number, title: string): EditOp => ({ type: 'replaceCard', shotIndex: k, card: { template: 'title', props: { title } } } as EditOp);

describe('本版改动 = 与父版本逐镜头内容比较（I2）', () => {
  it('首个版本：changedShots 为空，记下每个镜头的内容哈希', async () => {
    const f = makeFixture();
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    expect(meta.changedShots).toEqual([]);
    expect(meta.shotHashes).toHaveLength(stateOf(f, 1).storyboard.shots.length);
    expect(new Set(meta.shotHashes).size).toBe(meta.shotHashes!.length);
    // 完成事件不带本机路径
    expect(f.events.at(-1)).toMatchObject({ step: 'done', message: '完成' });
  });

  it('把卡片换回旧样子：分段命中缓存（不重渲），但和父版本不同，仍算本版改动；卡片自检同一口径', async () => {
    const f = await afterV1();
    const k = splitShots(stateOf(f, 1))[1];
    const original = stateOf(f, 1).storyboard.shots[k].card!;
    await runNextVersion(f.ctx, f.spaceId, 1, [card(k, '换过的标题')], '换卡片');
    f.reset();
    const v3 = await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'replaceCard', shotIndex: k, card: original } as EditOp], '换回去');
    expect(f.calls.segments).toEqual([]); // 命中 v1 留下的分段缓存
    // 下一镜头开头 0.3 秒里这张卡还在交叉淡出，所以它的画面也变了
    expect(v3.changedShots).toEqual([k, k + 1]);
    expect(f.calls.qaOnly).toEqual([[k]]);
    expect(v3.shotHashes).toEqual(metaOf(f, 1).shotHashes);
  });

  it('对话里换上的卡片：卡片自检只打分不重写（keep），回复说换成什么成片里就是什么', async () => {
    const f = await afterV1();
    const k = splitShots(stateOf(f, 1))[1];
    await runNextVersion(f.ctx, f.spaceId, 1, [card(k, '2. 手机放到另一个房间')], '换成标题卡');
    expect(f.calls.qaOnly).toEqual([[k]]);
    expect(f.calls.qaKeep).toEqual([[k]]);
    expect(stateOf(f, 2).storyboard.shots[k].card).toEqual({ template: 'title', props: { title: '2. 手机放到另一个房间' } });
  });

  it('回退（空操作）与只换封面：画面和父版本一样，changedShots 为空、哈希沿用父版本', async () => {
    const f = await afterV1();
    await runNextVersion(f.ctx, f.spaceId, 1, [card(splitShots(stateOf(f, 1))[0], '新标题')], '换卡片');
    const back = await runNextVersion(f.ctx, f.spaceId, 1, [], '回退到 v1');
    expect(back.changedShots).toEqual([]);
    expect(back.shotHashes).toEqual(metaOf(f, 1).shotHashes);
    const cover = await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'setCoverStyle', id: 'swiss' } as EditOp], '换封面');
    expect(cover.changedShots).toEqual([]);
    expect(cover.shotHashes).toEqual(metaOf(f, 2).shotHashes);
  });

  it('父版本是旧数据（没有记哈希）时，退回用实际重渲的镜头', async () => {
    const f = await afterV1();
    f.store.updateVersion(f.spaceId, 1, { shotHashes: undefined });
    const k = splitShots(stateOf(f, 1))[0];
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [card(k, '新标题')], '换卡片');
    // 实际重渲的段：本镜头 + 卡片交叉淡出覆盖到的下一镜头
    expect(meta.changedShots).toEqual([k, k + 1]);
  });

  it('版本花费写入前取整到 0.0001 元', async () => {
    const f = makeFixture();
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    expect(meta.costYuan).toBe(Math.round(meta.costYuan * 10_000) / 10_000);
    expect(String(meta.costYuan)).not.toMatch(/0000000|9999999/);
  });
});

describe('项目级预算（I1）', () => {
  const photo = (s: VersionState): EditOp => ({ type: 'replaceCard', shotIndex: splitShots(s)[0], card: { template: 'photo', props: { label: '应急金', visual: { source: 'generate', prompt: 'a savings jar on a desk, editorial photo' } } } } as EditOp);

  it('修改版本的上限 = 项目上限 − 此前各版本与对话的花费', async () => {
    const f = await afterV1();
    const spent = metaOf(f, 1).costYuan;
    // 剩 ¥0.3 够一张图（¥0.2）
    const rich = await afterV1({ budgetYuan: spent + 0.3 });
    await runNextVersion(rich.ctx, rich.spaceId, 1, [photo(stateOf(rich, 1))], '加图');
    expect(rich.calls.images).toHaveLength(1);
    // 同样的上限，但对话规划已花 ¥0.2：只剩 ¥0.1，不再生图
    const chatty = await afterV1({ budgetYuan: spent + 0.3 });
    chatty.store.update(chatty.spaceId, (s) => ({ ...s, chatCostYuan: 0.2 }));
    await runNextVersion(chatty.ctx, chatty.spaceId, 1, [photo(stateOf(chatty, 1))], '加图');
    expect(chatty.calls.images).toEqual([]);
  });

  it('修改版本的花费提示：「上限」写项目上限，剩余额度另写「剩余 ¥x」', async () => {
    const f = await afterV1({ budgetYuan: 5 });
    const spentV1 = metaOf(f, 1).costYuan;
    await runNextVersion(f.ctx, f.spaceId, 1, [card(splitShots(stateOf(f, 1))[0], '新标题')], '换卡片');
    const costs = f.events.filter((e) => e.detail?.kind === 'cost');
    expect(costs.length).toBeGreaterThan(0);
    const last = costs.at(-1)!;
    const total = (last.detail?.data as { total: number }).total;
    expect(last.message).toBe(`已花费 ¥${total.toFixed(2)}（项目上限 ¥5.00 · 剩余 ¥${(5 - spentV1 - total).toFixed(2)}）`);
    const data = last.detail?.data as { budget: number; cap: number };
    expect(data.cap).toBe(5);
    expect(data.budget).toBeCloseTo(5 - spentV1);
  });

  it('首个版本失败后重开：失败版本已花的钱也算进项目', async () => {
    const f = makeFixture({ budgetYuan: 2 });
    f.hooks.onSegment = () => { throw new Error('渲染炸了'); };
    await expect(runFirstVersion(f.ctx, f.spaceId)).rejects.toThrow('渲染炸了');
    const failedCost = metaOf(f, 1).costYuan;
    expect(failedCost).toBeGreaterThan(0);
    f.hooks.onSegment = undefined;
    f.reset();
    await runFirstVersion(f.ctx, f.spaceId);
    const budgetEvent = f.events.filter((e) => e.detail?.kind === 'cost').at(-1);
    expect((budgetEvent?.detail?.data as { budget: number }).budget).toBeCloseTo(2 - failedCost);
  });
});
