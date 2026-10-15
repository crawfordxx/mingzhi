#!/usr/bin/env node
// 用 GitHub 的渲染接口把 README 转成 HTML，套 github-markdown-css，按仓库首页的版心宽度截全页长图（浅色 + 深色）。
// 用法：node scripts/readme/gh-preview.mjs <README.md> <输出目录> <github-markdown-css 所在目录>
// css 目录里需要 gh-light.css、gh-dark.css（cdnjs 的 github-markdown-css 5.8.1）。
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const [mdPath, outDir, cssDir] = process.argv.slice(2);
if (!mdPath || !outDir || !cssDir) {
  console.error('用法：node scripts/readme/gh-preview.mjs <README.md> <输出目录> <css 目录>');
  process.exit(1);
}
mkdirSync(outDir, { recursive: true });

const md = readFileSync(mdPath, 'utf8');
const body = execFileSync('gh', ['api', 'markdown', '-f', `text=${md}`, '-f', 'mode=gfm', '-f', 'context=crawfordxx/mingzhi'], { encoding: 'utf8', maxBuffer: 32 << 20 });
const base = pathToFileURL(resolve(dirname(mdPath)) + '/').href;
const name = basename(mdPath, '.md');

// 仓库首页 1280 宽时 README 框约 896 宽、内边距 32（实测 github.com 的 Box-body px-5）
const page = (theme) => `<!doctype html><html><head><meta charset="utf-8"><base href="${base}">
<style>${readFileSync(resolve(cssDir, `gh-${theme}.css`), 'utf8')}</style>
<style>
  body { margin: 0; background: ${theme === 'dark' ? '#0d1117' : '#ffffff'}; }
  .box { width: 896px; margin: 24px auto; border: 1px solid ${theme === 'dark' ? '#3d444d' : '#d1d9e0'}; border-radius: 6px; }
  .box > header { padding: 8px 16px; border-bottom: 1px solid ${theme === 'dark' ? '#3d444d' : '#d1d9e0'}; font: 600 14px -apple-system, sans-serif; color: ${theme === 'dark' ? '#f0f6fc' : '#1f2328'}; }
  .markdown-body { padding: 32px; }
</style></head><body><div class="box"><header>README</header><article class="markdown-body">${body}</article></div></body></html>`;

const browser = await chromium.launch();
for (const theme of ['light', 'dark']) {
  const html = resolve(outDir, `${name}-${theme}.html`);
  writeFileSync(html, page(theme));
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1, colorScheme: theme });
  const p = await ctx.newPage();
  await p.goto(pathToFileURL(html).href, { waitUntil: 'load' });
  await p.waitForTimeout(800);
  const broken = await p.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute('src')));
  await p.screenshot({ path: resolve(outDir, `${name}-${theme}.png`), fullPage: true });
  console.log(theme, broken.length ? `坏图：${broken.join(', ')}` : '图片全部加载');
  await ctx.close();
}
await browser.close();
