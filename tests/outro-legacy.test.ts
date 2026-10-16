// 旧项目（项目设置与父版本都没有片尾字段）的修改版本保持原行为：不加品牌片尾、CTA 不按新规则挪位；新项目默认开启
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_OUTRO } from '../src/compose/ending.js';
import type { VersionState } from '../src/edit/apply.js';
import type { EditOp } from '../src/edit/plan.js';
import type { MediaDeps } from '../src/pipeline/media-deps.js';
import { DEFAULT_SETTINGS } from '../src/server/spaces.js';
import type { TalkProps } from '../src/storyboard/schema.js';
import { runFirstVersion, runNextVersion } from '../src/workspace/runner.js';
import { STATE_FILE } from '../src/workspace/runner-files.js';
import { makeFixture, type Fixture } from './helpers/runner-fakes.js';

const stateFile = (f: Fixture, n: number): string => join(f.store.versionDir(f.spaceId, n), STATE_FILE);
const stateOf = (f: Fixture, n: number): VersionState => JSON.parse(readFileSync(stateFile(f, n), 'utf8')) as VersionState;
const retitle: EditOp = { type: 'replaceCard', shotIndex: 0, card: { template: 'title', props: { title: '新标题' } } } as EditOp;

/** 记下每段渲染收到的 props（看有没有片尾） */
function captureProps(f: Fixture): TalkProps[] {
  const seen: TalkProps[] = [];
  const media = f.ctx.media as Partial<MediaDeps>;
  const segments = media.segments!;
  f.ctx.media = { ...media, segments: { ...segments, renderVideo: async (o) => { seen.push(o.props); return segments.renderVideo(o); } } };
  return seen;
}

/** 父版本的末镜头换成没提前的 CTA（旧项目的分镜形态） */
function withTailCta(f: Fixture): void {
  const s = stateOf(f, 1);
  const shots = s.storyboard.shots.map((x, i, all) => (i === all.length - 1 ? { start: x.start, end: x.end, layout: 'full' as const, card: { template: 'cta' as const, props: { actions: ['关注'] } } } : x));
  writeFileSync(stateFile(f, 1), JSON.stringify({ ...s, storyboard: { ...s.storyboard, shots } }));
}

describe('片尾设置的新旧项目口径', () => {
  it('新建项目的缺省设置带片尾（默认开启）', () => {
    expect(DEFAULT_SETTINGS.outro).toEqual(DEFAULT_OUTRO);
  });

  it('旧项目改片：不加品牌片尾，末尾的 CTA 原样不挪', async () => {
    const f = makeFixture({ broll: false, outro: undefined });
    await runFirstVersion(f.ctx, f.spaceId);
    withTailCta(f);
    const seen = captureProps(f);
    const meta = await runNextVersion(f.ctx, f.spaceId, 1, [retitle], '换标题');
    expect(meta.status).toBe('done');
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((p) => p.outro === undefined)).toBe(true);
    const shots = stateOf(f, 2).storyboard.shots;
    expect(shots[shots.length - 1].card).toEqual({ template: 'cta', props: { actions: ['关注'] } });
    // 保持旧项目身份：后续版本的设置里也不补片尾字段
    expect(stateOf(f, 2).settings.outro).toBeUndefined();
  });

  it('设置里有片尾字段的项目改片：带品牌片尾，CTA 按新规则放置', async () => {
    const f = makeFixture({ broll: false, outro: { ...DEFAULT_OUTRO } });
    await runFirstVersion(f.ctx, f.spaceId);
    withTailCta(f);
    const seen = captureProps(f);
    await runNextVersion(f.ctx, f.spaceId, 1, [retitle], '换标题');
    expect(seen.some((p) => p.outro !== undefined)).toBe(true);
    const cta = stateOf(f, 2).storyboard.shots.find((s) => s.card?.template === 'cta');
    expect(cta?.card).toMatchObject({ props: { placed: true } });
  });
});
