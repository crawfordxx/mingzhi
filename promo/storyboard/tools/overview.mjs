// 用法：node overview.mjs —— 需静态服务（仓库根目录 python3 -m http.server 8765）
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const out = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'overview.png');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 2000, height: 1200 } });
await p.goto('http://127.0.0.1:8765/promo/storyboard/overview.html', { waitUntil: 'networkidle' });
await p.waitForSelector('body[data-ready="1"]');
await p.screenshot({ path: out, fullPage: true });
await b.close();
console.log(out);
