// 真实 webpack 打包（不 mock）：保证缓存确实落在数据目录，且打包前清掉过期缓存。
// 升级 Remotion / webpack 后若插件与默认值的调用顺序变了，缓存会悄悄回到 node_modules/.cache，这条用例会报警。
// 打包要几秒到十几秒，放在串行组里跑。
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { withBundle } from '../src/compose/render.js';

const STALE = 'f'.repeat(32);
let data: string;
let work: string;

beforeAll(() => {
  data = mkdtempSync(join(tmpdir(), 'mz-real-cache-'));
  work = mkdtempSync(join(tmpdir(), 'mz-real-work-'));
  vi.stubEnv('MINGZHI_DATA_DIR', data);
});
afterAll(() => {
  vi.unstubAllEnvs();
  rmSync(data, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

describe('Remotion 打包的 webpack 缓存（真实 webpack）', () => {
  it('缓存写进 <数据目录>/cache/remotion，过期的兄弟缓存被清掉，当前的被保留', { timeout: 120_000 }, async () => {
    const env = join(data, 'cache', 'remotion', 'remotion-production-0.0.1');
    mkdirSync(join(env, STALE), { recursive: true });
    writeFileSync(join(env, STALE, 'f'), 'x');

    await withBundle(work, async () => undefined);

    const cacheRoot = join(data, 'cache', 'remotion');
    expect(existsSync(env), '别的 Remotion 版本的缓存应被清掉').toBe(false);
    const envDirs = readdirSync(cacheRoot).filter((d) => d.startsWith('remotion-production-'));
    expect(envDirs).toHaveLength(1);
    const hashes = readdirSync(join(cacheRoot, envDirs[0]));
    expect(hashes).toHaveLength(1);
    expect(readdirSync(join(cacheRoot, envDirs[0], hashes[0])).length, '缓存里应有内容').toBeGreaterThan(0);

    // 再放一个过期 hash，下一次打包会把它清掉，而当前的继续命中
    mkdirSync(join(cacheRoot, envDirs[0], STALE), { recursive: true });
    await withBundle(work, async () => undefined);
    expect(readdirSync(join(cacheRoot, envDirs[0]))).toEqual(hashes);
  });
});
