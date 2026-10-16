import { randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MAX_VIDEO_BYTES } from './gather.js';
import type { Candidate } from './sources/types.js';
import { wikimediaFetch } from './sources/wikimedia.js';
import { downloadImage, ORIGINAL_MAX_BYTES } from './still-fetch.js';

/** 原文件下载超时（视频可能几十 MB） */
const VIDEO_TIMEOUT_MS = 180_000;
/** 照片长边超过它时，Wikimedia 改取这个宽度的缩略图（够 4K 裁切，省下几十 MB 的原图） */
export const WIKI_PHOTO_EDGE = 2560;
const VIDEO_TYPE = /^(video\/|application\/octet-stream)/i;

const fetchFor = (c: Candidate, fetchImpl: typeof fetch): typeof fetch => (c.source === 'wikimedia' || c.source === 'openverse' ? wikimediaFetch(fetchImpl) : fetchImpl);

/**
 * Wikimedia 大图取指定宽度的缩略图：缩略图地址形如 …/thumb/a/ab/Name.jpg/640px-Name.jpg，把宽度段换成需要的宽度；
 * 原图本身不大、或缩略图地址不是这个形状时用原图
 */
export function sizedUrl(c: Candidate, edge = WIKI_PHOTO_EDGE): { url: string; width: number; height: number } {
  const long = Math.max(c.width, c.height);
  const m = /\/(\d+)px-[^/]+$/.exec(c.thumb);
  if (c.source !== 'wikimedia' || c.kind !== 'photo' || long <= edge || !m || !c.thumb.includes('/thumb/')) return { url: c.url, width: c.width, height: c.height };
  const scale = edge / long;
  const width = Math.round(c.width * scale);
  return { url: c.thumb.replace(/\/\d+px-([^/]+)$/, `/${width}px-$1`), width, height: Math.round(c.height * scale) };
}

/** 流式下载并在超过上限时中止；先写临时文件，完整后改名 */
async function downloadVideo(url: string, dest: string, fetchImpl: typeof fetch, signal?: AbortSignal): Promise<void> {
  const timeout = AbortSignal.timeout(VIDEO_TIMEOUT_MS);
  const res = await fetchImpl(url, { signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
  if (!res.ok || !res.body) throw new Error(`视频下载失败 ${res.status}：${url}`);
  const type = res.headers.get('content-type') ?? '';
  if (type && !VIDEO_TYPE.test(type)) throw new Error(`下载到的不是视频（${type}）：${url}`);
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_VIDEO_BYTES) throw new Error(`视频超过 ${MAX_VIDEO_BYTES / 1024 / 1024}MB 上限：${url}`);
  let total = 0;
  const cap = new Transform({
    transform(chunk: Buffer, _enc, done) {
      total += chunk.length;
      done(total > MAX_VIDEO_BYTES ? new Error(`视频超过 ${MAX_VIDEO_BYTES / 1024 / 1024}MB 上限：${url}`) : null, chunk);
    },
  });
  const tmp = `${dest}.${randomUUID().slice(0, 8)}.part`;
  try {
    await pipeline(Readable.fromWeb(res.body as never), cap, createWriteStream(tmp));
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 下载候选的原文件到 dest（已存在直接用）：照片校验类型与 30MB 上限，Wikimedia 大图取缩略图；视频 150MB 上限；Wikimedia 请求带 User-Agent。返回实际文件的像素尺寸 */
export async function fetchOriginal(c: Candidate, dest: string, fetchImpl: typeof fetch = fetch, signal?: AbortSignal): Promise<{ width: number; height: number }> {
  const sized = sizedUrl(c);
  if (existsSync(dest)) return { width: sized.width, height: sized.height };
  mkdirSync(dirname(dest), { recursive: true });
  const http = fetchFor(c, fetchImpl);
  if (c.kind === 'video') await downloadVideo(c.url, dest, http, signal);
  else await downloadImage(sized.url, dest, http, ORIGINAL_MAX_BYTES, signal);
  return { width: sized.width, height: sized.height };
}
