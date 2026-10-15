import { describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError, rethrowIfCancelled, throwIfCancelled } from '../src/cancel.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { FALLBACK_PRICES } from '../src/cost/prices.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { run } from '../src/media/exec.js';
import { matteVideo } from '../src/matting/rvm.js';
import { presetPath } from '../src/background/presets.js';
import type { BrollDeps } from '../src/broll/fulfill.js';
import { runBroll } from '../src/pipeline/broll-step.js';
import { runCover } from '../src/pipeline/finish-step.js';
import type { ProjectFile, ProjectPatch } from '../src/pipeline/project.js';
import { runQaCards } from '../src/pipeline/qa-step.js';
import { runPipeline, type ProgressEvent } from '../src/pipeline/run.js';
import type { Storyboard } from '../src/storyboard/schema.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import { hasModels, hasRvm } from './helpers/models.js';

const cfg = loadConfig({});
const llm: LlmClient = { chatJson: async () => ({ cuts: [] }) };

/** 记录每次 complete；到 failOn 命中的消息时像 runPipeline 取消时那样抛 CancelledError（此时结果已「落盘」） */
function recorder<S extends string>(failOn: (message: string) => boolean): { calls: { step: S; message: string; patch?: ProjectPatch }[]; complete: (step: S, message: string, patch?: ProjectPatch) => ProjectFile } {
  const calls: { step: S; message: string; patch?: ProjectPatch }[] = [];
  return {
    calls,
    complete: (step, message, patch) => {
      calls.push({ step, message, patch });
      if (failOn(message)) throw new CancelledError();
      return {} as ProjectFile;
    },
  };
}

const VISUAL = { source: 'generate' as const, prompt: 'a savings jar on a desk, editorial photo' };
const BROLL_STORYBOARD: Storyboard = { shots: [
  { start: 0, end: 5, layout: 'split', card: { template: 'photo', props: { visual: VISUAL } } },
  { start: 5, end: 10, layout: 'full' },
] };
const SB: Storyboard = { shots: [{ start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '开场' } } }] };

describe('cancel 工具', () => {
  it('throwIfCancelled / rethrowIfCancelled：只对已取消与 CancelledError 抛错', () => {
    const c = new AbortController();
    expect(() => throwIfCancelled(c.signal)).not.toThrow();
    expect(() => throwIfCancelled(undefined)).not.toThrow();
    c.abort();
    expect(() => throwIfCancelled(c.signal)).toThrow('已取消');
    expect(() => rethrowIfCancelled(new CancelledError())).toThrow(CancelledError);
    expect(() => rethrowIfCancelled(new Error('别的'))).not.toThrow();
  });
});

describe('取消不被「失败降级」吞掉', () => {
  it('B-roll：成功摘要处取消 → 抛 CancelledError，不发「素材获取失败」，不写 fallback 分镜', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-br-'));
    const deps: BrollDeps = {
      screenshot: async () => { throw new Error('不应截图'); },
      search: async () => [],
      image: async (_p, out) => { await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x960', '-frames:v', '1', out]); return { cost: 0.2 }; },
      video: async () => { throw new Error('不应生成视频'); },
    };
    const { calls, complete } = recorder<'broll'>((m) => m.startsWith('素材 1 个'));
    await expect(runBroll({ workDir, cfg, broll: { enabled: true, maxVideos: 0, budgetYuan: 10 }, brollDeps: deps }, BROLL_STORYBOARD, 10, complete)).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toHaveLength(1);
    expect(calls[0].message).toContain('花费');
    expect(calls.some((c) => c.message.includes('素材获取失败'))).toBe(false);
  });

  it('B-roll：取素材途中抛 CancelledError → 原样重抛，不调用 complete', async () => {
    const deps: BrollDeps = {
      screenshot: async () => { throw new Error('不应截图'); }, search: async () => [], video: async () => { throw new Error('x'); },
      image: async () => { throw new CancelledError(); },
    };
    const { calls, complete } = recorder<'broll'>(() => false);
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-br-'));
    await expect(runBroll({ workDir, cfg, broll: { enabled: true, maxVideos: 0, budgetYuan: 10 }, brollDeps: deps }, BROLL_STORYBOARD, 10, complete)).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toEqual([]);
  });

  it('B-roll：signal 已取消 → 逐条取素材前就抛 CancelledError，不调用任何素材依赖', async () => {
    const controller = new AbortController();
    controller.abort();
    const deps: BrollDeps = {
      screenshot: async () => { throw new Error('不应调用'); }, search: async () => { throw new Error('不应调用'); },
      image: async () => { throw new Error('不应调用'); }, video: async () => { throw new Error('不应调用'); },
    };
    const { calls, complete } = recorder<'broll'>(() => false);
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-br-'));
    await expect(runBroll({ workDir, cfg, broll: { enabled: true, maxVideos: 0, budgetYuan: 10 }, brollDeps: deps, signal: controller.signal }, BROLL_STORYBOARD, 10, complete)).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toEqual([]);
  });

  it('封面：「封面已生成」处取消 → 抛 CancelledError，不再发「封面生成失败，已跳过」', async () => {
    const makeCovers = async (): Promise<never> => ({ cover34: 'a', cover43: 'b', attempts: 1, costYuan: 1.2, unverified: [], person: true, reused: [] }) as never;
    const { calls, complete } = recorder<'loudness' | 'cover'>((m) => m.startsWith('封面已生成'));
    await expect(runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: { makeCovers } }, undefined, SB, [{ start: 0, end: 3, text: '你好' }], 'x', complete)).rejects.toBeInstanceOf(CancelledError);
    expect(calls.map((c) => c.message.slice(0, 5))).toEqual(['生成封面中', '封面已生成']);
  });

  it('封面：生图途中抛 CancelledError → 原样重抛', async () => {
    const makeCovers = async (): Promise<never> => { throw new CancelledError(); };
    const { calls, complete } = recorder<'loudness' | 'cover'>(() => false);
    await expect(runCover({ workDir: '/tmp/w', cfg, llm, coverDeps: { makeCovers } }, undefined, SB, [{ start: 0, end: 3, text: '你好' }], 'x', complete)).rejects.toBeInstanceOf(CancelledError);
    expect(calls.map((c) => c.message)).toEqual(['生成封面中…（约 2 分钟，约 ¥1.2）']);
  });

  it('卡片自检：自检过程抛 CancelledError → 原样重抛，不发「卡片自检失败，已跳过」', async () => {
    const { calls, complete } = recorder<'qa-cards'>(() => false);
    const ctx = { llm, workDir: '/tmp/w', meter: new CostMeter(FALLBACK_PRICES, 10), ffmpeg: 'ffmpeg', qaCards: async () => { throw new CancelledError(); } };
    await expect(runQaCards(ctx, SB, [], complete)).rejects.toBeInstanceOf(CancelledError);
    expect(calls).toEqual([]);
  });
});

describe('runPipeline 取消与事件（不需要本地模型）', () => {
  it('probe 之后取消：先有 probe 事件与首条 cost 事件，下一步不再开始，project.json 仍落盘', async () => {
    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-'));
    await expect(runPipeline({
      input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm, signal: controller.signal,
      meter: new CostMeter(FALLBACK_PRICES, 10),
      onProgress: (e) => { events.push(e); if (e.step === 'probe' && e.detail?.kind === 'cost') controller.abort(); },
    })).rejects.toBeInstanceOf(CancelledError);
    expect(events.map((e) => e.step)).toEqual(['probe', 'probe']);
    expect(events[0].detail).toBeUndefined();
    expect(events[1]).toMatchObject({ message: '已花费 ¥0.00（上限 ¥10.00）', detail: { kind: 'cost', data: { total: 0, budget: 10 } } });
  });

  it('cost 事件：花费没变就不重复发；不限预算时 budget 为 null、消息不带上限', async () => {
    const controller = new AbortController();
    const events: ProgressEvent[] = [];
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-'));
    await expect(runPipeline({
      input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm, signal: controller.signal,
      onProgress: (e) => { events.push(e); if (e.step === 'audio') controller.abort(); },
    })).rejects.toBeInstanceOf(CancelledError);
    expect(events.map((e) => `${e.step}:${e.detail?.kind ?? '-'}`)).toEqual(['probe:-', 'probe:cost', 'audio:-']);
    expect(events[1].detail).toEqual({ kind: 'cost', data: { total: 0, budget: null } });
    expect(events[1].message).toBe('已花费 ¥0.00');
  });
});

describe('步骤内部响应取消', () => {
  it('matteVideo：开始前已取消 → 直接抛 CancelledError', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(matteVideo({ input: 'tests/fixtures/talk.mp4', output: join(tmpdir(), 'x.mp4'), backgroundPath: 'x', cfg, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
  });

  it.skipIf(!hasRvm())('matteVideo：抠像中途取消 → 抛 CancelledError（不包成「抠像换背景失败」），不再处理后面的帧', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-cancel-rvm-'));
    const input = join(dir, 'in.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0x808080:s=180x320:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    const controller = new AbortController();
    const seen: number[] = [];
    // 占位的「上一次的好文件」：取消后必须原样保留，且不留临时文件
    writeFileSync(join(dir, 'out.mp4'), 'previous-good');
    await expect(matteVideo({
      input, output: join(dir, 'out.mp4'), backgroundPath: presetPath('cafe'), cfg, signal: controller.signal,
      onProgress: (done) => { seen.push(done); controller.abort(); },
    })).rejects.toBeInstanceOf(CancelledError);
    expect(seen.at(-1)).toBeLessThan(90);
    expect(readFileSync(join(dir, 'out.mp4'), 'utf8')).toBe('previous-good');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp.'))).toEqual([]);
  });
});

describe.skipIf(!hasModels())('取消与余额不足同时出现（需要本地模型）', () => {
  it('取消后在途的付费调用报余额不足：runPipeline 以取消为准，抛 CancelledError 而不是余额错误', async () => {
    const controller = new AbortController();
    const brokeAfterCancel: LlmClient = { chatJson: async () => { controller.abort(); throw new InsufficientBalanceError(); } };
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-bal-'));
    await expect(runPipeline({ input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm: brokeAfterCancel, signal: controller.signal }))
      .rejects.toBeInstanceOf(CancelledError);
  });

  it('没有取消时余额不足照常外抛', async () => {
    const broke: LlmClient = { chatJson: async () => { throw new InsufficientBalanceError(); } };
    const workDir = mkdtempSync(join(tmpdir(), 'mz-cancel-bal-'));
    await expect(runPipeline({ input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm: broke }))
      .rejects.toBeInstanceOf(InsufficientBalanceError);
  });
});
