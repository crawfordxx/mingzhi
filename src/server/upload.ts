import { createWriteStream, mkdirSync, openSync, readSync, closeSync, renameSync, rmSync, statSync } from 'node:fs';
import type { IncomingMessage } from 'node:http';
import { extname, join } from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { randomUUID } from 'node:crypto';
import { HttpError } from './http.js';

export const VIDEO_EXTS = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.avi'] as const;
export const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.webp'] as const;
export const MAX_VIDEO_BYTES = 4 * 1024 ** 3;
export const MAX_IMAGE_BYTES = 15 * 1024 ** 2;
const MAX_NAME_CHARS = 80;
/** Windows 保留设备名（CON、NUL、COM1…）不能当文件名，加下划线前缀 */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d)(?=\.|$)/i;

/** 上传文件名清洗：只留文件名本身（去掉任何目录），去控制字符与 Windows 保留字符，限长且保留扩展名 */
export function sanitizeFileName(raw: string): string {
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    /* 不是编码过的就用原文 */
  }
  const leaf = decoded.split(/[\\/]/).pop() ?? '';
  const cleaned = leaf.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '').trim().replace(WINDOWS_DEVICE, '_$1');
  const ext = extname(cleaned);
  const stem = cleaned.slice(0, cleaned.length - ext.length);
  const shortStem = [...stem].slice(0, MAX_NAME_CHARS).join('');
  return shortStem ? `${shortStem}${ext}` : ext ? `file${ext}` : '';
}

/** 图片魔数：jpg / png / webp */
export function looksLikeImage(file: string): boolean {
  const fd = openSync(file, 'r');
  try {
    const head = Buffer.alloc(12);
    readSync(fd, head, 0, 12, 0);
    const jpg = head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
    const png = head.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const webp = head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
    return jpg || png || webp;
  } finally {
    closeSync(fd);
  }
}

export interface ReceivedFile { path: string; dir: string; name: string; bytes: number }

class SizeGuard extends Transform {
  private seen = 0;
  constructor(private readonly max: number, private readonly label: string) {
    super();
  }

  override _transform(chunk: Buffer, _enc: BufferEncoding, cb: (err?: Error | null, data?: Buffer) => void): void {
    this.seen += chunk.length;
    if (this.seen > this.max) cb(new HttpError(413, `文件过大（${this.label}上限 ${Math.round(this.max / 1024 ** 2)} MB）`));
    else cb(null, chunk);
  }
}

export interface ReceiveOptions { parent: string; allowed: readonly string[]; maxBytes: number; kind: string }

/** 把请求体流式写成 <parent>/<随机目录>/<清洗后的文件名>；先写 .part 再改名，失败或中断时清理 */
export async function receiveFile(req: IncomingMessage, o: ReceiveOptions): Promise<ReceivedFile> {
  const header = req.headers['x-filename'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (!raw) throw new HttpError(400, '缺少 x-filename 请求头（文件名，需 URL 编码）');
  const name = sanitizeFileName(raw);
  if (!name || !o.allowed.includes(extname(name).toLowerCase())) throw new HttpError(400, `不支持的${o.kind}格式，请上传 ${o.allowed.join(' / ')}`);
  const declared = Number(req.headers['content-length']);
  const label = o.kind;
  if (Number.isFinite(declared) && declared > o.maxBytes) throw new HttpError(413, `文件过大（${label}上限 ${Math.round(o.maxBytes / 1024 ** 2)} MB）`);
  const dir = join(o.parent, randomUUID().slice(0, 8));
  const path = join(dir, name);
  const part = `${path}.part`;
  mkdirSync(dir, { recursive: true });
  try {
    const guard = new SizeGuard(o.maxBytes, label);
    await pipeline(req, guard, createWriteStream(part, { mode: 0o600 }));
    renameSync(part, path);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  const bytes = statSync(path).size;
  if (bytes === 0) {
    rmSync(dir, { recursive: true, force: true });
    throw new HttpError(400, '上传的文件是空的');
  }
  return { path, dir, name, bytes };
}
