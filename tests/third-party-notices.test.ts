import { describe, expect, it } from 'vitest';
import { renderNotices } from '../scripts/third-party-notices.mjs';

const pkg = (name: string, version: string, license: string | null = 'MIT OR Apache-2.0') => ({
  name, version, license, repository: `https://example.test/${name}`, manifest_path: `/reg/${name}-${version}/Cargo.toml`,
});

describe('第三方许可声明', () => {
  const MIT = 'MIT License\n\nCopyright (c) 2020 Someone';
  const read = (dir: string) => {
    if (dir.includes('nolicense')) return [];
    if (dir.includes('apache')) return [{ file: 'LICENSE-APACHE', text: 'Apache License Version 2.0' }];
    return [{ file: 'LICENSE-MIT', text: MIT }];
  };

  it('按库名排序列出名称、版本、许可、仓库', () => {
    const out = renderNotices([pkg('zstd', '0.13.3'), pkg('ring', '0.17.0', 'ISC AND MIT')], read);
    expect(out.indexOf('| ring | 0.17.0 | ISC AND MIT |')).toBeGreaterThan(-1);
    expect(out.indexOf('| ring ')).toBeLessThan(out.indexOf('| zstd '));
    expect(out).toContain('https://example.test/ring');
  });

  it('内容相同的许可全文只写一份，并列出适用的库', () => {
    const out = renderNotices([pkg('a', '1.0.0'), pkg('b', '2.0.0'), pkg('c-apache', '3.0.0')], read);
    expect(out.split(MIT).length - 1).toBe(1);
    expect(out).toContain('适用于：a 1.0.0、b 2.0.0');
    expect(out).toContain('Apache License Version 2.0');
  });

  it('没有许可文件的库仍出现在清单里；许可字段缺失时有提示', () => {
    const out = renderNotices([pkg('nolicense-lib', '0.1.0', null)], read);
    expect(out).toContain('| nolicense-lib | 0.1.0 | 见许可文件 |');
  });

  it('开头说明其它组件的许可见 README', () => {
    expect(renderNotices([], read)).toContain('README「许可证」一节');
  });
});
