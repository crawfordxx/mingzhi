#!/usr/bin/env node
// 把 scripts/readme/tpl/ 下的 HTML 模板渲染成 PNG。
// 用法：node scripts/readme/render.mjs <模板名> "<查询串>" <宽> <高> <输出.png> [--scale N] [--transparent]
// 例：node scripts/readme/render.mjs hero "theme=dark" 1200 600 out.png --scale 2
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const args = process.argv.slice(2);
const [tpl, query, w, h, out] = args;
if (!tpl || !out) {
  console.error('用法：node scripts/readme/render.mjs <模板名> "<查询串>" <宽> <高> <输出.png> [--scale N] [--transparent]');
  process.exit(1);
}
const scaleAt = args.indexOf('--scale');
const scale = scaleAt > 0 ? Number(args[scaleAt + 1]) : 1;
const transparent = args.includes('--transparent');

const here = dirname(fileURLToPath(import.meta.url));
const url = `${pathToFileURL(resolve(here, 'tpl', `${tpl}.html`)).href}?${query}`;
mkdirSync(dirname(resolve(out)), { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: Number(w), height: Number(h) }, deviceScaleFactor: scale });
const problems = [];
page.on('requestfailed', (r) => problems.push(`加载失败 ${r.url()}`));
page.on('pageerror', (e) => problems.push(`脚本错误 ${e.message}`));
await page.goto(url, { waitUntil: 'networkidle' });
await page.evaluate(() => document.fonts.ready);
await page.waitForTimeout(300);
const broken = await page.evaluate(() => [...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.src));
broken.forEach((s) => problems.push(`坏图 ${s}`));
await page.screenshot({ path: out, omitBackground: transparent });
await browser.close();
if (problems.length) {
  console.error(problems.join('\n'));
  process.exit(2);
}
console.log(`ok ${out}`);
