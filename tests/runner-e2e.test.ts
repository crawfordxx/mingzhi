import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import type { VersionState } from '../src/edit/apply.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { probe } from '../src/media/probe.js';
import { EventBus } from '../src/workspace/events.js';
import { FINAL_FILE, runFirstVersion, runNextVersion, type RunnerCtx } from '../src/workspace/runner.js';
import { SpaceStore } from '../src/workspace/store.js';
import { hasModels } from './helpers/models.js';

/** 真实样片端到端（识别、剪切、Remotion 分段渲染、响度、成片检查都是真的；模型、卡片自检与封面用假实现） */
const STORYBOARD = { bgm: 'tech', coverTitle: { title: '高性价比' }, shots: [
  { start: 0, end: 3, layout: 'split', card: { template: 'title', props: { title: '开场' } } },
  { start: 3, end: 7, layout: 'full' },
  { start: 7, end: 10, layout: 'split', card: { template: 'title', props: { title: '第二张' } } },
] };
const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
const sha = (file: string): string => createHash('sha1').update(readFileSync(file)).digest('hex');

describe.skipIf(!hasModels())('版本运行器端到端（真实小样片）', () => {
  it('v1 全量出片；v2 换一张卡片只重渲 1 段，v1 成片不变', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mz-runner-e2e-'));
    const store = new SpaceStore(root);
    const space = store.create('样片', [join(import.meta.dirname, 'fixtures', 'talk.mp4')], { captionStyle: 'blade', budgetYuan: 5, broll: false, maxVideos: 0 });
    const ctx: RunnerCtx = {
      store, bus: new EventBus((id, n) => store.versionDir(id, n)), cfg: loadConfig({}), clients: () => ({ llm }),
      qaDeps: { qaCards: async (o) => ({ storyboard: o.storyboard, report: [] }) },
      coverDeps: { makeCovers: async (o) => {
        const files = [join(o.workDir, 'cover-3x4.png'), join(o.workDir, 'cover-4x3.png')];
        files.forEach((f) => writeFileSync(f, 'png'));
        return { cover34: files[0], cover43: files[1], attempts: 0, costYuan: 0, unverified: [], person: true, reused: [] };
      } },
    };
    const v1 = await runFirstVersion(ctx, space.id);
    const v1Final = join(store.versionDir(space.id, 1), FINAL_FILE);
    const info = await probe(v1Final, ctx.cfg);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([1080, 1920, 30, true]);
    const state = JSON.parse(readFileSync(join(store.versionDir(space.id, 1), 'state.json'), 'utf8')) as VersionState;
    expect(v1.changedShots).toEqual(state.storyboard.shots.map((_, i) => i));
    const before = sha(v1Final);
    const k = state.storyboard.shots.findIndex((s) => s.card?.props && (s.card.props as { title?: string }).title === '第二张');
    const v2 = await runNextVersion(ctx, space.id, 1, [{ type: 'replaceCard', shotIndex: k, card: { template: 'title', props: { title: '换过了' } } }], '换卡片');
    expect(v2.changedShots).toEqual([k]);
    expect(sha(v1Final)).toBe(before);
    const out = await probe(join(store.versionDir(space.id, 2), FINAL_FILE), ctx.cfg);
    expect(Math.abs(out.durationSec - info.durationSec)).toBeLessThan(0.05);
  }, 120_000);
});
