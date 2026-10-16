import { describe, expect, it, vi } from 'vitest';
// 和新建项目一样带片尾设置（没有片尾字段的是旧项目，修改版本不加片尾）
import { DEFAULT_OUTRO } from '../src/compose/ending.js';
import ort from 'onnxruntime-node';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, type AppConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import type { VersionState } from '../src/edit/apply.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { probe } from '../src/media/probe.js';
import { EventBus } from '../src/workspace/events.js';
import { FINAL_FILE, runFirstVersion, runNextVersion, type RunnerCtx } from '../src/workspace/runner.js';
import { SpaceStore } from '../src/workspace/store.js';
import { hasModels, hasRvm } from './helpers/models.js';

/** 真实样片端到端（识别、剪切、Remotion 分段渲染、响度、成片检查都是真的；模型、卡片自检与封面用假实现） */
const STORYBOARD = { bgm: 'tech', coverTitle: { title: '高性价比' }, shots: [
  { start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '开场' } } },
  { start: 3, end: 7, layout: 'full' },
  { start: 7, end: 10, layout: 'split', card: { template: 'title', props: { title: '第二张' } } },
] };
const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
const sha = (file: string): string => createHash('sha1').update(readFileSync(file)).digest('hex');

/** 假模型、假卡片自检与假封面；其余（识别、剪切、抠像、合成、渲染、响度、成片检查）都是真的 */
const baseCtx = (store: SpaceStore, cfg: AppConfig): RunnerCtx => ({
  store, bus: new EventBus((id, n) => store.versionDir(id, n)), cfg, clients: () => ({ llm }),
  qaDeps: { qaCards: async (o) => ({ storyboard: o.storyboard, report: [] }) },
  coverDeps: { makeCovers: async (o) => {
    const files = [join(o.workDir, 'cover-3x4.png'), join(o.workDir, 'cover-4x3.png')];
    files.forEach((f) => writeFileSync(f, 'png'));
    return { cover34: files[0], cover43: files[1], attempts: 0, costYuan: 0, unverified: [], person: true, reused: [] };
  } },
});

/** 解码数出的帧数 */
const frames = async (cfg: AppConfig, file: string): Promise<number> => {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
  return Number(stdout.trim());
};

describe.skipIf(!hasModels())('版本运行器端到端（真实小样片）', () => {
  it('v1 全量出片；v2 换一张卡片只重渲 1 段，v1 成片不变', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mz-runner-e2e-'));
    const store = new SpaceStore(root);
    const space = store.create('样片', [join(import.meta.dirname, 'fixtures', 'talk.mp4')], { captionStyle: 'blade', budgetYuan: 5, broll: false, maxVideos: 0, outro: { ...DEFAULT_OUTRO } });
    const ctx = baseCtx(store, loadConfig({}));
    const v1 = await runFirstVersion(ctx, space.id);
    const v1Final = join(store.versionDir(space.id, 1), FINAL_FILE);
    const info = await probe(v1Final, ctx.cfg);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([1080, 1920, 30, true]);
    const state = JSON.parse(readFileSync(join(store.versionDir(space.id, 1), 'state.json'), 'utf8')) as VersionState;
    expect(v1.changedShots).toEqual([]); // 首版没有父版本可比
    expect(v1.shotHashes).toHaveLength(state.storyboard.shots.length);
    const before = sha(v1Final);
    const k = state.storyboard.shots.findIndex((s) => s.card?.props && (s.card.props as { title?: string }).title === '第二张');
    const v2 = await runNextVersion(ctx, space.id, 1, [{ type: 'replaceCard', shotIndex: k, card: { template: 'title', props: { title: '换过了' } } }], '换卡片');
    // 用户可见的改动只有本镜头；下一镜头（这张卡在它开头 0.3 秒里交叉淡出）只是被重渲
    expect(v2.changedShots).toEqual([k]);
    expect(v2.rerenderedShots).toEqual([k, k + 1]);
    expect(sha(v1Final)).toBe(before);
    const out = await probe(join(store.versionDir(space.id, 2), FINAL_FILE), ctx.cfg);
    expect(Math.abs(out.durationSec - info.durationSec)).toBeLessThan(0.05);
  }, 120_000);

  it.skipIf(!hasRvm())('有背景：v1 整条抠像后合成；v2 删一段只重剪与合成（不建推理会话），人像与剪切帧数一致', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mz-runner-e2e-bg-'));
    const cfg = loadConfig({});
    const input = join(root, 'talk8.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', join(import.meta.dirname, 'fixtures', 'talk.mp4'), '-t', '8', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const store = new SpaceStore(root);
    const space = store.create('样片', [input], { background: { kind: 'preset', id: 'cafe' }, captionStyle: 'blade', budgetYuan: 5, broll: false, maxVideos: 0, outro: { ...DEFAULT_OUTRO } });
    const ctx: RunnerCtx = { ...baseCtx(store, cfg) };
    await runFirstVersion(ctx, space.id);
    const spy = vi.spyOn(ort.InferenceSession, 'create');
    try {
      await runNextVersion(ctx, space.id, 1, [{ type: 'removeSpan', fromSec: 1, toSec: 2.5 }], '删一段');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
    for (const n of [1, 2]) {
      const dir = store.versionDir(space.id, n);
      const [cut, person] = await Promise.all([frames(cfg, join(dir, 'cut.mp4')), frames(cfg, join(dir, 'person.mp4'))]);
      const keep = (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as VersionState).plan.keep;
      expect(person, `v${n} ${JSON.stringify(keep)}`).toBe(cut);
      const info = await probe(join(dir, FINAL_FILE), cfg);
      expect([info.width, info.height, info.hasAudio]).toEqual([1080, 1920, true]);
    }
  }, 120_000);
});
