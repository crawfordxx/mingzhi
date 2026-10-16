import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'macos-sign.sh');
const APP_NAME = '明知AI剪辑.app';

// 脚本只在 macOS 上有意义（ditto / plutil / codesign）
const mac = process.platform === 'darwin';

let work: string;
let fakeBin: string;
let log: string;
let launcher: string;

/** 假的 codesign / xcrun：只记录参数，xcrun notarytool 按 FAKE_NOTARY_STATUS 回 JSON。 */
function installStubs(dir: string) {
  mkdirSync(dir, { recursive: true });
  const stub = (name: string, body: string) => {
    writeFileSync(join(dir, name), `#!/bin/bash\n${body}\n`);
    chmodSync(join(dir, name), 0o755);
  };
  stub('codesign', 'echo "codesign $*" >> "$STUB_LOG"; exit 0');
  stub(
    'xcrun',
    `echo "xcrun $*" >> "$STUB_LOG"
if [[ "$1" == notarytool && "$2" == submit ]]; then
  echo "{\\"id\\":\\"0000-test\\",\\"status\\":\\"\${FAKE_NOTARY_STATUS:-Accepted}\\",\\"message\\":\\"x\\"}"
fi
if [[ "$1" == notarytool && "$2" == log ]]; then echo "公证日志：某某问题"; fi
exit 0`,
  );
}

function run(args: string[], env: Record<string, string> = {}, opts: { stubs?: boolean } = {}) {
  const out = join(work, `out-${Math.random().toString(36).slice(2)}`);
  const base: Record<string, string> = {
    PATH: `${opts.stubs ? fakeBin + ':' : ''}/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: work,
    TMPDIR: work + '/',
    STUB_LOG: log,
    LANG: 'zh_CN.UTF-8',
  };
  const full = args.includes('--out') ? args : [...args, '--out', out];
  const r = spawnSync('/bin/bash', [SCRIPT, ...full], { env: { ...base, ...env }, encoding: 'utf8' });
  return { ...r, out: args.includes('--out') ? args[args.indexOf('--out') + 1] : out, text: `${r.stdout}\n${r.stderr}` };
}

const baseArgs = () => ['--bin', launcher, '--version', '0.1.0', '--arch', 'arm64'];
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const FULL = {
  APPLE_SIGN_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
  APPLE_ID: 'dev@example.com',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
};

describe.skipIf(!mac)('scripts/macos-sign.sh', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'mz-sign-'));
    fakeBin = join(work, 'stubs');
    installStubs(fakeBin);
    log = join(work, 'calls.log');
    // 用系统自带的 Mach-O 程序充当启动器二进制，这样真实 codesign 也能签
    launcher = join(work, 'mingzhi-launcher');
    copyFileSync('/bin/echo', launcher);
    chmodSync(launcher, 0o755);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('缺参数、版本号格式不对时退出码 2，并给出中文用法', () => {
    const noArgs = run([]);
    expect(noArgs.status).toBe(2);
    expect(noArgs.text).toContain('用法');
    const badVer = run(['--bin', launcher, '--version', 'abc', '--arch', 'arm64']);
    expect(badVer.status).toBe(2);
    expect(badVer.text).toContain('版本号');
    const badArch = run(['--bin', launcher, '--version', '0.1.0', '--arch', 'ppc']);
    expect(badArch.status).toBe(2);
    const noBin = run(['--bin', join(work, 'nope'), '--version', '0.1.0', '--arch', 'arm64']);
    expect(noBin.status).toBe(2);
    expect(noBin.text).toContain('找不到');
  });

  describe('没有任何签名环境变量（CI 上没配 secrets）', () => {
    it('打印中文说明、退出码 0，仍产出 zip 与 sha256（ad-hoc 签名，真实 codesign 校验通过）', () => {
      const r = run(baseArgs());
      expect(r.status, r.text).toBe(0);
      expect(r.text).toContain('跳过');
      expect(r.text).toContain('APPLE_SIGN_IDENTITY');
      const zip = join(r.out, 'Mingzhi-macos-arm64.zip');
      expect(existsSync(zip)).toBe(true);
      const sha = readFileSync(`${zip}.sha256`, 'utf8');
      const expected = execFileSync('/usr/bin/shasum', ['-a', '256', zip], { encoding: 'utf8' }).split(/\s+/)[0];
      expect(sha).toBe(`${expected}  Mingzhi-macos-arm64.zip\n`);

      // 解开后是 .app，可执行位还在，Info.plist 版本与标识正确
      const dir = mkdtempSync(join(work, 'x-'));
      execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dir]);
      const app = join(dir, APP_NAME);
      const exe = join(app, 'Contents', 'MacOS', 'mingzhi-launcher');
      expect(statSync(exe).mode & 0o111).toBe(0o111);
      const plist = join(app, 'Contents', 'Info.plist');
      const get = (k: string) => execFileSync('/usr/bin/plutil', ['-extract', k, 'raw', '-o', '-', plist], { encoding: 'utf8' }).trim();
      expect(get('CFBundleIdentifier')).toBe('com.crawfordxx.mingzhi');
      expect(get('CFBundleShortVersionString')).toBe('0.1.0');
      expect(get('CFBundleName')).toBe('明知AI剪辑');
      expect(existsSync(join(app, 'Contents', 'Resources', 'AppIcon.icns'))).toBe(true);
      expect(readFileSync(plist, 'utf8')).not.toContain('@VERSION@');
      // zip 里没有 AppleDouble（._ 开头）杂项
      const names = execFileSync('/usr/bin/zipinfo', ['-1', zip], { encoding: 'utf8' });
      expect(names).not.toMatch(/(^|\/)\._/m);
      const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', app], { encoding: 'utf8' });
      expect(verify.status, verify.stderr).toBe(0);
    });

    it('--help 不触发任何构建', () => {
      const r = run(['--help'], {}, { stubs: true });
      expect(r.status).toBe(0);
      expect(r.text).toContain('用法');
    });
  });

  describe('有 Developer ID 身份', () => {
    it('身份在、公证凭据不全：签名（hardened runtime + 时间戳 + entitlements），说明缺哪几项，不调 notarytool', () => {
      writeFileSync(log, '');
      const r = run(baseArgs(), { APPLE_SIGN_IDENTITY: FULL.APPLE_SIGN_IDENTITY, APPLE_ID: FULL.APPLE_ID }, { stubs: true });
      expect(r.status, r.text).toBe(0);
      expect(r.text).toContain('APPLE_TEAM_ID');
      expect(r.text).toContain('APPLE_APP_PASSWORD');
      expect(r.text).toContain('未公证');
      const c = calls();
      const sign = c.find((l) => l.startsWith('codesign') && l.includes('--sign'));
      expect(sign).toContain('--force');
      expect(sign).toContain('--options runtime');
      expect(sign).toContain('--timestamp');
      expect(sign).toContain(`--entitlements ${join(ROOT, 'launcher', 'macos', 'entitlements.plist')}`);
      expect(sign).toContain(`--sign ${FULL.APPLE_SIGN_IDENTITY}`);
      expect(sign!.endsWith(APP_NAME)).toBe(true);
      expect(c.some((l) => l.includes('notarytool'))).toBe(false);
      expect(existsSync(join(r.out, 'Mingzhi-macos-arm64.zip.sha256'))).toBe(true);
    });

    it('四个变量齐全：签名 → 校验 → 提交公证并等待 → 钉合 → 再打包，顺序固定，密码不出现在输出里', () => {
      writeFileSync(log, '');
      const r = run(baseArgs(), FULL, { stubs: true });
      expect(r.status, r.text).toBe(0);
      const c = calls();
      const idx = (re: RegExp) => c.findIndex((l) => re.test(l));
      const iSign = idx(/^codesign .*--sign/);
      const iVerify = idx(/^codesign .*--verify/);
      const iSubmit = idx(/^xcrun notarytool submit /);
      const iStaple = idx(/^xcrun stapler staple /);
      const iValidate = idx(/^xcrun stapler validate /);
      expect([iSign, iVerify, iSubmit, iStaple, iValidate].every((i) => i >= 0)).toBe(true);
      expect(iSign).toBeLessThan(iVerify);
      expect(iVerify).toBeLessThan(iSubmit);
      expect(iSubmit).toBeLessThan(iStaple);
      expect(iStaple).toBeLessThan(iValidate);
      const submit = c[iSubmit];
      expect(submit).toContain('--wait');
      expect(submit).toContain('--apple-id dev@example.com');
      expect(submit).toContain('--team-id TEAM123456');
      expect(submit).toContain('--password abcd-efgh-ijkl-mnop');
      expect(submit).toContain('--output-format json');
      expect(c[iStaple].endsWith(APP_NAME)).toBe(true);
      expect(r.text).not.toContain(FULL.APPLE_APP_PASSWORD);
      expect(r.text).toContain('公证通过');
    });

    it('MINGZHI_NOTARY_PROFILE 优先：用 --keychain-profile，不传密码', () => {
      writeFileSync(log, '');
      const r = run(
        baseArgs(),
        { APPLE_SIGN_IDENTITY: FULL.APPLE_SIGN_IDENTITY, MINGZHI_NOTARY_PROFILE: 'mingzhi-notary', APPLE_APP_PASSWORD: 'zzz' },
        { stubs: true },
      );
      expect(r.status, r.text).toBe(0);
      const submit = calls().find((l) => l.startsWith('xcrun notarytool submit'));
      expect(submit).toContain('--keychain-profile mingzhi-notary');
      expect(submit).not.toContain('--password');
      expect(submit).not.toContain('--apple-id');
    });

    it('--sign-only：凭据齐全也不公证（本机演练用）', () => {
      writeFileSync(log, '');
      const r = run([...baseArgs(), '--sign-only'], FULL, { stubs: true });
      expect(r.status, r.text).toBe(0);
      expect(calls().some((l) => l.includes('notarytool') || l.includes('stapler'))).toBe(false);
      expect(r.text).toContain('仅签名');
    });

    it('公证被拒（status 不是 Accepted）：取日志、退出码非 0、不钉合、不产出 zip', () => {
      writeFileSync(log, '');
      const r = run(baseArgs(), { ...FULL, FAKE_NOTARY_STATUS: 'Invalid' }, { stubs: true });
      expect(r.status).toBe(1);
      expect(r.text).toContain('公证失败');
      expect(r.text).toContain('公证日志：某某问题');
      const c = calls();
      expect(c.some((l) => l.startsWith('xcrun notarytool log 0000-test'))).toBe(true);
      expect(c.some((l) => l.includes('stapler'))).toBe(false);
      expect(existsSync(join(r.out, 'Mingzhi-macos-arm64.zip'))).toBe(false);
    });
  });
});
