import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
const pkgVersion: string = JSON.parse(read('package.json')).version;

describe('启动器图标（scripts/make-icons.sh 的产物）', () => {
  it('AppIcon.icns：icns 魔数，长度字段与文件一致，含 16～512 及 @2x 各档', () => {
    const d = readFileSync(join(ROOT, 'launcher', 'macos', 'AppIcon.icns'));
    expect(d.subarray(0, 4).toString('ascii')).toBe('icns');
    expect(d.readUInt32BE(4)).toBe(d.length);
    const types: string[] = [];
    for (let off = 8; off < d.length; ) {
      types.push(d.subarray(off, off + 4).toString('ascii'));
      off += d.readUInt32BE(off + 4);
    }
    // ic07=128 ic08=256 ic09=512 ic10=1024(512@2x) ic11=32(16@2x) ic12=64(32@2x) ic13=256(128@2x) ic14=512(256@2x)
    for (const t of ['ic07', 'ic08', 'ic09', 'ic10', 'ic11', 'ic12', 'ic13', 'ic14']) expect(types).toContain(t);
  });

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
  it('Info.plist 模板：标识、中文名、版本占位、不设 LSUIElement（Dock 里要有图标）', () => {
    const p = read('launcher', 'macos', 'Info.plist');
    expect(p).toContain('<string>com.crawfordxx.mingzhi</string>');
    expect(p).toContain('<key>CFBundleName</key>\n  <string>明知AI剪辑</string>');
    expect(p).toContain('<string>mingzhi-launcher</string>');
    expect(p).toContain('<string>@VERSION@</string>');
    expect(p).not.toContain('<key>LSUIElement</key>');
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

  it('启动器是 GUI 子系统（双击不弹控制台）', () => {
    expect(read('launcher', 'src', 'main.rs')).toContain('#![cfg_attr(windows, windows_subsystem = "windows")]');
  });
});

describe('发布流水线对打包脚本与产物名的引用', () => {
  const wf = read('.github', 'workflows', 'release.yml');
  it('macOS 调 macos-sign.sh，Windows 产出 Mingzhi.exe，都带 sha256，Release 上传包含这些文件', () => {
    expect(wf).toContain('scripts/macos-sign.sh');
    expect(wf).toContain('out/Mingzhi.exe');
    expect(wf).toContain('sha256sum Mingzhi.exe > Mingzhi.exe.sha256');
    expect(wf).toContain('mingzhi-* Mingzhi* manifest.json');
    expect(wf).toContain('sha256sum -c');
  });

  it('签名相关 secrets 只在配齐时才传给脚本（缺失时走跳过分支，不让 CI 失败）', () => {
    for (const k of ['APPLE_SIGN_IDENTITY', 'APPLE_ID', 'APPLE_TEAM_ID', 'APPLE_APP_PASSWORD']) {
      expect(wf).toContain(`${k}: \${{ steps.sign.outputs.enabled == 'true' && secrets.${k} || '' }}`);
    }
  });
});
