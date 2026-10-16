import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const SCRIPT = join(ROOT, 'scripts', 'macos-sign.sh');
const DIR_NAME = '明知AI剪辑';
const COMMAND_NAME = '明知AI剪辑.command';
const ZIP_NAME = 'Mingzhi-macos.zip';

// 脚本只在 macOS 上有意义（ditto / lipo / codesign）
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
  echo "Conducting pre-submission checks..." >&2
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

const baseArgs = () => ['--bin', launcher];
const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : []);
const FULL = {
  APPLE_SIGN_IDENTITY: 'Developer ID Application: Test (TEAM123456)',
  APPLE_ID: 'dev@example.com',
  APPLE_TEAM_ID: 'TEAM123456',
  APPLE_APP_PASSWORD: 'abcd-efgh-ijkl-mnop',
};

function unzip(zip: string) {
  const dir = mkdtempSync(join(work, 'x-'));
  execFileSync('/usr/bin/ditto', ['-x', '-k', zip, dir]);
  return join(dir, DIR_NAME);
}

describe.skipIf(!mac)('scripts/macos-sign.sh', () => {
  beforeAll(() => {
    work = mkdtempSync(join(tmpdir(), 'mz-sign-'));
    fakeBin = join(work, 'stubs');
    installStubs(fakeBin);
    log = join(work, 'calls.log');
    // 用系统自带的 Mach-O 程序充当启动器二进制，这样真实 codesign / lipo 也能处理
    launcher = join(work, 'mingzhi-launcher');
    copyFileSync('/bin/echo', launcher);
    chmodSync(launcher, 0o755);
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it('缺参数、二进制不存在、给了三个二进制时退出码 2，并给出中文用法', () => {
    const noArgs = run([]);
    expect(noArgs.status).toBe(2);
    expect(noArgs.text).toContain('用法');
    const noBin = run(['--bin', join(work, 'nope')]);
    expect(noBin.status).toBe(2);
    expect(noBin.text).toContain('找不到');
    const three = run(['--bin', launcher, '--bin', launcher, '--bin', launcher]);
    expect(three.status).toBe(2);
    expect(three.text).toContain('最多');
    expect(run(['--bogus']).status).toBe(2);
  });

  it('--help 退出码 0，不触发任何构建', () => {
    const r = run(['--help'], {}, { stubs: true });
    expect(r.status).toBe(0);
    expect(r.text).toContain('用法');
    expect(existsSync(log) ? readFileSync(log, 'utf8') : '').toBe('');
  });

  describe('没有任何签名环境变量（CI 上没配 secrets）', () => {
    it('打印中文说明、退出码 0，仍产出 zip 与 sha256；zip 里是 .command 与启动器，可执行位在，ad-hoc 验签通过', () => {
      const r = run(baseArgs());
      expect(r.status, r.text).toBe(0);
      expect(r.text).toContain('跳过');
      expect(r.text).toContain('APPLE_SIGN_IDENTITY');
      const zip = join(r.out, ZIP_NAME);
      expect(existsSync(zip)).toBe(true);
      const sha = readFileSync(`${zip}.sha256`, 'utf8');
      const expected = execFileSync('/usr/bin/shasum', ['-a', '256', zip], { encoding: 'utf8' }).split(/\s+/)[0];
      expect(sha).toBe(`${expected}  ${ZIP_NAME}\n`);

      const dir = unzip(zip);
      for (const f of [COMMAND_NAME, 'mingzhi-launcher']) expect(statSync(join(dir, f)).mode & 0o111, f).toBe(0o111);
      // 不再有 .app 相关内容
      const names = execFileSync('/usr/bin/zipinfo', ['-1', zip], { encoding: 'utf8' });
      expect(names).not.toMatch(/\.app|Info\.plist|\.icns/);
      expect(names).not.toMatch(/(^|\/)\._/m);
      const verify = spawnSync('/usr/bin/codesign', ['--verify', '--strict', join(dir, 'mingzhi-launcher')], { encoding: 'utf8' });
      expect(verify.status, verify.stderr).toBe(0);
    });

    it('.command 里写入了 zip 内启动器的 sha256（没有残留占位符）', () => {
      const r = run(baseArgs());
      const dir = unzip(join(r.out, ZIP_NAME));
      const cmd = readFileSync(join(dir, COMMAND_NAME), 'utf8');
      const sha = execFileSync('/usr/bin/shasum', ['-a', '256', join(dir, 'mingzhi-launcher')], { encoding: 'utf8' }).split(/\s+/)[0];
      expect(cmd).toContain(`EXPECTED_SHA256="${sha}"`);
      expect(cmd).not.toContain('@LAUNCHER_SHA256@');
    });

    describe('.command 的运行行为（把启动器换成假脚本，从别的目录运行）', () => {
      const QUARANTINE = 'com.apple.quarantine';
      const hasQuarantine = (f: string) => spawnSync('/usr/bin/xattr', ['-p', QUARANTINE, f]).status === 0;
      const quarantine = (f: string) => execFileSync('/usr/bin/xattr', ['-w', QUARANTINE, '0081;00000000;Safari;', f]);
      const real = (p: string) => execFileSync('/bin/realpath', [p], { encoding: 'utf8' }).trim();

      /** 解开 zip，把启动器换成会汇报 cwd 的假脚本，并把新的 sha 写回 .command（模拟「发布时就是这个文件」）。 */
      function prepare() {
        const r = run(baseArgs());
        const dir = unzip(join(r.out, ZIP_NAME));
        const marker = join(work, `cwd-${Math.random().toString(36).slice(2)}.txt`);
        const fake = join(dir, 'mingzhi-launcher');
        writeFileSync(fake, `#!/bin/bash\npwd > "${marker}"\nexit 7\n`);
        chmodSync(fake, 0o755);
        const sha = execFileSync('/usr/bin/shasum', ['-a', '256', fake], { encoding: 'utf8' }).split(/\s+/)[0];
        const cmdPath = join(dir, COMMAND_NAME);
        writeFileSync(cmdPath, readFileSync(cmdPath, 'utf8').replace(/EXPECTED_SHA256="[0-9a-f]+"/, `EXPECTED_SHA256="${sha}"`));
        return { dir, marker, fake, cmdPath };
      }
      const exec = (cmdPath: string) =>
        spawnSync('/bin/bash', [cmdPath], { cwd: mkdtempSync(join(work, 'cwd-')), encoding: 'utf8' });

      it('提示语、切到自己所在目录运行启动器、退出后提示可关窗口，并把启动器退出码带回', () => {
        const { dir, marker, cmdPath } = prepare();
        const ran = exec(cmdPath);
        expect(ran.status).toBe(7);
        expect(ran.stdout).toContain('明知AI剪辑正在启动，浏览器会自动打开；关闭这个窗口即可退出');
        expect(ran.stdout).toContain('已退出，可以关闭这个窗口');
        expect(real(readFileSync(marker, 'utf8').trim())).toBe(real(dir));
      });

      it('校验通过后只清启动器与脚本自身的隔离标记，同文件夹（含子目录）里别的文件不碰', () => {
        const { dir, fake, cmdPath } = prepare();
        const other = join(dir, 'other.dmg');
        mkdirSync(join(dir, 'sub'));
        const nested = join(dir, 'sub', 'other2.pkg');
        writeFileSync(other, 'x');
        writeFileSync(nested, 'y');
        for (const f of [fake, cmdPath, other, nested]) quarantine(f);
        exec(cmdPath);
        expect(hasQuarantine(fake)).toBe(false);
        expect(hasQuarantine(cmdPath)).toBe(false);
        expect(hasQuarantine(other)).toBe(true);
        expect(hasQuarantine(nested)).toBe(true);
      });

      it('启动器被替换（sha256 对不上）：提示并退出，不清标记、不运行', () => {
        const { fake, cmdPath, marker } = prepare();
        writeFileSync(fake, `#!/bin/bash\npwd > "${marker}"\nexit 9\n# 被改过\n`);
        quarantine(fake);
        const ran = exec(cmdPath);
        expect(ran.status).toBe(1);
        expect(ran.stdout).toContain('校验和不一致');
        expect(hasQuarantine(fake)).toBe(true);
        expect(existsSync(marker)).toBe(false);
      });

      it('启动器不在旁边（.command 被单独移走）：提示「请把整个文件夹解压后再双击」，退出码 1，不动别的文件', () => {
        const { dir, cmdPath } = prepare();
        const lone = mkdtempSync(join(work, 'lone-'));
        const moved = join(lone, COMMAND_NAME);
        copyFileSync(cmdPath, moved);
        const bystander = join(lone, 'bystander.dmg');
        writeFileSync(bystander, 'z');
        quarantine(bystander);
        const ran = exec(moved);
        expect(ran.status).toBe(1);
        expect(ran.stdout).toContain('请把整个「明知AI剪辑」文件夹解压后再双击');
        expect(hasQuarantine(bystander)).toBe(true);
        expect(existsSync(join(dir, 'mingzhi-launcher'))).toBe(true);
      });
    });

    it('给两个二进制时用 lipo 合成通用二进制（两个架构都在）', () => {
      const x64 = join(work, 'launcher-x64');
      const arm = join(work, 'launcher-arm');
      execFileSync('/usr/bin/lipo', ['/bin/echo', '-thin', 'x86_64', '-output', x64]);
      execFileSync('/usr/bin/lipo', ['/bin/echo', '-thin', 'arm64e', '-output', arm]);
      const r = run(['--bin', arm, '--bin', x64]);
      expect(r.status, r.text).toBe(0);
      const dir = unzip(join(r.out, ZIP_NAME));
      const archs = execFileSync('/usr/bin/lipo', ['-archs', join(dir, 'mingzhi-launcher')], { encoding: 'utf8' });
      expect(archs).toContain('x86_64');
      expect(archs).toContain('arm64e');
    });
  });

  describe('有 Developer ID 身份', () => {
    it('身份在、公证凭据不全：只签名启动器二进制（hardened runtime + 时间戳 + entitlements），说明缺哪几项，不调 notarytool', () => {
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
      expect(sign!.endsWith('mingzhi-launcher')).toBe(true);
      // .command 是脚本，不签名；codesign 只碰二进制
      expect(c.every((l) => !l.includes('.command'))).toBe(true);
      expect(c.some((l) => l.includes('notarytool'))).toBe(false);
      expect(existsSync(join(r.out, `${ZIP_NAME}.sha256`))).toBe(true);
    });

    it('四个变量齐全：签名 → 校验 → 提交 zip 公证并等待，顺序固定；不调 stapler（zip 与裸二进制无法钉合）；密码不出现在输出里', () => {
      writeFileSync(log, '');
      const r = run(baseArgs(), FULL, { stubs: true });
      expect(r.status, r.text).toBe(0);
      const c = calls();
      const idx = (re: RegExp) => c.findIndex((l) => re.test(l));
      const iSign = idx(/^codesign .*--sign/);
      const iVerify = idx(/^codesign .*--verify/);
      const iSubmit = idx(/^xcrun notarytool submit /);
      expect([iSign, iVerify, iSubmit].every((i) => i >= 0)).toBe(true);
      expect(iSign).toBeLessThan(iVerify);
      expect(iVerify).toBeLessThan(iSubmit);
      const submit = c[iSubmit];
      expect(submit).toMatch(/submit \S+\.zip /);
      expect(submit).toContain('--wait');
      expect(submit).toContain('--timeout 30m');
      expect(submit).toContain('--apple-id dev@example.com');
      expect(submit).toContain('--team-id TEAM123456');
      expect(submit).toContain('--password abcd-efgh-ijkl-mnop');
      expect(submit).toContain('--output-format json');
      expect(c.some((l) => l.includes('stapler'))).toBe(false);
      expect(r.text).not.toContain(FULL.APPLE_APP_PASSWORD);
      expect(r.text).toContain('公证通过');
      expect(existsSync(join(r.out, ZIP_NAME))).toBe(true);
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

    it('--sign-only：凭据齐全也不公证（本机用 Apple Development 证书演练时用）', () => {
      writeFileSync(log, '');
      const r = run([...baseArgs(), '--sign-only'], FULL, { stubs: true });
      expect(r.status, r.text).toBe(0);
      expect(calls().some((l) => l.includes('notarytool'))).toBe(false);
      expect(r.text).toContain('仅签名');
    });

    it('公证被拒（status 不是 Accepted）：取日志、退出码非 0、不产出 zip', () => {
      writeFileSync(log, '');
      const r = run(baseArgs(), { ...FULL, FAKE_NOTARY_STATUS: 'Invalid' }, { stubs: true });
      expect(r.status).toBe(1);
      expect(r.text).toContain('公证失败');
      expect(r.text).toContain('公证日志：某某问题');
      expect(calls().some((l) => l.startsWith('xcrun notarytool log 0000-test'))).toBe(true);
      expect(existsSync(join(r.out, ZIP_NAME))).toBe(false);
    });
  });
});
