// 用法：node shoot.mjs [01 02 ...]  —— 需先在仓库根目录起静态服务：python3 -m http.server 8765
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.resolve(here, '..');
const ks = process.argv.slice(2).length ? process.argv.slice(2) : Array.from({length:14},(_,i)=>String(i+1).padStart(2,'0'));
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
p.on('console', m => { if (m.type() === 'error') console.log('console:', m.text()); });
p.on('pageerror', e => console.log('pageerror:', e.message));
for (const k of ks) {
  await p.goto(`http://127.0.0.1:8765/promo/storyboard/frames.html?k=${k}`, { waitUntil: 'networkidle' });
  await p.waitForSelector('body[data-ready="1"]', { timeout: 20000 });
  await p.waitForTimeout(300);
  await p.screenshot({ path: path.join(out, `S${k}.png`) });
  console.log('shot', k);
}
await b.close();
