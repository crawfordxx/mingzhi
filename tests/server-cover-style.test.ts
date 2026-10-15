import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VersionState } from '../src/edit/apply.js';
import { runFirstVersion } from '../src/workspace/runner.js';
import { makeFixture } from './helpers/runner-fakes.js';

/** 假封面调用记录里的风格（旧版本是字符串，新版本是 {style, workDir}） */
const styles = (covers: unknown[]): string[] => covers.map((c) => (typeof c === 'string' ? c : (c as { style: string }).style));

describe('首个版本使用项目设置里的封面风格', () => {
  it('settings.coverStyle 生效，并写进版本状态', async () => {
    const f = makeFixture({ coverStyle: 'neon' });
    await runFirstVersion(f.ctx, f.spaceId);
    expect(styles(f.calls.covers)).toEqual(['neon']);
    const state = JSON.parse(readFileSync(join(f.store.versionDir(f.spaceId, 1), 'state.json'), 'utf8')) as VersionState;
    expect(state.coverStyle).toBe('neon');
  });

  it('没设置时仍是默认的包豪斯', async () => {
    const f = makeFixture();
    await runFirstVersion(f.ctx, f.spaceId);
    expect(styles(f.calls.covers)).toEqual(['bauhaus']);
  });
});
