import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { ensureBrowser } from '@remotion/renderer';
import { isPublicHttpUrl } from './search.js';

const DEFAULT_WIDTH = 1080;
const DEFAULT_HEIGHT = 1350;
const DEFAULT_TIMEOUT_MS = 30_000;
const BLANK_BYTES = 10 * 1024;
const VIRTUAL_TIME_BUDGET_MS = 8000;
const STDERR_TAIL_BYTES = 800;

export interface ScreenshotOptions {
  width?: number;
  height?: number;
  timeoutMs?: number;
  browserPath?: string;
  /** 允许 file:// 本地页面，仅供测试使用 */
  allowFile?: boolean;
  /** 不加载图片（img、picture、CSS 背景图、视频封面）：只留页面与标题区，不截新闻配图本体与品牌 Logo 图 */
  hideImages?: boolean;
}

/** 小于 10KB 视为空白页或被拦截 */
export function isLikelyBlank(pngBytes: number): boolean {
  return pngBytes < BLANK_BYTES;
}

/** 校验网址并返回规范化后的写法：只允许公网 http(s)（allowFile 时另允许 file://） */
function validateUrl(url: string, allowFile: boolean): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`网页截图仅支持 http(s) 网址，无法解析：${url.slice(0, 80)}`);
  }
  if (allowFile && parsed.protocol === 'file:') return parsed.href;
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error(`网页截图仅支持 http(s) 网址：${url.slice(0, 80)}`);
  if (!isPublicHttpUrl(parsed.href)) throw new Error(`网页截图拒绝访问本机或内网地址：${parsed.hostname}`);
  return parsed.href;
}

/** 结束浏览器及其子进程：Windows 用 taskkill /T，POSIX 杀整个进程组 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on('error', () => child.kill());
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/** 启动无头浏览器截图，超时或出错都会结束整棵进程树；成功时返回 stderr 末尾 */
function runBrowser(browserPath: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(browserPath, args, { stdio: ['ignore', 'ignore', 'pipe'], detached: process.platform !== 'win32', windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-STDERR_TAIL_BYTES);
    });
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      killTree(child);
      if (err) reject(err);
      else resolve(stderr.trim());
    };
    const timer = setTimeout(() => finish(new Error(`网页截图超时（${timeoutMs / 1000} 秒）`)), timeoutMs);
    child.on('error', (err) => finish(new Error(`无法启动无头浏览器：${err.message}`)));
    // 用 close 而不是 exit，确保 stderr 已读完
    child.on('close', (code, signal) => {
      const how = signal ? `被信号 ${signal} 终止` : `退出码 ${code}`;
      finish(code === 0 ? undefined : new Error(`无头浏览器异常退出（${how}）：${stderr.trim()}`));
    });
  });
}

async function resolveBrowserPath(): Promise<string> {
  const status = await ensureBrowser();
  if (status.type === 'no-browser' || status.type === 'version-mismatch') throw new Error('未找到可用的无头浏览器（Chrome Headless Shell）');
  return status.path;
}

/** 截取网页（默认 1080×1350）到 output；先写临时文件，校验通过后再改名，失败不留下看似有效的文件 */
export async function screenshotUrl(url: string, output: string, opts: ScreenshotOptions = {}): Promise<void> {
  const target = validateUrl(url, opts.allowFile ?? false);
  const browserPath = opts.browserPath ?? (await resolveBrowserPath());
  mkdirSync(dirname(output), { recursive: true });
  const tmp = `${output}.tmp-${randomUUID().slice(0, 8)}.png`;
  const args = [
    `--screenshot=${tmp}`,
    `--window-size=${opts.width ?? DEFAULT_WIDTH},${opts.height ?? DEFAULT_HEIGHT}`,
    '--hide-scrollbars',
    '--force-device-scale-factor=1',
    `--virtual-time-budget=${VIRTUAL_TIME_BUDGET_MS}`,
    ...(opts.hideImages ? ['--blink-settings=imagesEnabled=false', '--autoplay-policy=user-gesture-required'] : []),
    target,
  ];
  try {
    const stderr = await runBrowser(browserPath, args, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const size = statSync(tmp, { throwIfNoEntry: false })?.size ?? 0;
    if (isLikelyBlank(size)) throw new Error(`网页截图失败：输出为空白或过小（${size} 字节），可能被拦截：${target}${stderr ? `\n${stderr}` : ''}`);
    renameSync(tmp, output);
  } finally {
    rmSync(tmp, { force: true });
  }
}
