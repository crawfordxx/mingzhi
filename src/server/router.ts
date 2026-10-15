import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError } from './http.js';

export interface RouteCtx {
  req: IncomingMessage;
  res: ServerResponse;
  /** 路径参数，已解码；是否合法由各处理函数自己严格校验 */
  params: Record<string, string>;
  query: URLSearchParams;
}
export type Handler = (c: RouteCtx) => Promise<void> | void;
export interface Route { method: string; pattern: string; handler: Handler }

export const route = (method: string, pattern: string, handler: Handler): Route => ({ method, pattern, handler });

/** 把原始路径拆成已解码的段；解码失败、段内含 / \ 或 NUL 的一律拒绝（返回 null），`..` 之类留给后面的白名单挡 */
export function splitPath(rawPath: string): string[] | null {
  const parts = rawPath.split('/').slice(1);
  const decoded: string[] = [];
  for (const part of parts) {
    let seg: string;
    try {
      seg = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (/[/\\\u0000]/.test(seg)) return null;
    decoded.push(seg);
  }
  return decoded;
}

/** 不经过 URL 对象解析：URL 会把 %2e%2e 和 .. 归一化掉，我们要原样看到它们 */
export function splitUrl(rawUrl: string): { segments: string[] | null; query: URLSearchParams } {
  const q = rawUrl.indexOf('?');
  const path = q === -1 ? rawUrl : rawUrl.slice(0, q);
  return { segments: path.startsWith('/') ? splitPath(path) : null, query: new URLSearchParams(q === -1 ? '' : rawUrl.slice(q + 1)) };
}

function matchPattern(pattern: string, segments: string[]): Record<string, string> | null {
  const want = pattern.split('/');
  if (want.length !== segments.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < want.length; i += 1) {
    if (want[i].startsWith(':')) {
      if (segments[i] === '') return null;
      params[want[i].slice(1)] = segments[i];
    } else if (want[i] !== segments[i]) return null;
  }
  return params;
}

export interface Matched { handler: Handler; params: Record<string, string> }

/** 按方法与路径找处理函数；路径存在但方法不对返回 405，路径不存在返回 undefined（交给静态文件） */
export function findRoute(routes: Route[], method: string, segments: string[]): Matched | undefined {
  const head = method === 'HEAD' ? 'GET' : method;
  let pathExists = false;
  for (const r of routes) {
    const params = matchPattern(r.pattern, segments);
    if (!params) continue;
    pathExists = true;
    if (r.method === head) return { handler: r.handler, params };
  }
  if (pathExists) throw new HttpError(405, '不支持这个请求方法');
  return undefined;
}
