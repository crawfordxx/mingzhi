/**
 * 端到端测试的外壳：临时数据目录（模型、素材、ffmpeg 软链到本机已下载的那份）+ 假模型模式启动本机服务 + 打开浏览器。
 * 不调用可想 AI、不花钱；不写用户的钥匙串（key 用环境变量里的占位串）与「下载」目录（导出到临时目录）。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium, type Browser } from 'playwright';

export const ROOT = join(import.meta.dirname, '..', '..');
const SHARED = ['models', 'assets', 'bin'];

export interface Harness { url: string; dataDir: string; exportDir: string; server: ChildProcess; browser: Browser; h264: boolean; close: (keep: boolean) => Promise<void> }

/** 临时数据目录：模型、素材与自带 ffmpeg 软链过来（这些很大，且与测试无关） */
function makeDataDir(): { dir: string; exportDir: string } {
  const source = process.env.MINGZHI_DATA_DIR || join(homedir(), '.mingzhi');
  if (!existsSync(join(source, 'models'))) throw new Error(`没有找到识别模型（${source}/models），请先运行 pnpm fetch-models 与 pnpm fetch-assets`);
  const dir = mkdtempSync(join(tmpdir(), 'mz-e2e-'));
  for (const name of SHARED) if (existsSync(join(source, name))) symlinkSync(join(source, name), join(dir, name));
  const exportDir = join(dir, 'exports');
  mkdirSync(exportDir);
  return { dir, exportDir };
}

/** 假模型模式启动服务，等它打印出地址 */
function startServer(dataDir: string, exportDir: string): Promise<{ url: string; server: ChildProcess }> {
  const env = { ...process.env, MINGZHI_FAKE_LLM: '1', MINGZHI_DATA_DIR: dataDir, MINGZHI_EXPORT_DIR: exportDir, MINGZHI_KX_KEY: 'fake-e2e-placeholder', MINGZHI_PORT: String(46000 + Math.floor(Math.random() * 2000)) };
  const server = spawn(process.execPath, ['--import', 'tsx', join(ROOT, 'src', 'server', 'index.ts')], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let log = '';
    const timer = setTimeout(() => reject(new Error(`服务 30 秒内没有启动：\n${log}`)), 30_000);
    const onData = (chunk: Buffer) => {
      log += chunk.toString();
      const m = /已启动：(http:\/\/\S+)/.exec(log);
      if (m) { clearTimeout(timer); resolve({ url: m[1], server }); }
    };
    server.stdout?.on('data', onData);
    server.stderr?.on('data', onData);
    server.once('exit', (code) => { clearTimeout(timer); reject(new Error(`服务退出（${code}）：\n${log}`)); });
  });
}

/** 优先用系统 Chrome（能解码 H.264 成片）；没有时退回 Playwright 自带的 Chromium（播放相关的检查会跳过） */
async function openBrowser(): Promise<{ browser: Browser; h264: boolean }> {
  const headless = process.env.HEADED !== '1';
  try {
    return { browser: await chromium.launch({ channel: 'chrome', headless }), h264: true };
  } catch {
    return { browser: await chromium.launch({ headless }), h264: false };
  }
}

export async function startHarness(): Promise<Harness> {
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('缺少 web/dist，请先运行 pnpm build:web');
  const { dir, exportDir } = makeDataDir();
  const { url, server } = await startServer(dir, exportDir);
  const { browser, h264 } = await openBrowser();
  const close = async (keep: boolean) => {
    await browser.close();
    server.kill('SIGTERM');
    if (!keep) rmSync(dir, { recursive: true, force: true });
  };
  return { url, dataDir: dir, exportDir, server, browser, h264, close };
}
