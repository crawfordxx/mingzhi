import { describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdtempSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isLikelyBlank, screenshotUrl } from '../src/broll/screenshot.js';

describe('screenshotUrl（真实无头浏览器，本地 file:// 页面）', () => {
  it('截出 1080×1350 PNG', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
    const page = join(dir, 'p.html');
    writeFileSync(page, `<html><body style="margin:0;background:linear-gradient(#2f6fe0,#d4f23c)"><h1 style="font:80px sans-serif;padding:80px">明知 B-roll 截图测试</h1>${'<p style="font:40px sans-serif;padding:0 80px">段落内容</p>'.repeat(10)}</body></html>`);
    const out = join(dir, 'p.png');
    await screenshotUrl(`file://${page}`, out);
    expect(isLikelyBlank(statSync(out).size)).toBe(false);
  }, 120_000);

  it('超时会杀掉浏览器进程并报错，不留输出文件', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
    const fake = join(dir, 'fake-browser.sh');
    writeFileSync(fake, '#!/bin/sh\nsleep 30\n');
    chmodSync(fake, 0o755);
    const out = join(dir, 'o.png');
    await expect(screenshotUrl('https://example.com', out, { browserPath: fake, timeoutMs: 300 })).rejects.toThrow('超时');
    expect(existsSync(out)).toBe(false);
  });

  it('浏览器没产出图片时报错（空白/被拦截）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-shot-'));
    const fake = join(dir, 'fake-browser.sh');
    writeFileSync(fake, '#!/bin/sh\nexit 0\n');
    chmodSync(fake, 0o755);
    const out = join(dir, 'o.png');
    await expect(screenshotUrl('https://example.com', out, { browserPath: fake })).rejects.toThrow('空白');
    expect(existsSync(out)).toBe(false);
  });
});
