// 颗粒质感层开关：新项目默认开，旧项目（设置里没有这个字段）不传，交给 grainOn 按分镜决定
import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, parseSettingsPatch } from '../src/server/spaces.js';
import { runFirstVersion } from '../src/workspace/runner.js';
import { makeFixture } from './helpers/runner-fakes.js';

describe('颗粒设置', () => {
  it('新建项目默认开启；设置接口可开关', () => {
    expect(DEFAULT_SETTINGS.grain).toBe(true);
    expect(parseSettingsPatch({ grain: false })).toEqual({ grain: false });
    expect(() => parseSettingsPatch({ grain: 'yes' })).toThrow('设置不合法');
  });
  it('项目设置开启：渲染参数带 grain=true；旧项目没有该字段：不传（grainOn 按分镜判断）', async () => {
    const on = makeFixture({ grain: true });
    await runFirstVersion(on.ctx, on.spaceId);
    expect(on.calls.grain.length).toBeGreaterThan(0);
    expect(on.calls.grain.every((g) => g === true)).toBe(true);
    const old = makeFixture();
    await runFirstVersion(old.ctx, old.spaceId);
    expect(old.calls.grain.every((g) => g === undefined)).toBe(true);
  });
});
