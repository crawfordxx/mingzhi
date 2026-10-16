import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { run } from '../media/exec.js';
import type { Candidate } from './sources/types.js';
import { wikimediaFetch } from './sources/wikimedia.js';

/** 预览图（缩略图）与原图的体积上限 */
export const THUMB_MAX_BYTES = 5 * 1024 * 1024;
export const ORIGINAL_MAX_BYTES = 30 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 30_000;
/** ffmpeg 读远程视频的网络超时（微秒） */
const NET_TIMEOUT_US = '30000000';
const VIDEO_EXT = /\.(mp4|webm|mov|ogv|m4v|mkv)(\?.*)?$/i;
const HTTP = /^https?:\/\//i;

const isVideoFile = (path: string): boolean => VIDEO_EXT.test(path);
const stillName = (id: string): string => createHash('sha1').update(id).digest('hex').slice(0, 16);
/** Wikimedia 要求带 User-Agent；其它来源原样用传入的 fetch */
const fetchFor = (c: Candidate, fetchImpl: typeof fetch): typeof fetch => (c.source === 'wikimedia' ? wikimediaFetch(fetchImpl) : fetchImpl);

/** 流式读取响应体，累计超过 maxBytes 立即中止 */
async function readCapped(res: Response, maxBytes: number, url: string): Promise<Buffer> {
  const tooBig = (): Error => new Error(`图片超过 ${Math.round(maxBytes / 1024 / 1024)}MB 上限：${url}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) throw tooBig();
  if (!res.body) throw new Error(`下载失败：响应没有内容 ${url}`);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw tooBig();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** 下载图片：校验状态码、Content-Type 为 image/*、字节上限与超时；通过校验才落盘，错误页不会留下缓存 */
export async function downloadImage(url: string, dest: string, fetchImpl: typeof fetch, maxBytes: number): Promise<void> {
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`图片下载失败 ${res.status}：${url}`);
  const type = res.headers.get('content-type') ?? '';
  if (!/^image\//i.test(type)) throw new Error(`下载到的不是图片（${type || '无 Content-Type'}）：${url}`);
  const bytes = await readCapped(res, maxBytes, url);
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 从视频的中间位置抽一帧（远程视频走 ffmpeg 自带的范围请求，不下载整段） */
async function middleFrame(video: string, durationSec: number | undefined, dest: string, ffmpeg: string): Promise<void> {
  const at = durationSec && durationSec > 0 ? durationSec / 2 : 0;
  const net = HTTP.test(video) ? ['-rw_timeout', NET_TIMEOUT_US] : [];
  const tmp = `${dest}.${randomUUID()}.tmp.jpg`;
  try {
    await run(ffmpeg, ['-v', 'error', '-y', ...net, '-ss', String(at), '-i', video, '-frames:v', '1', '-q:v', '3', tmp]);
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * 取候选的一张静帧本地路径（缓存在 dir 里）：优先来源给的预览图，远程的下载（≤5MB）、本地的直接用；
 * 没有预览图（或预览图本身是视频）的视频抽中间帧；没有预览图的照片下载原图（≤30MB）。取不到时抛错
 */
export async function stillOf(c: Candidate, dir: string, ffmpeg: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const dest = join(dir, `${stillName(c.id)}.jpg`);
  if (existsSync(dest)) return dest;
  const preview = c.thumb.trim();
  const http = fetchFor(c, fetchImpl);
  if (preview && !isVideoFile(preview)) {
    if (!HTTP.test(preview)) {
      if (!existsSync(preview)) throw new Error(`预览图不存在：${preview}`);
      return preview;
    }
    await downloadImage(preview, dest, http, THUMB_MAX_BYTES);
    return dest;
  }
  if (c.kind === 'video' || isVideoFile(preview)) {
    await middleFrame(preview || c.url, c.durationSec, dest, ffmpeg);
    return dest;
  }
  await downloadImage(c.url, dest, http, ORIGINAL_MAX_BYTES);
  return dest;
}
