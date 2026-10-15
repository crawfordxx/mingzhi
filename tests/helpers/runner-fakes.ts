import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Token } from '../../src/asr/types.js';
import type { BrollDeps } from '../../src/broll/fulfill.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { CostMeter } from '../../src/cost/meter.js';
import type { LlmClient } from '../../src/llm/kexiang.js';
import { layoutClips } from '../../src/media/concat.js';
import { RVM_FILE } from '../../src/matting/rvm.js';
import type { CoverDeps } from '../../src/pipeline/finish-step.js';
import type { MediaDeps } from '../../src/pipeline/media-deps.js';
import type { QaDeps } from '../../src/pipeline/qa-step.js';
import { EventBus, type WorkEvent } from '../../src/workspace/events.js';
import type { RunnerCtx } from '../../src/workspace/runner.js';
import { SpaceStore, type SpaceSettings } from '../../src/workspace/store.js';

/** 原片 12 秒：两段语音，文字里有一个「嗯」会被剪掉 */
export const SOURCE_SEC = 12;
const TEXT = '大家好今天聊聊怎么存钱嗯第一步先存应急金第二步再考虑投资最后记得关注';
export const TOKENS: Token[] = [...TEXT].map((ch, i) => ({ text: ch, start: 0.3 + i * 0.3, end: 0.3 + i * 0.3 + 0.25 }));
const SEGMENTS = [{ start: 0.3, end: 5.3 }, { start: 5.6, end: 10.6 }];

/** 假模型给的分镜：三张分屏标题卡夹两个全屏镜头 */
const STORYBOARD = { bgm: 'tech', coverTitle: { title: '怎么存钱', subtitle: '三步走' }, shots: [
  { start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: '开场' } } },
  { start: 2, end: 4, layout: 'full' },
  { start: 4, end: 6, layout: 'split', card: { template: 'title', props: { title: '第一步' } } },
  { start: 6, end: 8, layout: 'full' },
  { start: 8, end: 9.6, layout: 'split', card: { template: 'title', props: { title: '第二步' } } },
] };

export interface Calls {
  llm: string[]; renderCut: unknown[][]; matte: string[]; composite: { bg: string; keep: unknown; cut: string; fgr: string; matte: string }[]; segments: string[]; concat: string[][]; cutInputs: string[]; audio: number;
  qaOnly: (number[] | undefined)[]; hard: string[]; covers: { style: string; workDir: string }[]; images: string[]; videos: string[];
}

const json = (file: string): Record<string, unknown> => JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;

/** 假模型：剪掉「嗯」、字幕校对返回非法结果（走兜底分行）、分镜固定；每次调用记账 ¥0.01 */
function fakeLlm(calls: Calls, meter: CostMeter, hooks: Hooks): LlmClient {
  return {
    chatJson: async (o) => {
      calls.llm.push(o.label ?? o.model);
      meter.addTask('fake', 0.01, o.label ?? 'llm');
      if (o.system.includes('编排')) return { order: hooks.order ?? [] };
      if (o.system.includes('分镜')) return STORYBOARD;
      if (o.system.includes('剪辑师')) return { cuts: [{ from: TEXT.indexOf('嗯'), to: TEXT.indexOf('嗯'), type: 'filler', reason: '语气词' }] };
      return { lines: [] };
    },
  };
}

/** 假媒体处理：文件内容是描述产物的 JSON，探测时从中读回时长 */
function fakeMedia(calls: Calls, hooks: Hooks): Partial<MediaDeps> {
  const keepSec = (keep: { start: number; end: number }[]): number => keep.reduce((s, r) => s + r.end - r.start, 0);
  return {
    probe: async (path) => ({ durationSec: Number(json(path).durationSec), width: 540, height: 960, fps: 30, hasAudio: true }),
    extractWav: async (_i, wav) => { writeFileSync(wav, 'wav'); },
    transcribe: () => ({ durationSec: SOURCE_SEC, segments: SEGMENTS, tokens: TOKENS }),
    renderCut: async (input, keep, output) => { calls.cutInputs.push(input); calls.renderCut.push(keep); writeFileSync(output, JSON.stringify({ kind: 'cut', keep, durationSec: keepSec(keep) })); },
    matte: async (o) => {
      calls.matte.push(o.input);
      const src = json(o.input);
      if (o.output) writeFileSync(o.output, JSON.stringify({ kind: 'person', of: src, bg: o.backgroundPath, durationSec: src.durationSec }));
      if (o.matteOutput) writeFileSync(o.matteOutput, JSON.stringify({ kind: 'matte', of: src }));
      if (o.fgrOutput) writeFileSync(o.fgrOutput, JSON.stringify({ kind: 'fgr', of: src }));
      return { frames: 360, subject: { top: 0.2, bottom: 1, left: 0.2, right: 0.8 }, gains: [1, 1, 1], fps: 30, fgMean: [0.5, 0.4, 0.3] };
    },
    composite: async (o) => {
      calls.composite.push({ bg: o.backgroundPath, keep: o.keep, cut: o.cut, fgr: o.fgr, matte: o.matte });
      await hooks.beforeComposite?.();
      const cut = json(o.cut);
      writeFileSync(o.output, JSON.stringify({ kind: 'person', of: cut, keep: o.keep, bg: o.backgroundPath, fgr: json(o.fgr), matte: json(o.matte), durationSec: cut.durationSec }));
    },
    segments: {
      withBundle: (_dir, fn) => fn('fake://bundle'),
      renderVideo: async (o) => { calls.segments.push(`${o.startFrame}-${o.endFrame}`); await hooks.onSegment?.(); writeFileSync(o.output, `${o.startFrame}-${o.endFrame}`); },
      renderAudio: async (o) => { calls.audio += 1; writeFileSync(o.output, 'aac'); },
      concat: async (o) => { writeFileSync(o.output, JSON.stringify({ kind: 'final', files: o.files.length, durationSec: o.durationSec })); },
    },
    concat: async (o) => {
      calls.concat.push(o.clips.map((c) => c.path));
      writeFileSync(o.output, JSON.stringify({ kind: 'source', clips: o.clips.length, durationSec: layoutClips(o.clips.map((c) => c.durationSec)).totalSec }));
    },
    loudness: async (input, output) => { copyFileSync(input, output); return { before: -20, after: -14, truePeak: -2, mode: 'linear' }; },
  };
}

const fakeQa = (calls: Calls): QaDeps => ({
  qaCards: async (o) => {
    calls.qaOnly.push(o.only);
    const targets = o.storyboard.shots.flatMap((s, i) => (s.layout === 'split' && s.card && (!o.only || o.only.includes(i)) ? [i] : []));
    const score = { layout: 9, hierarchy: 8, motion: 8, brand: 9, notes: '无' };
    return { storyboard: o.storyboard, report: targets.map((shotIndex) => ({ shotIndex, scores: [score], revised: 0, passed: true })) };
  },
  hardChecks: async (video) => { calls.hard.push(video); return [{ id: 'fps', ok: true, detail: '30 fps' }]; },
});

const fakeCover = (calls: Calls): CoverDeps => ({
  makeCovers: async (o) => {
    calls.covers.push({ style: o.style, workDir: o.workDir });
    const cover34 = join(o.workDir, 'cover-3x4.png');
    const cover43 = join(o.workDir, 'cover-4x3.png');
    writeFileSync(cover34, `3x4 ${o.style}`);
    writeFileSync(cover43, `4x3 ${o.style}`);
    o.meter?.addTask('cover', 1.2, '封面');
    return { cover34, cover43, attempts: 2, costYuan: 1.2, unverified: [], person: true, reused: [] };
  },
});

/** 假素材：写出文件并按单价记账 */
const fakeBroll = (calls: Calls) => (meter: CostMeter): BrollDeps => ({
  screenshot: async () => { throw new Error('不应截图'); },
  search: async () => [],
  image: async (prompt, out) => { calls.images.push(prompt); writeFileSync(out, 'jpg'); meter.addTask('img', 0.2, '生图'); return { cost: 0.2 }; },
  video: async (prompt, out) => { calls.videos.push(prompt); writeFileSync(out, 'mp4'); meter.addTask('video', 2.4, '视频'); return { cost: 2.4 }; },
});

export interface Hooks { onSegment?: () => Promise<void> | void; beforeComposite?: () => Promise<void> | void; /** 多段口播时假模型给出的段落顺序 */ order?: number[] }

export interface Fixture { ctx: RunnerCtx; store: SpaceStore; spaceId: string; calls: Calls; events: WorkEvent[]; hooks: Hooks; reset: () => void; cfg: AppConfig }

export const DEFAULT_SETTINGS: SpaceSettings = { background: { kind: 'preset', id: 'study' }, captionStyle: 'blade', budgetYuan: 20, broll: true, maxVideos: 1 };

const emptyCalls = (): Calls => ({ llm: [], renderCut: [], matte: [], composite: [], segments: [], concat: [], cutInputs: [], audio: 0, qaOnly: [], hard: [], covers: [], images: [], videos: [] });

/** 建一个临时项目与全部假依赖；reset() 清空调用记录（在 v1 跑完之后调用，只看修改版本做了什么） */
export function makeFixture(settings: Partial<SpaceSettings> = {}, inputSecs: number[] = [SOURCE_SEC]): Fixture {
  const root = mkdtempSync(join(tmpdir(), 'mz-runner-'));
  const modelsDir = join(root, 'models');
  mkdirSync(modelsDir);
  writeFileSync(join(modelsDir, RVM_FILE), 'fake'); // 只用于通过「抠像模型已下载」的前置检查
  const cfg: AppConfig = { ...loadConfig({}), dataDir: join(root, 'data'), modelsDir, kexiangKey: undefined };
  const inputs = inputSecs.map((durationSec, i) => join(root, `talk${i}.mp4`));
  inputs.forEach((input, i) => writeFileSync(input, JSON.stringify({ kind: 'input', durationSec: inputSecs[i] })));
  const store = new SpaceStore(join(root, 'spaces'));
  const space = store.create('测试项目', inputs, { ...DEFAULT_SETTINGS, ...settings });
  const bus = new EventBus((id, n) => store.versionDir(id, n));
  const events: WorkEvent[] = [];
  bus.subscribe(space.id, (e) => events.push(e));
  const calls = emptyCalls();
  const hooks: Hooks = {};
  const ctx: RunnerCtx = {
    store, bus, cfg,
    clients: (meter) => ({ llm: fakeLlm(calls, meter, hooks) }),
    media: fakeMedia(calls, hooks), qaDeps: fakeQa(calls), coverDeps: fakeCover(calls), brollDeps: fakeBroll(calls),
  };
  const reset = (): void => { Object.assign(calls, emptyCalls()); events.length = 0; };
  return { ctx, store, spaceId: space.id, calls, events, hooks, reset, cfg };
}
