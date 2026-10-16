/**
 * 检查更新用的代理支持：国内访问 api.github.com 常要代理，而 Node 22 的 fetch 只在启动时设了 NODE_USE_ENV_PROXY=1 才读代理环境变量。
 * 这里按「环境变量（HTTPS_PROXY 等）→ macOS 系统代理（scutil --proxy）」找代理，经 HTTP CONNECT 隧道发 GET；
 * 找不到代理、或进程已开 NODE_USE_ENV_PROXY 时直接用全局 fetch。只支持 http:// 代理（与启动器一致，不支持 SOCKS）。
 */
import { execFileSync } from 'node:child_process';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

const MAX_BODY_BYTES = 1024 * 1024;
const SCUTIL_TIMEOUT_MS = 2000;

/** 环境变量里的代理；只认 http://（没写协议按 http），其它协议（socks5 等）忽略 */
export function envProxy(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy;
  if (!raw) return undefined;
  const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  return url.toLowerCase().startsWith('http://') ? url : undefined;
}

/** 解析 `scutil --proxy` 的输出：HTTPS 代理优先，其次 HTTP 代理 */
export function parseScutil(out: string): string | undefined {
  const field = (k: string): string | undefined => new RegExp(`^\\s*${k}\\s*:\\s*(\\S+)`, 'm').exec(out)?.[1];
  for (const p of ['HTTPS', 'HTTP']) {
    const host = field(`${p}Proxy`);
    if (field(`${p}Enable`) === '1' && host) return `http://${host}:${field(`${p}Port`) ?? '80'}`;
  }
  return undefined;
}

/** macOS 系统代理（「系统设置 → 网络 → 代理」或代理软件的「设为系统代理」）；其它系统与出错时 undefined */
export function readSystemProxy(): string | undefined {
  if (process.platform !== 'darwin') return undefined;
  try {
    return parseScutil(execFileSync('/usr/sbin/scutil', ['--proxy'], { encoding: 'utf8', timeout: SCUTIL_TIMEOUT_MS }));
  } catch {
    return undefined;
  }
}

function bypassed(host: string, env: NodeJS.ProcessEnv): boolean {
  const list = (env.NO_PROXY || env.no_proxy || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return list.some((p) => p === '*' || host === p.replace(/^\./, '') || host.endsWith(p.startsWith('.') ? p : `.${p}`));
}

/** 访问 host 该用的代理：环境变量优先，其次系统代理；NO_PROXY 命中时直连 */
export function proxyFor(host: string, env: NodeJS.ProcessEnv, system: () => string | undefined): string | undefined {
  const proxy = envProxy(env) ?? system();
  return proxy && !bypassed(host, env) ? proxy : undefined;
}

/** 向代理发 CONNECT，拿到通往目标的原始 socket */
function openTunnel(proxy: URL, host: string, port: number, signal?: AbortSignal | null): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const auth = proxy.username ? { 'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}` } : {};
    const req = httpRequest({ host: proxy.hostname, port: Number(proxy.port) || 80, method: 'CONNECT', path: `${host}:${port}`, headers: { Host: `${host}:${port}`, ...auth }, signal: signal ?? undefined });
    req.once('connect', (res: IncomingMessage, socket: Socket) => {
      if (res.statusCode === 200) { resolve(socket); return; }
      socket.destroy();
      reject(new Error(`代理拒绝了连接（${res.statusCode}）`));
    });
    req.once('error', reject);
    req.end();
  });
}

function readBody(res: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    res.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) { res.destroy(new Error('响应过大')); return; }
      chunks.push(c);
    });
    res.once('end', () => resolve(Buffer.concat(chunks)));
    res.once('error', reject);
  });
}

/** 经 HTTP CONNECT 代理发 GET（只支持检查更新需要的：GET、对象形式的请求头、AbortSignal） */
export function tunnelFetch(proxyUrl: string): FetchLike {
  return async (url, init = {}) => {
    const target = new URL(url);
    const secure = target.protocol === 'https:';
    const port = Number(target.port) || (secure ? 443 : 80);
    const socket = await openTunnel(new URL(proxyUrl), target.hostname, port, init.signal);
    const conn = secure ? tlsConnect({ socket, servername: target.hostname }) : socket;
    const request = secure ? httpsRequest : httpRequest;
    return new Promise<Response>((resolve, reject) => {
      const req = request(url, {
        // GitHub API 要求带 User-Agent：用与 Node 自带 fetch 相同的中性值「node」，不含版本或任何标识
        method: 'GET', headers: { 'User-Agent': 'node', ...(init.headers as Record<string, string> | undefined) }, agent: false, createConnection: () => conn, signal: init.signal ?? undefined,
      }, (res) => {
        readBody(res).then((body) => resolve(new Response(body, { status: res.statusCode ?? 0 })), reject).finally(() => conn.destroy());
      });
      req.once('error', (err) => { conn.destroy(); reject(err); });
      req.end();
    });
  };
}

/** 检查更新用的 fetch：找得到代理就走隧道，否则（或进程已开 NODE_USE_ENV_PROXY）用全局 fetch */
export function proxyAwareFetch(env: NodeJS.ProcessEnv = process.env, system: () => string | undefined = readSystemProxy): FetchLike {
  return (url, init) => {
    if (env.NODE_USE_ENV_PROXY === '1') return fetch(url, init);
    const proxy = proxyFor(new URL(url).hostname, env, system);
    return proxy ? tunnelFetch(proxy)(url, init) : fetch(url, init);
  };
}
