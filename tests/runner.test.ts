import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CancelledError } from '../src/cancel.js';
import type { EditOp } from '../src/edit/plan.js';
import type { VersionState } from '../src/edit/apply.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { FINAL_FILE, runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { makeFixture, TOKENS, type Fixture } from './helpers/runner-fakes.js';
import { sameBackground } from '../src/workspace/runner-media.js';
import type { BackgroundSpec } from '../src/background/resolve.js';

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const stateOf = (f: Fixture, n: number): VersionState => readJson(join(f.store.versionDir(f.spaceId, n), 'state.json'));
const projectOf = (f: Fixture, n: number): ProjectFile => readJson(join(f.store.versionDir(f.spaceId, n), 'project.json'));
const inode = (file: string): number => statSync(file).ino;

/** 目录快照：相对路径 → 内容哈希 + 修改时间（递归，含 events.jsonl） */
function snapshot(dir: string, prefix = ''): Record<string, string> {
  return Object.fromEntries(readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return Object.entries(snapshot(path, `${prefix}${e.name}/`));
    const st = statSync(path);
    return [[`${prefix}${e.name}`, `${createHash('sha1').update(readFileSync(path)).digest('hex')}@${st.mtimeMs}`]];
  }));
}

/** 跑完 v1 后清空调用记录，返回夹具 */
async function afterV1(settings: Parameters<typeof makeFixture>[0] = {}): Promise<Fixture> {
  const f = makeFixture(settings);
  await runFirstVersion(f.ctx, f.spaceId);
  f.reset();
  return f;
}

const splitShots = (s: VersionState): number[] => s.storyboard.shots.flatMap((shot, i) => (shot.layout === 'split' && shot.card ? [i] : []));

describe('runFirstVersion', () => {
  it('跑完整流程：与版本无关的产物写 base/，其余写 v1/，结束写 state.json，事件带项目与版本号', async () => {
    const f = makeFixture();
    const meta = await runFirstVersion(f.ctx, f.spaceId);
    const base = f.store.baseDir(f.spaceId);
    const v1 = f.store.versionDir(f.spaceId, 1);
    expect(meta).toMatchObject({ n: 1, status: 'done', summary: '首个版本' });
    for (const name of ['analysis.json', 'audio16k.wav', 'cut.mp4', 'fgr.mp4', 'matte.mp4', 'matte.json']) expect(existsSync(join(base, name)), name).toBe(true);
    for (const name of ['state.json', 'project.json', FINAL_FILE, 'person.mp4', 'cover-3x4.png', 'cover-4x3.png', 'events.jsonl']) expect(existsSync(join(v1, name)), name).toBe(true);
    expect(existsSync(join(base, 'segments'))).toBe(true);
    const state = stateOf(f, 1);
    expect(state).toMatchObject({ coverStyle: 'bauhaus', bgm: { bgm: 'auto' }, extraCuts: [], restored: [], settings: { captionStyle: 'blade' } });
    expect(state.storyboard.shots.length).toBeGreaterThan(1);
    // 首个版本：每个镜头都是新渲染的，但没有父版本可比，本版改动为空
    expect(f.calls.segments).toHaveLength(state.storyboard.shots.length);
    expect(meta.changedShots).toEqual([]);
    // 抠像对整条原片（不是剪切结果），只出前景与遮罩；人像由合成得到，取帧方案就是 v1 的剪辑方案
    expect(f.calls.matte).toEqual([f.store.get(f.spaceId).inputs[0]]);
    expect(f.calls.composite).toEqual([expect.objectContaining({ keep: state.plan.keep, cut: join(v1, 'cut.mp4'), fgr: join(base, 'fgr.mp4'), matte: join(base, 'matte.mp4') })]);
    expect(readJson<{ of: { keep: unknown }; keep: unknown }>(join(v1, 'person.mp4')).of.keep).toEqual(state.plan.keep);
    expect(f.calls.qaOnly).toEqual([undefined]);
    expect(f.calls.covers).toEqual([{ style: 'bauhaus', workDir: join(base, 'covers', 'bauhaus') }]);
    expect(f.calls.hard).toEqual([join(v1, FINAL_FILE)]);
    expect(f.calls.llm).toEqual(expect.arrayContaining(['剪口误', '分镜']));
    expect(meta.costYuan).toBeCloseTo(f.calls.llm.length * 0.01 + 1.2); // 每次模型调用 ¥0.01 + 封面
    expect(meta.qaScore).toBeCloseTo(8.5);
    expect(f.events.every((e) => e.spaceId === f.spaceId && e.version === 1)).toBe(true);
    expect(f.events.at(-1)?.step).toBe('done');
    expect(f.events.map((e) => e.step)).toEqual(expect.arrayContaining(['probe', 'asr', 'cuts', 'plan', 'render', 'background', 'matte', 'captions', 'storyboard', 'qa-cards', 'compose', 'loudness', 'qa-final', 'cover']));
    expect(f.store.get(f.spaceId).versions[0].status).toBe('done');
  });

  it('有背景时先提示「对整条原片抠像」，并清掉硬杀留下的临时图层文件', async () => {
    const f = makeFixture();
    const stale = join(f.store.baseDir(f.spaceId), 'fgr.mp4.0a1b2c3d.tmp.mp4');
    writeFileSync(stale, 'x');
    await runFirstVersion(f.ctx, f.spaceId);
    expect(existsSync(stale)).toBe(false);
    const matte = f.events.filter((e) => e.step === 'matte').map((e) => e.message);
    expect(matte[0]).toMatch(/^对整条原片抠像.*之后换背景、改节奏都不用再抠$/);
    expect(matte.at(-1)).toMatch(/^换背景合成完成/);
  });

  it('没有背景时不抠像，人像就是剪切结果', async () => {
    const f = makeFixture({ background: undefined });
    await runFirstVersion(f.ctx, f.spaceId);
    const v1 = f.store.versionDir(f.spaceId, 1);
    expect(f.calls.matte).toEqual([]);
    expect(inode(join(v1, 'person.mp4'))).toBe(inode(join(f.store.baseDir(f.spaceId), 'cut.mp4')));
  });
});

describe('runNextVersion：只重跑受影响的阶段', () => {
  it('setCaptionStyle 只跑成片：不剪切、不抠像、不调模型、不重做封面，复用全部抠像产物', async () => {
    const f = await afterV1();
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setCaptionStyle', id: 'wenkai' } as EditOp], '换字幕样式');
    const v1 = f.store.versionDir(f.spaceId, 1);
    const v2 = f.store.versionDir(f.spaceId, 2);
    expect(meta).toMatchObject({ n: 2, parent: 1, status: 'done', summary: '换字幕样式' });
    expect(f.calls).toMatchObject({ llm: [], renderCut: [], matte: [], composite: [], covers: [], qaOnly: [] });
    for (const name of ['cut.mp4', 'person.mp4', 'cover-3x4.png']) expect(inode(join(v2, name)), name).toBe(inode(join(v1, name)));
    // 字幕样式影响每一帧：全部镜头重渲
    expect(meta.changedShots).toEqual(stateOf(f, 2).storyboard.shots.map((_, i) => i));
    expect(stateOf(f, 2).settings.captionStyle).toBe('wenkai');
    expect(f.calls.hard).toEqual([join(v2, FINAL_FILE)]); // 成片硬检查每版都做
    expect(meta.costYuan).toBe(0);
    expect(f.events.every((e) => e.version === 2)).toBe(true);
  });

  it('replaceCard 只重渲那 1 段与下一段（卡片在下一镜头开头交叉淡出），卡片自检只查这张卡', async () => {
    const f = await afterV1();
    const before = stateOf(f, 1);
    const k = splitShots(before)[1];
    const op = { type: 'replaceCard', shotIndex: k, card: { template: 'title', props: { title: '换过的标题' } } } as EditOp;
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [op], '换卡片');
    expect(meta.changedShots).toEqual([k, k + 1]);
    expect(f.calls.segments).toHaveLength(2);
    expect(f.calls.qaOnly).toEqual([[k]]);
    expect(stateOf(f, 2).storyboard.shots[k].card).toEqual({ template: 'title', props: { title: '换过的标题' } });
  });

  it('setBackground 不调用抠像推理：用 base 的整条图层只做合成', async () => {
    const f = await afterV1();
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } } as EditOp], '换背景');
    expect(f.calls.matte).toEqual([]);
    expect(f.calls.composite).toHaveLength(1);
    expect(f.calls.composite[0].bg).toMatch(/cafe/);
    expect(f.calls.composite[0].matte).toBe(join(f.store.baseDir(f.spaceId), 'matte.mp4'));
    expect(f.calls.renderCut).toEqual([]);
    const v2 = f.store.versionDir(f.spaceId, 2);
    expect(readJson<{ bg: string }>(join(v2, 'person.mp4')).bg).toMatch(/cafe/);
    expect(meta.changedShots.length).toBe(stateOf(f, 2).storyboard.shots.length);
    expect(projectOf(f, 2).subject).toEqual({ top: 0.2, bottom: 1, left: 0.2, right: 0.8 });
  });

  it('v1 没有背景时 setBackground 才对整条原片跑一次抠像推理，图层存 base/ 供以后只合成', async () => {
    const f = await afterV1({ background: undefined });
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } } as EditOp], '加背景');
    expect(f.calls.matte).toHaveLength(1);
    expect(existsSync(join(f.store.baseDir(f.spaceId), 'fgr.mp4'))).toBe(true);
    f.reset();
    await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'setBackground', spec: { kind: 'preset', id: 'study' } } as EditOp], '再换');
    expect(f.calls.matte).toEqual([]);
    expect(f.calls.composite).toHaveLength(1);
  });

  it('removeSpan 重跑剪切到成片：重剪、按新方案从整条图层合成人像（不再跑抠像推理），字幕与分镜平移（不调模型）', async () => {
    const f = await afterV1();
    const before = stateOf(f, 1);
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'removeSpan', fromSec: 1, toSec: 3 }], '删一段');
    const after = stateOf(f, 2);
    expect(f.calls.renderCut).toHaveLength(1);
    expect(f.calls.matte).toEqual([]);
    expect(f.calls.composite).toEqual([expect.objectContaining({ keep: after.plan.keep, cut: join(f.store.versionDir(f.spaceId, 2), 'cut.mp4') })]);
    // 人像的取帧方案与本版剪切是同一个
    const person = readJson<{ of: { keep: unknown }; keep: unknown }>(join(f.store.versionDir(f.spaceId, 2), 'person.mp4'));
    expect(person.keep).toEqual(person.of.keep);
    expect(f.calls.llm).toEqual([]);
    expect(after.plan.outputDurationSec).toBeLessThan(before.plan.outputDurationSec - 1.5);
    expect(after.extraCuts.length).toBe(1);
    expect(after.captions.length).toBeGreaterThan(0);
    expect(after.captions.at(-1)!.end).toBeLessThanOrEqual(after.plan.outputDurationSec + 1e-6);
    expect(after.storyboard.shots.at(-1)!.end).toBeCloseTo(after.plan.outputDurationSec);
    expect(meta.changedShots.length).toBeGreaterThan(0);
    expect(existsSync(join(f.store.baseDir(f.spaceId), 'cut.mp4'))).toBe(true);
    expect(readJson<{ keep: unknown }>(join(f.store.baseDir(f.spaceId), 'cut.mp4')).keep).toEqual(before.plan.keep); // base 里 v1 的剪切不被覆盖
  });

  it('restoreSpan 找回被剪掉的「嗯」并补上字幕；pace 收紧重剪；都不调模型', async () => {
    const f = await afterV1();
    const before = stateOf(f, 1);
    const um = TOKENS.find((t) => t.text === '嗯')!;
    expect(before.captions.map((c) => c.text).join('')).not.toContain('嗯');
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'restoreSpan', fromSec: um.start, toSec: um.end }], '找回');
    const restored = stateOf(f, 2);
    expect(restored.captions.map((c) => c.text).join('')).toContain('嗯');
    expect(restored.plan.outputDurationSec).toBeGreaterThan(before.plan.outputDurationSec);
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'pace', direction: 'tighter' }], '紧凑');
    expect(stateOf(f, 3).plan.outputDurationSec).toBeLessThan(before.plan.outputDurationSec);
    expect(f.calls.renderCut).toHaveLength(2);
    expect(f.calls.llm).toEqual([]);
  });

  it('setCoverStyle 只重做封面：成片直接复用，不渲染；成片检查照做', async () => {
    const f = await afterV1();
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setCoverStyle', id: 'swiss' } as EditOp], '换封面');
    const v1 = f.store.versionDir(f.spaceId, 1);
    const v2 = f.store.versionDir(f.spaceId, 2);
    expect(f.calls.covers.map((c) => c.style)).toEqual(['swiss']);
    expect(f.calls.segments).toEqual([]);
    expect(meta.changedShots).toEqual([]);
    expect(inode(join(v2, FINAL_FILE))).toBe(inode(join(v1, FINAL_FILE)));
    expect(readFileSync(join(v2, 'cover-3x4.png'), 'utf8')).toBe('3x4 swiss');
    expect(readFileSync(join(v1, 'cover-3x4.png'), 'utf8')).toBe('3x4 bauhaus');
    expect(f.calls.hard).toEqual([join(v2, FINAL_FILE)]);
    expect(meta.costYuan).toBeCloseTo(1.2);
  });

  it('换成带素材需求的卡片：按预算取素材并记进本版花费；预算不够或关闭 B-roll 时不付费', async () => {
    const visualOp = (s: VersionState): EditOp => ({ type: 'replaceCard', shotIndex: splitShots(s)[0], card: { template: 'photo', props: { label: '应急金', visual: { source: 'generate', prompt: 'a savings jar on a desk, editorial photo' } } } } as EditOp);
    const f = await afterV1();
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [visualOp(stateOf(f, 1))], '加图');
    expect(f.calls.images).toHaveLength(1);
    expect(meta.costYuan).toBeCloseTo(0.2);
    const photo = stateOf(f, 2).storyboard.shots.find((s) => s.card?.template === 'photo');
    const image = (photo?.card?.props as { image?: string }).image ?? '';
    expect(existsSync(join(f.store.versionDir(f.spaceId, 2), image))).toBe(true);

    const poor = await afterV1({ budgetYuan: 0.1 }); // 预算按项目计：v1 已超 ¥0.1，没有余额生图（预估 ¥0.2）
    await runNextVersion(poor.ctx, poor.spaceId, 1, [visualOp(stateOf(poor, 1))], '加图');
    expect(poor.calls.images).toEqual([]);

    const off = await afterV1({ broll: false });
    await runNextVersion(off.ctx, off.spaceId, 1, [visualOp(stateOf(off, 1))], '加图');
    expect(off.calls.images).toEqual([]);
    expect(stateOf(off, 2).storyboard.shots.some((s) => s.card?.template === 'photo')).toBe(false);
  });

  it('regenerateVisual 换素材重新付费；maxVideos 用完时不再生成视频', async () => {
    const f = await afterV1();
    const k = splitShots(stateOf(f, 1))[0];
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'replaceCard', shotIndex: k, card: { template: 'photo', props: { label: '图', visual: { source: 'generate', prompt: 'a savings jar on a desk, editorial photo' } } } } as EditOp], '加图');
    f.reset();
    const photo = stateOf(f, 2).storyboard.shots.findIndex((s) => s.card?.template === 'photo');
    const meta = await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'regenerateVisual', shotIndex: photo, visual: { source: 'generate', prompt: 'a piggy bank on a shelf, editorial photo' } }], '换图');
    expect(f.calls.images).toEqual(['a piggy bank on a shelf, editorial photo']);
    expect(f.calls.qaOnly).toEqual([[photo]]);
    expect(meta.changedShots).toContain(photo);

    const g = await afterV1({ maxVideos: 0 });
    const hook = { template: 'hook', props: { index: 1, total: 1, headline: '钱要放在取得到的地方', highlight: ['取得到'], visual: { source: 'video', prompt: 'a jar of coins on a wooden table, slow push in' } } };
    await runNextVersion(g.ctx, g.spaceId, 1, [{ type: 'replaceCard', shotIndex: 0, card: hook } as EditOp], '加开场视频');
    expect(g.calls.videos).toEqual([]);
    f.reset();
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'replaceCard', shotIndex: 0, card: hook } as EditOp], '加开场视频');
    expect(f.calls.videos).toHaveLength(1); // 对照：maxVideos 为 1 时会生成
  });

  it('空操作（回退）：全部复用父版本，状态与父版本一致', async () => {
    const f = await afterV1();
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [], '回退到 v1');
    expect(meta.changedShots).toEqual([]);
    expect(f.calls).toMatchObject({ segments: [], covers: [], matte: [], composite: [] });
    expect(stateOf(f, 2)).toEqual(stateOf(f, 1));
    expect(meta.qaScore).toBeCloseTo(8.5);
  });
});

describe('修复轮 1 补充', () => {
  it('回退后再换背景：以 v1 为父时用 v1 的剪切与剪辑方案合成，不用较新版本的', async () => {
    const f = await afterV1();
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'removeSpan', fromSec: 1, toSec: 3 }], '删一段');
    f.reset();
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } } as EditOp], '回到 v1 换背景');
    const v1 = f.store.versionDir(f.spaceId, 1);
    const v3 = f.store.versionDir(f.spaceId, 3);
    expect(f.calls.matte).toEqual([]);
    expect(f.calls.composite).toEqual([expect.objectContaining({ keep: stateOf(f, 1).plan.keep, cut: join(v3, 'cut.mp4') })]);
    expect(inode(join(v3, 'cut.mp4'))).toBe(inode(join(v1, 'cut.mp4')));
    const person = readJson<{ of: { keep: unknown }; keep: unknown }>(join(v3, 'person.mp4'));
    expect(person.of.keep).toEqual(stateOf(f, 1).plan.keep);
    expect(person.keep).toEqual(person.of.keep);
  });

  it('已有出片版本时不能再跑首个版本（不覆盖共享的分析结果）；父版本未置 done 时不能在它上面修改', async () => {
    const f = await afterV1();
    const analysis = readFileSync(join(f.store.baseDir(f.spaceId), 'analysis.json'), 'utf8');
    await expect(runFirstVersion(f.ctx, f.spaceId)).rejects.toThrow('项目已有出片版本');
    expect(f.store.get(f.spaceId).versions).toHaveLength(1);
    expect(readFileSync(join(f.store.baseDir(f.spaceId), 'analysis.json'), 'utf8')).toBe(analysis);
    f.store.updateVersion(f.spaceId, 1, { status: 'running' }); // 模拟写完 state.json 后、置 done 前进程被杀
    await expect(runNextVersion(f.ctx, f.spaceId, 1, [], '回退')).rejects.toThrow('v1 还没有完成');
  });

  it('素材名额先给没改动的卡片：父版本已用掉视频名额时，新加在前面的视频卡退为生图，旧视频卡保留', async () => {
    const f = await afterV1();
    const hook = (prompt: string, i: number) => ({ type: 'replaceCard', shotIndex: i, card: { template: 'hook', props: { index: 1, total: 1, headline: '钱要放在取得到的地方', highlight: ['取得到'], visual: { source: 'video', prompt } } } }) as EditOp;
    const later = splitShots(stateOf(f, 1))[1];
    await runNextVersion(f.ctx, f.spaceId, 1, [hook('old clip of coins on a table', later)], '后面加视频');
    expect(f.calls.videos).toEqual(['old clip of coins on a table']);
    f.reset();
    await runNextVersion(f.ctx, f.spaceId, 2, [hook('new clip of a piggy bank', 0)], '前面再加视频');
    expect(f.calls.videos).toEqual([]);
    expect(f.calls.images).toEqual(['new clip of a piggy bank']);
    const cards = stateOf(f, 3).storyboard.shots.flatMap((sh) => (sh.card?.template === 'hook' ? [sh.card.props as { video?: string; visual?: { prompt: string } }] : []));
    expect(cards.find((c) => c.visual?.prompt === 'old clip of coins on a table')?.video).toMatch(/\.mp4$/);
  });

  it('换回用过的封面风格：在 base/covers/<风格> 里生成，命中已付费的底图缓存', async () => {
    const f = await afterV1();
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setCoverStyle', id: 'swiss' } as EditOp], 'swiss');
    await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'setCoverStyle', id: 'bauhaus' } as EditOp], '换回');
    const covers = join(f.store.baseDir(f.spaceId), 'covers');
    expect(f.calls.covers).toEqual([{ style: 'swiss', workDir: join(covers, 'swiss') }, { style: 'bauhaus', workDir: join(covers, 'bauhaus') }]);
    expect(readFileSync(join(f.store.versionDir(f.spaceId, 2), 'cover-3x4.png'), 'utf8')).toBe('3x4 swiss');
  });

  it('sameBackground 按字段比较，不受键顺序影响', () => {
    expect(sameBackground({ kind: 'prompt', prompt: '海边' }, JSON.parse('{"prompt":"海边","kind":"prompt"}') as BackgroundSpec)).toBe(true);
    expect(sameBackground({ kind: 'preset', id: 'cafe' }, { kind: 'preset', id: 'study' })).toBe(false);
    expect(sameBackground(undefined, undefined)).toBe(true);
    expect(sameBackground({ kind: 'preset', id: 'cafe' }, undefined)).toBe(false);
  });
});

describe('runNextVersion：失败与取消', () => {
  it('父版本目录不被修改：成功的修改与中途失败的修改都不动 v1', async () => {
    const f = await afterV1();
    const v1 = f.store.versionDir(f.spaceId, 1);
    const before = snapshot(v1);
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'removeSpan', fromSec: 1, toSec: 3 }], '删一段');
    await runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setCaptionStyle', id: 'wenkai' } as EditOp], '换字幕');
    f.hooks.beforeComposite = () => { throw new Error('合成炸了'); };
    await expect(runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } } as EditOp], '换背景')).rejects.toThrow('合成炸了');
    expect(snapshot(v1)).toEqual(before);
    const failed = f.store.get(f.spaceId).versions.find((v) => v.n === 4);
    expect(failed?.status).toBe('failed');
    expect(existsSync(join(f.store.versionDir(f.spaceId, 4), 'state.json'))).toBe(false);
  });

  it('取消：抛 CancelledError（「已取消」），版本置 failed 并记下已花费', async () => {
    const f = await afterV1();
    const controller = new AbortController();
    f.hooks.onSegment = () => controller.abort();
    await expect(runNextVersion({ ...f.ctx, signal: controller.signal }, f.spaceId, 1, [{ type: 'setCaptionStyle', id: 'wenkai' } as EditOp], '换字幕')).rejects.toBeInstanceOf(CancelledError);
    expect(f.store.get(f.spaceId).versions.find((v) => v.n === 2)).toMatchObject({ status: 'failed', costYuan: 0 });
  });

  it('修改全部不合法：不跑任何阶段，版本置 failed，报错说明原因', async () => {
    const f = await afterV1();
    await expect(runNextVersion(f.ctx, f.spaceId, 1, [{ type: 'setLayout', shotIndex: 99, layout: 'split' }], '乱改')).rejects.toThrow('没有可执行的修改');
    expect(f.calls.segments).toEqual([]);
    expect(f.store.get(f.spaceId).versions.find((v) => v.n === 2)?.status).toBe('failed');
  });

  it('父版本未完成（没有 state.json）时报错', async () => {
    const f = makeFixture();
    f.hooks.onSegment = () => { throw new Error('渲染炸了'); };
    await expect(runFirstVersion(f.ctx, f.spaceId)).rejects.toThrow('渲染炸了');
    expect(f.store.get(f.spaceId).versions[0].status).toBe('failed');
    await expect(runNextVersion(f.ctx, f.spaceId, 1, [], '回退')).rejects.toThrow('v1 还没有完成');
    await expect(runNextVersion(f.ctx, f.spaceId, 9, [], '回退')).rejects.toThrow('版本不存在：v9');
  });
});
