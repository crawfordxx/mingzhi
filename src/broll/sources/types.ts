/** 素材候选：各来源统一的结构，授权信息随候选走，选中后写入 credits.json */
export interface Candidate {
  /** 来源:原始id */
  id: string;
  source: 'pexels' | 'pixabay' | 'wikimedia' | 'screenshot' | 'generated';
  kind: 'video' | 'photo';
  /** 缩略图 URL 或本地路径 */
  thumb: string;
  /** 原文件 */
  url: string;
  width: number;
  height: number;
  durationSec?: number;
  fps?: number;
  /** 作品页 */
  page: string;
  author?: string;
  license: string;
  licenseUrl?: string;
  attributionRequired: boolean;
  aiGenerated: boolean;
}

export interface SourceQuery {
  text: string;
  orientation: 'portrait' | 'landscape' | 'square';
  kind: 'video' | 'photo' | 'any';
  perPage: number;
}

export type Source = (q: SourceQuery, signal?: AbortSignal) => Promise<Candidate[]>;

export interface SourceOptions {
  fetchImpl?: typeof fetch;
}

/** 视频目标短边：低于它画面放到 1080 宽的版面里会糊 */
export const MIN_SHORT_EDGE = 1080;
const REQUEST_TIMEOUT_MS = 30_000;

/** 请求超时与外部取消合并成一个 signal */
export function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** 视频文件挑选：短边 ≥ 1080 里最接近的；都不够就取最大的 */
export function pickClosest<T extends { width: number; height: number }>(files: readonly T[]): T | undefined {
  const short = (f: T) => Math.min(f.width, f.height);
  const enough = files.filter((f) => short(f) >= MIN_SHORT_EDGE).sort((a, b) => short(a) - short(b));
  if (enough.length > 0) return enough[0];
  return [...files].sort((a, b) => short(b) - short(a))[0];
}

export function matchesOrientation(width: number, height: number, orientation: SourceQuery['orientation']): boolean {
  if (orientation === 'portrait') return height >= width;
  if (orientation === 'landscape') return width >= height;
  return true;
}

/** kind=any 展开成具体种类 */
export function kindsOf(kind: SourceQuery['kind']): ('video' | 'photo')[] {
  return kind === 'any' ? ['video', 'photo'] : [kind];
}
