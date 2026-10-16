import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 只记录传给 bundle 的参数，不真的打包
const captured = vi.hoisted(() => ({ options: undefined as undefined | { webpackOverride: (c: Record<string, unknown>) => Record<string, unknown> } }));
vi.mock('@remotion/bundler', () => ({
  bundle: async (o: never) => {
    captured.options = o;
    return '/nonexistent-bundle-dir';
  },
}));

const { pruneStaleRemotionCaches, remotionCacheDir, withBundle } = await import('../src/compose/render.js');

afterEach(() => vi.unstubAllEnvs());

describe('Remotion webpack 缓存目录', () => {
  it('在数据目录的 cache/remotion 下，而不是应用安装目录', () => {
    expect(remotionCacheDir({ MINGZHI_DATA_DIR: '/data/Mingzhi/data' })).toBe(join('/data/Mingzhi/data', 'cache', 'remotion'));
  });

  it('打包时通过 webpack 插件把 cacheDirectory 指到该目录（bundler 之后才写 cache 配置，所以只能在插件里改）', async () => {
    vi.stubEnv('MINGZHI_DATA_DIR', '/data/Mingzhi/data');
    await withBundle('/work', async () => undefined);
    const config = captured.options!.webpackOverride({ resolve: {}, plugins: [{ keep: true }] });
    const plugins = config.plugins as { apply?: (c: unknown) => void }[];
    expect(plugins[0]).toEqual({ keep: true }); // 原有插件保留
    const compiler = { options: { cache: { type: 'filesystem', name: 'n', version: 'v' } } };
    plugins[1].apply!(compiler);
    expect((compiler.options.cache as { cacheDirectory?: string }).cacheDirectory).toBe(join('/data/Mingzhi/data', 'cache', 'remotion'));
  });

  it('webpack 关了缓存（cache 为 false）时插件不报错也不改', async () => {
    await withBundle('/work', async () => undefined);
    const plugins = captured.options!.webpackOverride({ resolve: {} }).plugins as { apply: (c: unknown) => void }[];
    const compiler = { options: { cache: false } };
    expect(() => plugins[0].apply(compiler)).not.toThrow();
    expect(compiler.options.cache).toBe(false);
  });
});

describe('清理过期的 webpack 缓存（每个应用版本一份，不清会随升级一直长）', () => {
  const NOW = 'a'.repeat(32);
  const OLD1 = 'b'.repeat(32);
  const OLD2 = 'c'.repeat(32);
  let dir: string;
  const make = (...parts: string[]): string => {
    const p = join(dir, ...parts);
    mkdirSync(p, { recursive: true });
    writeFileSync(join(p, 'f'), 'x');
    return p;
  };
  const setup = (): void => { dir = mkdtempSync(join(tmpdir(), 'mz-cache-')); };
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('删掉同一环境目录下 hash 不同的兄弟，以及别的 Remotion 版本的环境目录，当前的保留', () => {
    setup();
    make('remotion-production-4.0.531', NOW);
    make('remotion-production-4.0.531', OLD1);
    make('remotion-production-4.0.531', OLD2);
    make('remotion-production-4.0.100', OLD1);
    pruneStaleRemotionCaches(dir, `remotion-production-4.0.531${join('/', NOW)}`);
    expect(existsSync(join(dir, 'remotion-production-4.0.531', NOW, 'f'))).toBe(true);
    expect(existsSync(join(dir, 'remotion-production-4.0.531', OLD1))).toBe(false);
    expect(existsSync(join(dir, 'remotion-production-4.0.531', OLD2))).toBe(false);
    expect(existsSync(join(dir, 'remotion-production-4.0.100'))).toBe(false);
  });

  it('名称不符合模式的一律不碰（用户自己放的东西、其它缓存）', () => {
    setup();
    make('remotion-production-4.0.531', NOW);
    const mine = make('remotion-production-4.0.531', 'my-backup');
    const short = make('remotion-production-4.0.531', 'abc123');
    const other = make('other-cache', OLD1);
    const dotted = make('remotion-production-latest', OLD1);
    pruneStaleRemotionCaches(dir, `remotion-production-4.0.531/${NOW}`);
    for (const p of [mine, short, other, dotted]) expect(existsSync(join(p, 'f')), p).toBe(true);
  });

  it('缓存名认不出时什么都不删；目录不存在也不报错', () => {
    setup();
    make('remotion-production-4.0.531', OLD1);
    for (const name of ['', 'n', 'remotion-production-4.0.531', `evil/${NOW}`, `../${NOW}`, `remotion-production-4.0.531/not-a-hash`]) {
      pruneStaleRemotionCaches(dir, name);
    }
    expect(existsSync(join(dir, 'remotion-production-4.0.531', OLD1, 'f'))).toBe(true);
    expect(() => pruneStaleRemotionCaches(join(dir, 'nope'), `remotion-production-4.0.531/${NOW}`)).not.toThrow();
  });

  it('插件 apply 时顺带清理（用 bundler 给的缓存名）', async () => {
    setup();
    vi.stubEnv('MINGZHI_DATA_DIR', dir);
    const cacheRoot = join(dir, 'cache', 'remotion');
    mkdirSync(join(cacheRoot, 'remotion-production-4.0.531', OLD1), { recursive: true });
    await withBundle('/work', async () => undefined);
    const plugins = captured.options!.webpackOverride({ resolve: {} }).plugins as { apply: (c: unknown) => void }[];
    plugins[0].apply({ options: { cache: { type: 'filesystem', name: `remotion-production-4.0.531/${NOW}` } } });
    expect(existsSync(join(cacheRoot, 'remotion-production-4.0.531', OLD1))).toBe(false);
  });
});
