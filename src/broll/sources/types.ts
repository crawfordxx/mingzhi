/** 素材候选：各来源统一的结构，授权信息随候选走，选中后写入 credits.json */
export interface Candidate {
  /** 来源:原始id */
  id: string;
  source: 'pexels' | 'pixabay' | 'openverse' | 'wikimedia' | 'screenshot' | 'generated';
  kind: 'video' | 'photo';
  /** 缩略图 URL 或本地路径 */
  thumb: string;
  /** 原文件 */
  url: string;
  width: number;
  height: number;
  durationSec?: number;
  fps?: number;
  /** 原文件体积（字节），来源给得出时才有，下载前用来判断要不要拉 */
  sizeBytes?: number;
  /** 作品页 */
  page: string;
  author?: string;
  /** 作者主页，署名时附上 */
  authorUrl?: string;
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
  /** 限流重试前的等待，测试里注入以免真等 */
  sleep?: (ms: number) => Promise<void>;
}

/** 视频目标短边：低于它画面放到 1080 宽的版面里会糊 */
export const MIN_SHORT_EDGE = 1080;
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
