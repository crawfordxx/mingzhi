import type { IncomingMessage } from 'node:http';
import { HttpError } from './http.js';

const LOCAL_HOSTS = ['127.0.0.1', 'localhost'];
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/** 允许的端口：当前监听端口，加上开发时的前端端口（vite 代理不改写 Host/Origin） */
export interface GuardOptions { port: number; devPort?: number }

const allowedPorts = (o: GuardOptions): string[] => [String(o.port), ...(o.devPort ? [String(o.devPort)] : [])];

function hostAllowed(host: string | undefined, o: GuardOptions): boolean {
  if (!host) return false;
  const lower = host.toLowerCase();
  return LOCAL_HOSTS.some((h) => allowedPorts(o).some((p) => lower === `${h}:${p}`));
}

function originAllowed(origin: string, o: GuardOptions): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false; // 含 "null"（沙箱 iframe）
  }
  return url.protocol === 'http:' && LOCAL_HOSTS.includes(url.hostname) && allowedPorts(o).includes(url.port);
}

/**
 * 本机服务的入口守卫：
 * - Host 必须是 127.0.0.1 / localhost 加当前端口（挡 DNS 重绑定）；
 * - 带 Origin 的请求，Origin 必须是本机当前端口（挡网页跨源调用，写请求尤其重要）；
 * - 写请求若带 Sec-Fetch-Site，只接受 same-origin / none。
 * 没有 Origin 的请求（curl、测试）放行：浏览器的跨源写请求一定带 Origin。
 */
export function guardRequest(req: IncomingMessage, o: GuardOptions): void {
  if (!hostAllowed(req.headers.host, o)) throw new HttpError(403, '拒绝访问：只允许从本机地址访问');
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin, o)) throw new HttpError(403, '拒绝跨源请求');
  const write = !SAFE_METHODS.has(req.method ?? 'GET');
  const site = req.headers['sec-fetch-site'];
  if (write && typeof site === 'string' && site !== 'same-origin' && site !== 'none') throw new HttpError(403, '拒绝跨源请求');
}

/**
 * 这个请求算不算「有人在用」（空闲退出的判定依据）：Host 合法，Origin（若带）是本机当前端口，
 * Sec-Fetch-Site（若带）是 same-origin / none（地址栏直接访问）。
 * 没有这些头的请求（curl、测试、启动器的就绪探测）照常算；跨站网页发来的 GET 不算。
 * 校验不通过的请求本来就会被 guardRequest 拒绝，不会被当成活动。
 */
export function countsAsActivity(req: IncomingMessage, o: GuardOptions): boolean {
  if (!hostAllowed(req.headers.host, o)) return false;
  const origin = req.headers.origin;
  if (origin !== undefined && !originAllowed(origin, o)) return false;
  const site = req.headers['sec-fetch-site'];
  return typeof site !== 'string' || site === 'same-origin' || site === 'none';
}
