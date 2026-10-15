import type { IncomingMessage, ServerResponse } from 'node:http';

/** 带状态码的业务错误：message 直接作为中文提示返回给前端 */
export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export const JSON_LIMIT_BYTES = 1024 * 1024;

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(text), 'Cache-Control': 'no-store' });
  res.end(text);
}

export function sendNoContent(res: ServerResponse): void {
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
}

/** 读请求体并解析成 JSON 对象；超过上限 413、解析失败 400（中文提示）。allowEmpty 时空体当作 {} */
export async function readJsonBody(req: IncomingMessage, allowEmpty = false, limit = JSON_LIMIT_BYTES): Promise<Record<string, unknown>> {
  const declared = Number(req.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024)} KB）`);
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, `请求体过大（上限 ${Math.round(limit / 1024)} KB）`);
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (!text) {
    if (allowEmpty) return {};
    throw new HttpError(400, '请求体不能为空');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new HttpError(400, '请求体不是有效的 JSON');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new HttpError(400, '请求体必须是 JSON 对象');
  return value as Record<string, unknown>;
}

/** 磁盘写满等系统错误翻成中文提示；其余原样（调用方当作 500） */
export function asHttpError(err: unknown): unknown {
  if ((err as NodeJS.ErrnoException | null)?.code === 'ENOSPC') return new HttpError(507, '磁盘空间不足，请清理磁盘后重试');
  return err;
}
