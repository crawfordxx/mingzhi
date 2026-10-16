import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isLikelyBlank, screenshotUrl } from '../src/broll/screenshot.js';

const posixOnly = it.skipIf(process.platform === 'win32');

function fakeBrowser(script: string): { dir: string; fake: string } {
  const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
  const fake = join(dir, 'fake-browser.sh');
  writeFileSync(fake, `#!/bin/sh\n${script}\n`);
  chmodSync(fake, 0o755);
  return { dir, fake };
}

describe('screenshotUrl（真实无头浏览器，本地 file:// 页面）', () => {
  it('截出 1080×1350 PNG，输出目录不存在时自动创建', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
    const page = join(dir, 'p.html');
    writeFileSync(page, `<html><body style="margin:0;background:linear-gradient(#2f6fe0,#d4f23c)"><h1 style="font:80px sans-serif;padding:80px">明知 B-roll 截图测试</h1>${'<p style="font:40px sans-serif;padding:0 80px">段落内容</p>'.repeat(10)}</body></html>`);
    const out = join(dir, 'sub', 'p.png');
    await screenshotUrl(pathToFileURL(page).href, out, { allowFile: true });
    expect(isLikelyBlank(statSync(out).size)).toBe(false);
  }, 120_000);

  it('默认不允许 file://', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
    const out = join(dir, 'o.png');
    await expect(screenshotUrl('file:///etc/passwd', out, { browserPath: '/nonexistent' })).rejects.toThrow('http');
    expect(existsSync(out)).toBe(false);
  });
});

describe('screenshotUrl 网址校验（在启动浏览器之前拒绝）', () => {
  it.each([
    'javascript:alert(1)',
    'ftp://a.com/x',
    '--remote-debugging-port=9222',
    'http://localhost:3000/',
    'http://127.0.0.1/',
    'http://10.1.2.3/',
    'http://172.20.0.1/',
    'http://192.168.0.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://0.0.0.0/',
  ])('拒绝 %s', async (url) => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
    await expect(screenshotUrl(url, join(dir, 'o.png'), { browserPath: '/nonexistent' })).rejects.toThrow(/仅支持|内网|本机/);
  });
});

describe('screenshotUrl 子进程处理（假浏览器）', () => {
  posixOnly('超时会杀掉浏览器及其子进程并报错，不留输出文件', async () => {
    const { dir, fake } = fakeBrowser(`sleep 30 &\necho $! > "${'$(dirname "$0")'}/child.pid"\nwait`);
    const out = join(dir, 'o.png');
    // 超时给 6 秒：全量并行满载时假浏览器脚本可能要好几秒才启动并写出子进程号（超时先到就没有 pid 可查）
    await expect(screenshotUrl('https://example.com', out, { browserPath: fake, timeoutMs: 6000 })).rejects.toThrow('超时');
    expect(existsSync(out)).toBe(false);
    const childPid = Number(readFileSync(join(dir, 'child.pid'), 'utf8').trim());
    // 轮询等子进程退出（最多 10 秒），不用固定等待，避免高负载下误报
    const alive = (): boolean => { try { process.kill(childPid, 0); return true; } catch { return false; } };
    for (let i = 0; i < 100 && alive(); i += 1) await new Promise((r) => setTimeout(r, 100));
    expect(alive()).toBe(false);
  }, 30_000);

  posixOnly('hideImages：不加载图片（只截页面与标题区，不截新闻配图本体）', async () => {
    const { dir, fake } = fakeBrowser(`echo "$@" > "$(dirname "$0")/args.txt"\nexit 0`);
    await expect(screenshotUrl('https://example.com', join(dir, 'o.png'), { browserPath: fake, hideImages: true })).rejects.toThrow('空白');
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).toContain('--blink-settings=imagesEnabled=false');
    await expect(screenshotUrl('https://example.com', join(dir, 'p.png'), { browserPath: fake })).rejects.toThrow('空白');
    expect(readFileSync(join(dir, 'args.txt'), 'utf8')).not.toContain('imagesEnabled');
  });

  posixOnly('浏览器没产出图片时报错（空白/被拦截）', async () => {
    const { dir, fake } = fakeBrowser('exit 0');
    const out = join(dir, 'o.png');
    await expect(screenshotUrl('https://example.com', out, { browserPath: fake })).rejects.toThrow('空白');
    expect(existsSync(out)).toBe(false);
  });

  posixOnly('被信号杀掉时报信号名而不是退出码 null', async () => {
    const { dir, fake } = fakeBrowser('kill -TERM $$');
    await expect(screenshotUrl('https://example.com', join(dir, 'o.png'), { browserPath: fake })).rejects.toThrow('SIGTERM');
  });

  posixOnly('浏览器异常退出时错误里带 stderr 末尾', async () => {
    const { dir, fake } = fakeBrowser('echo boom-stderr >&2\nexit 3');
    await expect(screenshotUrl('https://example.com', join(dir, 'o.png'), { browserPath: fake })).rejects.toThrow('boom-stderr');
  });
});
