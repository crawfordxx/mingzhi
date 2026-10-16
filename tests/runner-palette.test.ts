// 工作台修改版本换背景后片色跟着重算（与 CLI 一样按当前背景取样），写进分镜落盘
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PALETTE, type Palette } from '../src/compose/palette.js';
import type { EditOp } from '../src/edit/plan.js';
import type { VersionState } from '../src/edit/apply.js';
import type { MediaDeps } from '../src/pipeline/media-deps.js';
import type { ProjectFile } from '../src/pipeline/project.js';
import { runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { makeFixture, type Fixture } from './helpers/runner-fakes.js';

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;
const stateOf = (f: Fixture, n: number): VersionState => readJson(join(f.store.versionDir(f.spaceId, n), 'state.json'));
const projectOf = (f: Fixture, n: number): ProjectFile => readJson(join(f.store.versionDir(f.spaceId, n), 'project.json'));
const NIGHT: Palette = { ...DEFAULT_PALETTE, tone: 'dark', stage: '#101418' };

/** 假片色：文件名里有 cafe 给夜色，其他给默认；fail 时取样出错。记下取样的文件 */
function withPalette(f: Fixture, opts: { fail?: boolean } = {}): string[] {
  const seen: string[] = [];
  const media = f.ctx.media as Partial<MediaDeps>;
  f.ctx.media = {
    ...media,
    palette: async (_ffmpeg, file) => {
      seen.push(file);
      if (opts.fail) throw new Error('取样失败');
      return file.includes('cafe') ? NIGHT : DEFAULT_PALETTE;
    },
  };
  return seen;
}

const toCafe: EditOp = { type: 'setBackground', spec: { kind: 'preset', id: 'cafe' } } as EditOp;

describe('修改版本换背景重算片色', () => {
  it('换背景：按新背景图取样，片色写进本版分镜；分段因片色变化重渲', async () => {
    const f = makeFixture({ broll: false });
    const seen = withPalette(f);
    await runFirstVersion(f.ctx, f.spaceId);
    expect(stateOf(f, 1).storyboard.palette).toEqual(DEFAULT_PALETTE);
    f.reset();
    seen.length = 0;
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [toCafe], '换背景');
    expect(meta.status).toBe('done');
    const bg = projectOf(f, 2).background?.path ?? '';
    expect(seen).toEqual([bg]);
    expect(stateOf(f, 2).storyboard.palette).toEqual(NIGHT);
    expect(projectOf(f, 2).storyboard?.palette).toEqual(NIGHT);
    expect(meta.changedShots.length).toBe(stateOf(f, 2).storyboard.shots.length);
  });

  it('不换背景的修改：不重新取样，片色沿用父版本', async () => {
    const f = makeFixture({ broll: false });
    const seen = withPalette(f);
    await runFirstVersion(f.ctx, f.spaceId);
    await runNextVersion(f.ctx, f.spaceId, 1, [toCafe], '换背景');
    seen.length = 0;
    const k = stateOf(f, 2).storyboard.shots.findIndex((s) => s.layout === 'split' && s.card);
    await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'replaceCard', shotIndex: k, card: { template: 'title', props: { title: '新标题' } } } as EditOp], '换卡片');
    expect(seen).toEqual([]);
    expect(stateOf(f, 3).storyboard.palette).toEqual(NIGHT);
  });

  it('换背景但取样失败：去掉旧片色（按默认配色），不沿用和新背景不配的片色', async () => {
    const f = makeFixture({ broll: false });
    withPalette(f);
    await runFirstVersion(f.ctx, f.spaceId);
    await runNextVersion(f.ctx, f.spaceId, 1, [toCafe], '换背景');
    withPalette(f, { fail: true });
    await runNextVersion(f.ctx, f.spaceId, 2, [{ type: 'setBackground', spec: { kind: 'preset', id: 'study' } } as EditOp], '换回书房');
    expect(stateOf(f, 3).storyboard.palette).toBeUndefined();
  });
});
