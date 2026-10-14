import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { resolveCliPaths } from '../src/cli-paths.js';

describe('resolveCliPaths', () => {
  const base = '/home/me/videos';

  it('相对路径基于调用目录解析，默认工作目录与输出名由输入文件名派生', () => {
    expect(resolveCliPaths('a.mp4', {}, base)).toEqual({
      input: join(base, 'a.mp4'),
      workDir: join(base, 'work', 'a'),
      output: join(base, 'work', 'a', 'a_精剪.mp4'),
    });
    expect(resolveCliPaths('a.mp4', { work: 'w', output: 'out/b.mp4' }, base)).toEqual({
      input: join(base, 'a.mp4'), workDir: join(base, 'w'), output: join(base, 'out', 'b.mp4'),
    });
  });

  it('绝对路径保持不变', () => {
    expect(resolveCliPaths('/data/a.mp4', { output: '/tmp/b.mp4' }, base)).toMatchObject({ input: '/data/a.mp4', output: '/tmp/b.mp4' });
  });

  it('-o 解析后与输入相同时报错', () => {
    expect(() => resolveCliPaths('a.mp4', { output: './a.mp4' }, base)).toThrow('输出路径不能与输入视频相同');
  });
});
