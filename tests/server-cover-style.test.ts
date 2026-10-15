import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionState } from '../src/edit/apply.js';
import { runFirstVersion } from '../src/workspace/runner.js';
import { makeFixture } from './helpers/runner-fakes.js';

describe('首个版本使用项目设置里的封面风格', () => {
  it('settings.coverStyle 生效，并写进版本状态', async () => {
    const f = makeFixture({ coverStyle: 'neon' });
    await runFirstVersion(f.ctx, f.spaceId);
    expect(f.calls.covers).toEqual(['neon']);
    const state = JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'state.json'), 'utf8')) as VersionState;
    expect(state.coverStyle).toBe('neon');
  });

  it('没设置时仍是默认的包豪斯', async () => {
    const f = makeFixture();
    await runFirstVersion(f.ctx, f.spaceId);
    expect(f.calls.covers).toEqual(['bauhaus']);
  });
});
