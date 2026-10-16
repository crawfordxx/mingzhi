import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import * as zlib from 'node:zlib';
import {
  APP_ENTRIES, BUILD_OUTPUTS, DEVICE_NAMES, UNSAFE_CHARS, checkNames, collectEntries, currentPlatform, keepPath, nameProblem, trackedFiles, unpackBudget, writeTarZst,
} from '../scripts/bundle-lib.mjs';

const ROOT = join(import.meta.dirname, '..');
// @types/node 22.10 还没有 zstd 的声明（Node 22.15 起内置）
const { zstdDecompressSync } = zlib as unknown as { zstdDecompressSync: (b: Buffer) => Buffer };

describe('严格文件名规则（与启动器 Rust 侧 paths::is_safe_component 一致）', () => {
  it('字符集与设备名列表和 launcher/src/paths.rs 完全相同', () => {
    const rs = readFileSync(join(ROOT, 'launcher', 'src', 'paths.rs'), 'utf8');
    const chars = /"(.*?)"\s*\.contains\(c\)/.exec(rs)?.[1].replace(/\\"/g, '"');
    expect(chars).toBe(UNSAFE_CHARS);
    const devices = /DEVICE_NAMES: \[&str; \d+\] = \[([\s\S]*?)\];/.exec(rs)?.[1].match(/"([A-Z0-9]+)"/g)?.map((s) => s.slice(1, -1));
    expect(devices).toEqual([...DEVICE_NAMES]);
  });

  it.each([
    ['a:b.js', '含字符 :'],
    ['what?.js', '含字符 ?'],
    ['star*', '含字符 *'],
    ['q"x', '含字符 "'],
    ['pipe|x', '含字符 |'],
    ['lt<', '含字符 <'],
    ['tab\tx', '含控制字符'],
    ['del\u007fx', '含控制字符'],
    ['c1\u0085x', '含控制字符'],
    ['trail.', '以点结尾'],
    ['trail ', '以空格结尾'],
    ['aux.js', 'Windows 设备名'],
    ['CON', 'Windows 设备名'],
    ['nul.d.ts', 'Windows 设备名'],
    ['Com1 .txt', 'Windows 设备名'],
    ['lpt9', 'Windows 设备名'],
  ])('拒绝 %j（%s）', (name, why) => {
    expect(nameProblem(name)).toContain(why);
  });

  it.each(['index.js', 'auxiliary.js', 'com10.js', 'console.js', '.bin', '中文.ts', 'a b.js', '..x', 'LICENSE'])('接受 %j', (name) => {
    expect(nameProblem(name)).toBeUndefined();
  });

  it('checkNames 逐个组件检查（同一坏目录只报一次），并找出只差大小写的重名（macOS / Windows 上会互相覆盖）', () => {
    const problems = checkNames(['node_modules/x/aux.js', 'node_modules/y/README', 'node_modules/y/readme', 'src/ok.ts', 'node_modules/z:z/index.js']);
    expect(problems).toEqual([
      { path: 'node_modules/x/aux.js', reason: expect.stringContaining('Windows 设备名') },
      { path: 'node_modules/z:z', reason: expect.stringContaining('含字符 :') },
      { path: 'node_modules/y/readme', reason: expect.stringContaining('node_modules/y/README') },
    ]);
  });
});

describe('打包剪枝', () => {
  const plat = 'darwin-arm64';
  it.each([
    'node_modules/.bin',
    'node_modules/foo/.bin',
    'node_modules/foo/index.js.map',
    'node_modules/foo/index.d.ts',
    'node_modules/foo/index.d.mts',
    'node_modules/foo/README.md',
    'node_modules/foo/CHANGELOG.md',
    'node_modules/foo/__tests__',
    'node_modules/.modules.yaml',
    'node_modules/.pnpm',
    'node_modules/.pnpm/lock.yaml',
    'node_modules/onnxruntime-node/bin/napi-v3/linux',
    'node_modules/onnxruntime-node/bin/napi-v3/win32',
    'node_modules/onnxruntime-node/bin/napi-v3/darwin/x64',
    'src/.DS_Store',
  ])('去掉 %s', (p) => {
    expect(keepPath(p, plat)).toBe(false);
  });

  it.each([
    'node_modules/foo/index.js',
    'node_modules/foo/LICENSE.md',
    'node_modules/foo/license',
    'node_modules/foo/NOTICE.md',
    'node_modules/onnxruntime-node/bin/napi-v3/darwin',
    'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64',
    'node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64/onnxruntime_binding.node',
    'src/server/index.ts',
    'src/types/x.d.ts',
    'web/dist/assets/index.js.map',
  ])('保留 %s', (p) => {
    expect(keepPath(p, plat)).toBe(true);
  });

  it('其它平台保留各自的 onnxruntime 目录', () => {
    expect(keepPath('node_modules/onnxruntime-node/bin/napi-v3/win32/x64', 'win32-x64')).toBe(true);
    expect(keepPath('node_modules/onnxruntime-node/bin/napi-v3/win32/arm64', 'win32-x64')).toBe(false);
    expect(keepPath('node_modules/onnxruntime-node/bin/napi-v3/darwin/x64', 'darwin-x64')).toBe(true);
    expect(keepPath('node_modules/onnxruntime-node/bin/napi-v3/darwin/arm64', 'darwin-x64')).toBe(false);
  });

  it('应用目录的组成：git 跟踪的源码、渲染、素材、依赖声明 + 前端构建产物', () => {
    expect(APP_ENTRIES).toEqual(['src', 'render', 'assets', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'LICENSE']);
    expect(BUILD_OUTPUTS).toEqual(['web/dist']);
  });

  it('trackedFiles 只列 git 跟踪的文件（未跟踪的草稿不进包）', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-git-'));
    const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    git('init', '-q');
    mkdirSync(join(dir, 'src', 'a'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a', '跟踪.ts'), 'x');
    writeFileSync(join(dir, 'LICENSE'), 'MIT');
    writeFileSync(join(dir, 'other.txt'), 'x');
    git('add', '.');
    writeFileSync(join(dir, 'src', 'draft.local.ts'), 'x');
    expect(trackedFiles(dir, ['src', 'LICENSE']).sort()).toEqual(['LICENSE', 'src/a/跟踪.ts']);
  });

  it('当前平台名与清单一致', () => {
    expect(['darwin-arm64', 'darwin-x64', 'win32-x64']).toContain(currentPlatform('darwin', 'arm64'));
    expect(currentPlatform('win32', 'x64')).toBe('win32-x64');
    expect(() => currentPlatform('linux', 'x64')).toThrow('不支持');
  });

  it('解压预算与启动器 install.rs 相同：max(压缩包×20, 512MB)', () => {
    expect(unpackBudget(10 * 1048576)).toBe(512 * 1048576);
    expect(unpackBudget(100 * 1048576)).toBe(2000 * 1048576);
  });
});

describe('collectEntries + writeTarZst', () => {
  function fixture(): string {
    const dir = mkdtempSync(join(tmpdir(), 'mz-bundle-'));
    mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'pkg', 'lib'), { recursive: true });
    mkdirSync(join(dir, 'src', '很长的中文目录名'), { recursive: true });
    writeFileSync(join(dir, 'node_modules', '.bin', 'tool'), 'x');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'lib', 'a.js'), 'module.exports = 1;\n');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'lib', 'a.js.map'), '{}');
    writeFileSync(join(dir, 'node_modules', 'pkg', 'run'), '#!/bin/sh\necho hi\n');
    chmodSync(join(dir, 'node_modules', 'pkg', 'run'), 0o755);
    const long = `${'x'.repeat(120)}.ts`;
    writeFileSync(join(dir, 'src', '很长的中文目录名', long), 'export const a = 1;\n');
    writeFileSync(join(dir, 'empty.txt'), '');
    return dir;
  }

  it('按剪枝规则收集文件与目录，路径用 /，按字典序', () => {
    const dir = fixture();
    const { entries, problems } = collectEntries(dir, 'darwin-arm64');
    expect(problems).toEqual([]);
    const paths = entries.map((e) => e.path);
    expect(paths).toContain('node_modules/pkg/lib/a.js');
    expect(paths).not.toContain('node_modules/pkg/lib/a.js.map');
    expect(paths.some((p) => p.includes('.bin'))).toBe(false);
    expect(paths).toEqual([...paths].sort());
  });

  it('符号链接视为问题（Windows 上启动器会跳过，pnpm 必须用 hoisted 布局）', () => {
    if (process.platform === 'win32') return;
    const dir = fixture();
    execFileSync('ln', ['-s', 'lib/a.js', join(dir, 'node_modules', 'pkg', 'link.js')]);
    const { problems } = collectEntries(dir, 'darwin-arm64');
    expect(problems).toEqual([{ path: 'node_modules/pkg/link.js', reason: expect.stringContaining('符号链接') }]);
  });

  it('写出的 tar.zst 能被系统 tar 解开：长路径、中文、空文件、可执行位都对', async () => {
    const dir = fixture();
    const { entries } = collectEntries(dir, 'darwin-arm64');
    const out = join(mkdtempSync(join(tmpdir(), 'mz-tar-')), 'app.tar.zst');
    const stats = await writeTarZst(dir, entries, out, { level: 3 });
    expect(stats.files).toBe(4);
    expect(stats.bytes).toBe(entries.filter((e) => e.type === 'file').reduce((n, e) => n + statSync(join(dir, e.path)).size, 0));
    const tar = join(dirname(out), 'app.tar');
    writeFileSync(tar, zstdDecompressSync(readFileSync(out)));
    const x = mkdtempSync(join(tmpdir(), 'mz-untar-'));
    execFileSync('tar', ['-xf', tar, '-C', x]);
    const long = `${'x'.repeat(120)}.ts`;
    expect(readFileSync(join(x, 'src', '很长的中文目录名', long), 'utf8')).toBe('export const a = 1;\n');
    expect(readFileSync(join(x, 'empty.txt'), 'utf8')).toBe('');
    if (process.platform !== 'win32') expect(statSync(join(x, 'node_modules', 'pkg', 'run')).mode & 0o111).not.toBe(0);
    expect(statSync(join(x, 'node_modules', 'pkg', 'lib', 'a.js')).mode & 0o777).toBe(0o644);
  });

  it('同样的输入产出逐字节相同的包（可复现）', async () => {
    const dir = fixture();
    const { entries } = collectEntries(dir, 'darwin-arm64');
    const a = join(mkdtempSync(join(tmpdir(), 'mz-tar-')), 'a.tar.zst');
    const b = join(mkdtempSync(join(tmpdir(), 'mz-tar-')), 'b.tar.zst');
    await writeTarZst(dir, entries, a, { level: 3 });
    await writeTarZst(dir, entries, b, { level: 3 });
    expect(readFileSync(a).equals(readFileSync(b))).toBe(true);
  });
});
