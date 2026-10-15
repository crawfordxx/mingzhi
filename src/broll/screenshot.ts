import { spawn } from 'node:child_process';
import { renameSync, rmSync, statSync } from 'node:fs';
import { ensureBrowser } from '@remotion/renderer';

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1350;
const DEFAULT_TIMEOUT_MS = 30_000;
const BLANK_BYTES = 10 * 1024;
const VIRTUAL_TIME_BUDGET_MS = 8000;

export interface ScreenshotOptions {
  width?: number;
  height?: number;
  timeoutMs?: number;
  browserPath?: string;
}

/** 小于 10KB 视为空白页或被拦截 */
export function isLikelyBlank(pngBytes: number): boolean {
  return pngBytes < BLANK_BYTES;
}

/** 杀掉整个进程组（浏览器会派生 GPU/渲染子进程），进程已退出时忽略 */
function killGroup(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // 进程组已不存在
  }
}

/** 启动无头浏览器截图，超时或出错都会杀掉子进程 */
function runBrowser(browserPath: string, args: string[], timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'ignore'], detached: true });
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killGroup(child.pid);
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error(`网页截图超时（${timeoutMs / 1000} 秒）`)), timeoutMs);
    child.on('error', (err) => finish(new Error(`无法启动无头浏览器：${err.message}`)));
    child.on('exit', (code) => finish(code === 0 ? undefined : new Error(`无头浏览器异常退出（退出码 ${code}）`)));
  });
}

async function resolveBrowserPath(): Promise<string> {
  const status = await ensureBrowser();
  if (status.type === 'no-browser' || status.type === 'version-mismatch') throw new Error('未找到可用的无头浏览器（Chrome Headless Shell）');
  return status.path;
}

/** 截取网页（默认 1080×1350）到 output；先写临时文件，校验通过后再改名，失败不留下看似有效的文件 */
export async function screenshotUrl(url: string, output: string, opts: ScreenshotOptions = {}): Promise<void> {
  const browserPath = opts.browserPath ?? (await resolveBrowserPath());
  const tmp = `${output}.tmp-${process.pid}.png`;
  const args = [
    `--screenshot=${tmp}`,
    `--window-size=${opts.width ?? DEFAULT_WIDTH},${opts.height ?? DEFAULT_HEIGHT}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    url,
  ];
  try {
    await runBrowser(browserPath, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const size = statSync(tmp, { throwIfNoEntry: false })?.size ?? 0;
    if (isLikelyBlank(size)) throw new Error(`网页截图失败：输出为空白或过小（${size} 字节），可能被拦截：${url}`);
    renameSync(tmp, output);
  } finally {
    rmSync(tmp, { force: true });
  }
}
