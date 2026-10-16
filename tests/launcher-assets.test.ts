import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const pkgVersion: string = JSON.parse(read('package.json')).version;

describe('Windows 启动器图标（scripts/make-icons.sh 的产物）', () => {
  it('mingzhi.ico：16/24/32/48/64/128/256 七档，每档都是合法 PNG', () => {
    const d = readFileSync(join(ROOT, 'launcher', 'windows', 'mingzhi.ico'));
    expect(d.readUInt16LE(0)).toBe(0);
    expect(d.readUInt16LE(2)).toBe(1);
    const count = d.readUInt16LE(4);
    const sizes: number[] = [];
    for (let i = 0; i < count; i++) {
      const e = 6 + 16 * i;
      const w = d[e] || 256;
      sizes.push(w);
      const len = d.readUInt32LE(e + 8);
      const off = d.readUInt32LE(e + 12);
      expect(d.subarray(off, off + 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(d.readUInt32BE(off + 16)).toBe(w);
      expect(off + len).toBeLessThanOrEqual(d.length);
    }
    expect(sizes).toEqual([16, 24, 32, 48, 64, 128, 256]);
  });
});

describe('macOS 打包资源', () => {
  it('没有 .app 相关文件（Info.plist、图标）：macOS 只发 .command + 命令行二进制', () => {
    expect(existsSync(join(ROOT, 'launcher', 'macos', 'Info.plist'))).toBe(false);
    expect(existsSync(join(ROOT, 'launcher', 'macos', 'AppIcon.icns'))).toBe(false);
  });

  it('start.command：可执行、切到自身目录、前台运行启动器、打印中文说明、清隔离标记', () => {
    const path = join(ROOT, 'launcher', 'macos', 'start.command');
    expect(statSync(path).mode & 0o111).toBe(0o111);
    const c = readFileSync(path, 'utf8');
    expect(c.startsWith('#!/bin/bash')).toBe(true);
    expect(c).toContain('cd -- "$(dirname -- "$0")"');
    expect(c).toContain('明知AI剪辑正在启动，浏览器会自动打开；关闭这个窗口即可退出。');
    expect(c).toContain('./mingzhi-launcher');
    // 只清启动器与自身，不递归
    expect(c).not.toMatch(/xattr -[a-z]*r/);
    expect(c).toContain('EXPECTED_SHA256="@LAUNCHER_SHA256@"');
  });

  it('start.command：交接退出码与启动器的 HANDOFF_EXIT_CODE 一致，交接时不显示「已退出」', () => {
    const code = /pub const HANDOFF_EXIT_CODE: u8 = (\d+);/.exec(read('launcher', 'src', 'instance.rs'))?.[1];
    expect(code).toBeDefined();
    const c = read('launcher', 'macos', 'start.command');
    expect(c).toContain(`if [ "$code" -eq ${code} ]; then`);
    // 交接分支在打印「已退出」之前就退出
    expect(c.indexOf(`-eq ${code}`)).toBeLessThan(c.indexOf('明知AI剪辑已退出'));
    expect(read('launcher', 'src', 'instance.rs')).toContain('明知AI剪辑已在运行，已为你打开浏览器；这个窗口可以关闭。');
  });

  it('entitlements 为空：启动器不需要任何 hardened runtime 豁免', () => {
    expect(read('launcher', 'macos', 'entitlements.plist')).toContain('<dict/>');
  });
});

describe('Windows 资源与构建', () => {
  const rc = read('launcher', 'windows', 'mingzhi.rc');

  it('mingzhi.rc：UTF-8 代码页、图标、版本信息、产品名与原始文件名', () => {
    expect(rc).toContain('#pragma code_page(65001)');
    expect(rc).toMatch(/^1\s+ICON\s+"mingzhi\.ico"/m);
    expect(rc).toContain('VS_VERSION_INFO VERSIONINFO');
    expect(rc).toContain('VALUE "ProductName", "明知AI剪辑"');
    expect(rc).toContain('VALUE "OriginalFilename", "Mingzhi.exe"');
    // 简体中文 + Unicode 代码页
    expect(rc).toContain('"080404B0"');
    expect(rc).toContain('VALUE "Translation", 0x0804, 0x04B0');
  });

  it('mingzhi.rc 的版本号与 package.json、launcher/Cargo.toml 一致（改版本时三处一起改）', () => {
    const [a, b, c] = pkgVersion.split('.');
    const cargo = /^version = "(.+)"$/m.exec(read('launcher', 'Cargo.toml'))?.[1];
    expect(cargo).toBe(pkgVersion);
    expect(rc).toContain(`FILEVERSION ${a},${b},${c},0`);
    expect(rc).toContain(`PRODUCTVERSION ${a},${b},${c},0`);
    expect(rc).toContain(`VALUE "FileVersion", "${pkgVersion}"`);
    expect(rc).toContain(`VALUE "ProductVersion", "${pkgVersion}"`);
  });

  it('build.rs 只在 windows 目标嵌入资源，embed-resource 版本钉死', () => {
    const b = read('launcher', 'build.rs');
    expect(b).toContain('CARGO_CFG_TARGET_OS');
    expect(b).toContain('windows/mingzhi.rc');
    expect(b).toContain('rerun-if-changed=windows');
    expect(read('launcher', 'Cargo.toml')).toMatch(/^embed-resource = "=\d+\.\d+\.\d+"$/m);
  });

  it('启动器是控制台子系统：双击 Mingzhi.exe 会有控制台窗口，关闭窗口即退出（不能再声明 windows_subsystem）', () => {
    const main = read('launcher', 'src', 'main.rs');
    expect(main).not.toMatch(/^\s*#!\[.*windows_subsystem/m);
    // 控制台里显示的启动说明（macOS 的 .command 自己打印同一句）
    expect(main).toContain('明知AI剪辑正在启动，浏览器会自动打开；关闭这个窗口即可退出。');
    // 关闭窗口 / Ctrl+C 走 signal 模块优雅退出
    expect(main).toContain('signal::install()');
    expect(read('launcher', 'src', 'signal.rs')).toContain('SetConsoleCtrlHandler');
  });
});

describe('发布流水线对打包脚本与产物名的引用', () => {
  const wf = read('.github', 'workflows', 'release.yml');
  it('macOS 单独一个 job：下载两个架构的启动器，调 macos-sign.sh 合成通用二进制；Windows 产出 Mingzhi.exe；都带 sha256', () => {
    expect(wf).toContain('package-macos:');
    expect(wf).toMatch(/macos-sign\.sh[\s\S]*--bin .*darwin-arm64[\s\S]*--bin .*darwin-x64/);
    expect(wf).toContain('out/Mingzhi.exe');
    expect(wf).toContain('sha256sum Mingzhi.exe > Mingzhi.exe.sha256');
    expect(wf).toContain('sha256sum -c');
    expect(wf).toContain('Mingzhi-macos.zip');
    expect(wf).not.toContain('.app');
  });

  it('Release 附带第三方许可声明 THIRD_PARTY_NOTICES.md（由 scripts/third-party-notices.mjs 生成）', () => {
    expect(wf).toContain('node scripts/third-party-notices.mjs --out out/THIRD_PARTY_NOTICES.md');
    expect(wf.match(/manifest\.json THIRD_PARTY_NOTICES\.md/g)?.length).toBe(2); // 新建与补传两条路径
  });

  it('签名相关 secrets 只在配齐时才传给脚本（缺失时走跳过分支，不让 CI 失败）', () => {
    for (const k of ['APPLE_SIGN_IDENTITY', 'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD']) {
      expect(wf).toContain(`${k}: \${{ steps.sign.outputs.enabled == 'true' && secrets.${k} || '' }}`);
    }
  });

  it('Release 上传包含新产物名，且中间产物（原始启动器二进制）不会被当成发布文件', () => {
    expect(wf).toContain('mingzhi-* Mingzhi* manifest.json');
    expect(wf).toContain('name: launcher-bin-');
  });
});
