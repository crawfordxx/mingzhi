import { afterEach, describe, expect, it, vi } from 'vitest';
import { join } from 'node:path';

// 只记录传给 bundle 的参数，不真的打包
const captured = vi.hoisted(() => ({ options: undefined as undefined | { webpackOverride: (c: Record<string, unknown>) => Record<string, unknown> } }));
vi.mock('@remotion/bundler', () => ({
  bundle: async (o: never) => {
    captured.options = o;
    return '/nonexistent-bundle-dir';
  },
}));

const { remotionCacheDir, withBundle } = await import('../src/compose/render.js');

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
