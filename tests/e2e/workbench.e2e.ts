/**
 * 工作台端到端（pnpm e2e，不在 pnpm test 里，约 2–4 分钟）：
 * 上传样片 → 开始出片 → 中途取消（v1 失败）→ 改字幕样式 → 再开始 → 剪辑直播（转录、划掉的词、分镜、自检分）→ v2 首版完成
 * → 重播 → 点画面插入 @时间 → 发一条修改 → 点内联选项 → 出 v3（本版改动蓝点）→ 对比同步播放 → 导出 → 接近预算上限的提示。
 * 服务以 MINGZHI_FAKE_LLM=1 启动：模型与生图是假的，识别、剪切、渲染、响度、成片检查是真的。样片是合成的（没有真人）。
 * 设 E2E_SHOTS=目录 时，在关键状态截 1440×900 的图（final-*.png）。
 */
import { mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Page } from 'playwright';
import { ROOT, startHarness, type Harness } from './harness.js';

const FIXTURE = join(ROOT, 'tests', 'fixtures', 'talk.mp4');
const OUT = process.env.E2E_OUT || join(ROOT, 'logs', 'e2e');
const RUN_TIMEOUT = 300_000;
const SHOTS = process.env.E2E_SHOTS;

/** 关键状态截图（只在设了 E2E_SHOTS 时） */
async function shot(page: Page, name: string): Promise<void> {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700); // 等入场动效落定
  await page.screenshot({ path: join(SHOTS, `final-${name}.png`) });
}

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

async function cancelFirstTry(page: Page): Promise<void> {
  await step(page, '公告条显示假模式标识', async () => {
    await page.locator('.bar-mock', { hasText: '假模式' }).waitFor();
  });
  await step(page, '上传样片', async () => {
    await page.setInputFiles('.drop input[type=file]', FIXTURE);
    await page.locator('.in-row .in-ok').waitFor({ timeout: 60_000 });
    await page.locator('button:has-text("开始出片"):not([disabled])').waitFor({ timeout: 60_000 });
  });
  await step(page, '开始出片后中途取消：v1 失败，直播卡写明原因，设置卡回来', async () => {
    await page.locator('button:has-text("开始出片")').click();
    await page.locator('.live .win').waitFor();
    await page.locator('.frame .term-body .ln').first().waitFor({ timeout: 60_000 }); // 运行器已建版本、开始发事件
    await page.locator('.live .titlebar button', { hasText: '取消' }).click();
    await page.locator('.live-err', { hasText: '已取消' }).waitFor({ timeout: 60_000 });
    await page.locator('.card.setup').waitFor();
    await page.locator('button:has-text("开始出片"):not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('.live-sum', { hasText: '没有剪完' }).waitFor();
  });
  await step(page, '首版失败后可以改设置（字幕样式），不再被拒', async () => {
    const target = page.locator('.capt:not(.on)').first();
    const name = await target.locator('.capt-nm').innerText();
    const saved = page.waitForResponse((r) => r.request().method() === 'PATCH' && r.url().includes('/api/spaces/'));
    await target.click();
    assert((await saved).status() === 200, '改字幕样式没保存上');
    await page.locator('.capt.on .capt-nm', { hasText: name }).waitFor();
    assert(await page.locator('.toast', { hasText: '没保存上' }).count() === 0, '出现了「没保存上」');
    await shot(page, '1-retry-after-cancel');
  });
}

async function firstVersion(page: Page): Promise<void> {
  await step(page, '再点开始出片：v2 才是首版', async () => {
    await page.locator('button:has-text("开始出片")').click();
    await page.locator('.prev-try', { hasText: 'v1' }).waitFor();
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
  await step(page, 'v2 完成：版本卡写「首版」，版本切换里 v1 是灰色「失败」', async () => {
    await page.locator('.ver', { hasText: 'v2' }).waitFor({ timeout: RUN_TIMEOUT });
    await page.locator('.ver .ver-it', { hasText: '首版' }).waitFor();
    await page.locator('.vid.real video').waitFor();
    await page.locator('.seg.live button.failed', { hasText: 'v1' }).waitFor();
    await page.locator('.pane-h h2', { hasText: '首版' }).waitFor();
    await page.locator('.seg.live button.failed', { hasText: 'v1' }).click();
    await page.locator('.toast', { hasText: 'v1 没有完成：已取消' }).waitFor();
    await shot(page, '2-failed-version-in-switcher');
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
  await step(page, '点内联选项 → 出 v3：本版改了 1 段，进度条上有蓝点', async () => {
    await page.locator('.iopt').first().click();
    await page.locator('.run').waitFor({ timeout: 30_000 });
    await page.locator('.ver', { hasText: 'v3' }).waitFor({ timeout: RUN_TIMEOUT });
    await page.locator('.seg.live button', { hasText: 'v3' }).waitFor();
    await page.locator('.ver', { hasText: 'v3' }).locator('.ver-it', { hasText: '改了 1 段' }).waitFor();
    await page.locator('.stagewin .pbar .chg').first().waitFor({ timeout: 20_000 });
    assert(await page.locator('.stagewin .pbar .chg').count() === 1, '蓝点数量不是 1');
    await shot(page, '4-v3-change-dot');
  });
}

async function compareAndExport(page: Page, h: Harness): Promise<void> {
  await step(page, '对比：左右同步播放', async () => {
    await page.locator('.sw').click();
    await page.locator('.stagewin.pair .player').nth(1).waitFor();
    await page.locator('.diff', { hasText: '只有 1 段不同' }).waitFor();
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

/** 把上限压到刚好比已花多一点：标题行与输入框上方提示接近上限，对话规划被拒并说明原因 */
async function nearBudget(page: Page): Promise<void> {
  await step(page, '接近预算上限：提示调高上限，对话规划被拒', async () => {
    const id = await page.evaluate(async () => {
      const spaces = (await (await fetch('/api/spaces')).json()) as { id: string; totalCostYuan: number }[];
      const s = spaces[0];
      await fetch(`/api/spaces/${s.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ settings: { budgetYuan: Math.round((s.totalCostYuan + 0.02) * 100) / 100 } }) });
      return s.id;
    });
    assert(id, '没找到项目');
    await page.reload();
    await page.locator('.chat-head .spent.near', { hasText: '本项目已花' }).waitFor({ timeout: 30_000 });
    await page.locator('.lim-note', { hasText: '请在设置里调高上限' }).waitFor();
    await page.locator('textarea').fill('节奏再快一点');
    await page.keyboard.press('Enter');
    await page.locator('.say.err', { hasText: '已接近上限' }).waitFor({ timeout: 30_000 });
    await page.locator('.lim-btn', { hasText: '调高上限' }).click();
    await page.locator('.lim-note .bud-edit input[type=range]').waitFor();
    await shot(page, '3-near-budget');
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
    await cancelFirstTry(page);
    await firstVersion(page);
    await replayAndRef(page, h);
    await editRound(page);
    await compareAndExport(page, h);
    await nearBudget(page);
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
