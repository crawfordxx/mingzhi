import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { extname } from 'node:path';
import { pipeline } from 'node:stream';
import { HttpError } from './http.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.mp4': 'video/mp4', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8', '.map': 'application/json; charset=utf-8',
};

export const mimeOf = (path: string): string => MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';

export type ByteRange = { start: number; end: number } | 'invalid' | null;

/** 解析 Range 头：只支持单段 bytes=a-b / a- / -n；多段当作没有 Range（整文件 200）；越界返回 'invalid'（416） */
export function parseRange(header: string | undefined, size: number): ByteRange {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === '' && m[2] === '')) return header.includes(',') ? null : 'invalid';
  if (m[1] === '') {
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'invalid' : { start: Math.max(0, size - n), end: size - 1 };
  }
  const start = Number(m[1]);
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  return start >= size || end < start ? 'invalid' : { start, end };
}

export interface ServeOptions { type?: string; cacheControl?: string }

/** 发送一个文件，支持 Range（视频拖动进度条）与 HEAD；文件不存在或不是普通文件 404 */
export function serveFile(req: IncomingMessage, res: ServerResponse, path: string, opts: ServeOptions = {}): void {
  let size: number;
  try {
    const st = statSync(path);
    if (!st.isFile()) throw new Error('not file');
    size = st.size;
  } catch {
    throw new HttpError(404, '文件不存在');
  }
  const range = parseRange(req.headers.range, size);
  const headers = {
    'Content-Type': opts.type ?? mimeOf(path), 'Accept-Ranges': 'bytes', 'Cache-Control': opts.cacheControl ?? 'no-cache', 'X-Content-Type-Options': 'nosniff',
  };
  if (range === 'invalid') {
    res.writeHead(416, { ...headers, 'Content-Range': `bytes */${size}` });
    res.end();
    return;
  }
  const part = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : part.end - part.start + 1;
  res.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': length, ...(range ? { 'Content-Range': `bytes ${part.start}-${part.end}/${size}` } : {}) });
  if (req.method === 'HEAD' || length === 0) {
    res.end();
    return;
  }
  pipeline(createReadStream(path, { start: part.start, end: part.end }), res, () => undefined); // 客户端中途断开不算错误
}
