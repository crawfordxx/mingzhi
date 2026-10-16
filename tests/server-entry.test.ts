import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isEntry } from '../src/server/index.js';

describe('服务入口判定（realpath 比较）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-entry-'));
  const real = join(dir, 'real');
  mkdirSync(join(real, 'src'), { recursive: true });
  writeFileSync(join(real, 'src', 'index.ts'), '');
  writeFileSync(join(real, 'src', 'other.ts'), '');
  // Windows 上建 junction 不需要管理员权限
  symlinkSync(real, join(dir, 'link'), 'junction');
  // ESM 的 import.meta.url 是解析过链接的真实路径，argv[1] 可能经过链接
  const metaUrl = pathToFileURL(join(real, 'src', 'index.ts')).href;

  it('argv[1] 就是这个文件', () => {
    expect(isEntry(metaUrl, join(real, 'src', 'index.ts'))).toBe(true);
  });

  it('argv[1] 经过符号链接 / junction 指向同一个文件', () => {
    expect(isEntry(metaUrl, join(dir, 'link', 'src', 'index.ts'))).toBe(true);
  });

  it('别的文件、不存在的路径、没有 argv[1] 都不算入口', () => {
    expect(isEntry(metaUrl, join(real, 'src', 'other.ts'))).toBe(false);
    expect(isEntry(metaUrl, join(dir, 'nope.ts'))).toBe(false);
    expect(isEntry(metaUrl, undefined)).toBe(false);
  });
});
