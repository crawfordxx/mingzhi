/**
 * 工作台端到端（pnpm e2e，不在 pnpm test 里，约 2–4 分钟）：
 * 上传样片 → 开始出片 → 剪辑直播（转录、划掉的词、分镜、自检分）→ v1 完成 → 重播 → 点画面插入 @时间
 * → 发一条修改 → 点内联选项 → 出 v2 → 对比同步播放 → 导出。
 * 服务以 MINGZHI_FAKE_LLM=1 启动：模型与生图是假的，识别、剪切、渲染、响度、成片检查是真的。样片是合成的（没有真人）。
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { ROOT, startHarness, type Harness } from './harness.js';

const FIXTURE = join(ROOT, 'tests', 'fixtures', 'talk.mp4');
const OUT = process.env.E2E_OUT || join(ROOT, 'logs', 'e2e');
const RUN_TIMEOUT = 300_000;

function assert(ok: unknown, message: string): asserts ok {
  if (!ok) throw new Error(`断言失败：${message}`);
}

async function step(page: Page, name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = Date.now();
  try {
    await fn();
    console.log(`✓ ${name}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } catch (err) {
    mkdirSync(OUT, { recursive: true });
    await page.screenshot({ path: join(OUT, `失败-${name}.png`) }).catch(() => undefined);
    throw new Error(`✗ ${name}：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function firstVersion(page: Page): Promise<void> {
  await step(page, '公告条显示假模式标识', async () => {
    await page.locator('.bar-mock', { hasText: '假模式' }).waitFor();
  });
  await step(page, '上传样片', async () => {
    await page.setInputFiles('.drop input[type=file]', FIXTURE);
    await page.locator('.in-row .in-ok').waitFor({ timeout: 60_000 });
    await page.locator('button:has-text("开始出片"):not([disabled])').waitFor({ timeout: 60_000 });
  });
  await step(page, '开始出片', async () => {
    await page.locator('button:has-text("开始出片")').click();
    await page.locator('.live .win').waitFor();
    await page.locator('.frame .tw.term').waitFor();
  });
  await step(page, '剪辑直播：转录与划掉的词、画框里的终端', async () => {
    await page.locator('.tx-list .tx').first().waitFor({ timeout: 90_000 });
    await page.locator('.tx-list .cutw').first().waitFor({ state: 'attached', timeout: 30_000 });
    await page.locator('.frame .term-body .ln', { hasText: '识别' }).waitFor();
  });
  await step(page, '剪辑直播：分镜逐张出现、自检分跳出', async () => {
    await page.locator('.strip .tile:not(.ghost)').first().waitFor({ timeout: RUN_TIMEOUT });
    await page.locator('.sc .v', { hasText: /\d\.\d/ }).first().waitFor({ timeout: RUN_TIMEOUT });
  });
  await step(page, 'v1 完成', async () => {
    await page.locator('.ver', { hasText: 'v1' }).waitFor({ timeout: RUN_TIMEOUT });
    await page.locator('.vid.real video').waitFor();
  });
}

async function replayAndRef(page: Page, h: Harness): Promise<void> {
  await step(page, '重播剪辑过程（含首尾停顿 ≤ 20 秒）', async () => {
    await page.getByRole('button', { name: '重播剪辑过程' }).click();
    await page.getByRole('button', { name: /重播中/ }).waitFor();
    const t0 = Date.now();
    await page.getByRole('button', { name: '重播剪辑过程' }).waitFor({ timeout: 21_000 });
    const ms = Date.now() - t0;
    assert(ms <= 20_500, `重播用了 ${(ms / 1000).toFixed(1)} 秒，超过 20 秒`);
  });
  if (!h.h264) console.log('－ 跳过：成片可播放（没有系统 Chrome，Chromium 不能解码 H.264）');
  else {
    await step(page, '成片可播放', async () => {
      await page.waitForFunction(() => (document.querySelector('.vid.real video') as HTMLVideoElement | null)?.duration! > 3, undefined, { timeout: 20_000 });
    });
  }
  await step(page, '点画面插入 @时间（末尾带空格）', async () => {
    await page.locator('.vid.real').click({ position: { x: 60, y: 60 } });
    await page.locator('.tags .hl.ref').first().waitFor();
    const text = await page.locator('.tags .hl.ref').first().innerText();
    assert(/^@\d{2}:\d{2}/.test(text), `引用格式不对：${text}`);
  });
}

async function editRound(page: Page): Promise<void> {
  await step(page, '发一条修改', async () => {
    await page.locator('textarea').fill('这张卡太弱了，换个更有冲击力的标题');
    await page.keyboard.press('Enter');
    const bubble = await page.locator('.bubble').last().innerText();
    assert(/@\d{2}:\d{2}/.test(bubble), '气泡里没有 @ 引用');
    await page.locator('.iopt').first().waitFor({ timeout: 30_000 });
  });
  await step(page, '点内联选项 → 出 v2', async () => {
    await page.locator('.iopt').first().click();
    await page.locator('.run').waitFor({ timeout: 30_000 });
    await page.locator('.ver', { hasText: 'v2' }).waitFor({ timeout: RUN_TIMEOUT });
    await page.locator('.seg.live button', { hasText: 'v2' }).waitFor();
  });
}

async function compareAndExport(page: Page, h: Harness): Promise<void> {
  await step(page, '对比：左右同步播放', async () => {
    await page.locator('.sw').click();
    await page.locator('.stagewin.pair .player').nth(1).waitFor();
    await page.locator('.diff').waitFor();
    if (!h.h264) { console.log('  （跳过同步断言：没有系统 Chrome）'); return; }
    await page.waitForFunction(() => Array.from(document.querySelectorAll<HTMLVideoElement>('.pair video')).every((v) => v.readyState >= 1), undefined, { timeout: 20_000 });
    const bar = page.locator('.pair .pbar').first();
    const box = await bar.boundingBox();
    assert(box, '找不到进度条');
    // 拖动：按下 → 移到 20% → 移到 50% → 松开
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height / 2, { steps: 4 });
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height / 2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(400);
    const times = await page.$$eval('.pair video', (vs) => vs.map((v) => (v as HTMLVideoElement).currentTime));
    assert(times.length === 2 && Math.abs(times[0] - times[1]) < 0.2 && times[0] > 1, `两个画面没有跟随：${times.join(' / ')}`);
  });
  await step(page, '导出', async () => {
    await page.locator('.pane-h .btn-k', { hasText: '导出' }).click();
    await page.locator('.toast', { hasText: '已导出' }).waitFor({ timeout: 30_000 });
    const files = readdirSync(h.exportDir);
    assert(files.some((f) => f.endsWith('.mp4')) && files.some((f) => f.endsWith('.png')), `导出目录里没有成片和封面：${files.join('、')}`);
  });
}

async function main(): Promise<void> {
  const h = await startHarness();
  console.log(`服务 ${h.url} · 数据目录 ${h.dataDir} · ${h.h264 ? '系统 Chrome' : 'Chromium（不验证播放）'}`);
  const page = await h.browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  let ok = false;
  try {
    await page.goto(h.url);
    await firstVersion(page);
    await replayAndRef(page, h);
    await editRound(page);
    await compareAndExport(page, h);
    assert(errors.length === 0, `页面报错：${errors.join('；')}`);
    ok = true;
    console.log('端到端通过');
  } finally {
    await h.close(!ok);
    if (!ok) console.log(`失败现场：数据目录 ${h.dataDir}，截图 ${OUT}`);
  }
}

main().catch((err: Error) => {
  console.error(err.message);
  process.exit(1);
});
