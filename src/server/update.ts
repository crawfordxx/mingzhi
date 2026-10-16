/**
 * 检查更新：查 GitHub Releases 的最新正式版，比当前版本新就在 /api/status 里带上 update。
 * - 只发一个匿名 GET（不带 key、设备、版本号等任何标识），用户在设置里可以关掉；有代理时经代理发（proxy.ts）；
 * - 每天最多查 1 次，无论成败都记下时间（结果缓存在数据目录），失败一律静默、不重试；
 * - 只提示，不下载：用户点「去下载」才打开 Release 页面。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { proxyAwareFetch, type FetchLike } from './proxy.js';

export const REPO = 'crawfordxx/mingzhi';
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE_PREFIX = `https://github.com/${REPO}/releases/`;
export const UPDATE_CACHE_FILE = 'update-check.json';
const CHECK_INTERVAL_MS = 24 * 3600_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_NOTES_CHARS = 2000;
const PACKAGE_JSON = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json');

export interface UpdateInfo { version: string; url: string; notes: string }

/** 当前版本：启动器传入的 MINGZHI_APP_VERSION 优先，否则读 package.json */
export function appVersion(env: NodeJS.ProcessEnv = process.env): string {
  if (env.MINGZHI_APP_VERSION) return env.MINGZHI_APP_VERSION;
  try {
    return (JSON.parse(readFileSync(PACKAGE_JSON, 'utf8')) as { version?: string }).version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

const SEMVER = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

/** a 是否比 b 新（x.y.z，可带 v 前缀；同号时正式版比预发布新）；认不出的版本号一律当作不新 */
export function isNewer(a: string, b: string): boolean {
  const pa = SEMVER.exec(a.trim());
  const pb = SEMVER.exec(b.trim());
  if (!pa || !pb) return false;
  for (let i = 1; i <= 3; i += 1) {
    const diff = Number(pa[i]) - Number(pb[i]);
    if (diff !== 0) return diff > 0;
  }
  if (pa[4] === pb[4]) return false;
  if (!pa[4]) return true;
  if (!pb[4]) return false;
  return pa[4].localeCompare(pb[4], 'en', { numeric: true }) > 0;
}

const Release = z.object({
  tag_name: z.string().regex(SEMVER),
  html_url: z.string().startsWith(RELEASE_PAGE_PREFIX),
  body: z.string().nullable().optional(),
  draft: z.boolean().optional(),
  prerelease: z.boolean().optional(),
});

const Info = z.object({ version: z.string(), url: z.string().startsWith(RELEASE_PAGE_PREFIX), notes: z.string() });
const Cache = z.object({ checkedAt: z.number().finite(), latest: Info.nullable() });
type CacheData = z.infer<typeof Cache>;

export interface UpdateCheckerOptions {
  dataDir: string;
  /** 当前版本 */
  current: string;
  /** 用户是否开着「检查更新」（每次现读） */
  enabled: () => boolean;
  /** 默认按环境变量 / macOS 系统代理走代理（见 proxy.ts） */
  fetch?: FetchLike;
  now?: () => number;
}

export class UpdateChecker {
  private cache: CacheData | null;
  private inflight: Promise<void> | null = null;
  private readonly file: string;
  private readonly fetchFn: FetchLike;
  private readonly now: () => number;

  constructor(private readonly opts: UpdateCheckerOptions) {
    this.file = join(opts.dataDir, UPDATE_CACHE_FILE);
    this.fetchFn = opts.fetch ?? proxyAwareFetch();
    this.now = opts.now ?? Date.now;
    this.cache = this.readCache();
  }

  /** 有比当前新的版本且用户开着检查更新时返回它，否则 null */
  available(): UpdateInfo | null {
    const latest = this.cache?.latest;
    if (!latest || !this.opts.enabled() || !isNewer(latest.version, this.opts.current)) return null;
    return latest;
  }

  /** 到时间了就查一次（同一时间只有一个请求）；永不抛错 */
  poke(): Promise<void> {
    if (this.inflight) return this.inflight;
    if (!this.opts.enabled() || !this.due()) return Promise.resolve();
    this.inflight = this.check().finally(() => { this.inflight = null; });
    return this.inflight;
  }

  private due(): boolean {
    if (!this.cache) return true;
    const elapsed = this.now() - this.cache.checkedAt;
    return elapsed < 0 || elapsed >= CHECK_INTERVAL_MS;
  }

  private async check(): Promise<void> {
    const found = await this.fetchLatest();
    // 失败（undefined）时保留之前查到的结果，只更新时间
    this.cache = { checkedAt: this.now(), latest: found === undefined ? this.cache?.latest ?? null : found };
    try {
      writeFileSync(this.file, JSON.stringify(this.cache));
    } catch {
      /* 写不进缓存也只是明天再查；内存里已记下时间，本进程当天不会重试 */
    }
  }

  /** 查到的最新正式版；没有正式版为 null；任何失败为 undefined */
  private async fetchLatest(): Promise<UpdateInfo | null | undefined> {
    try {
      const res = await this.fetchFn(RELEASES_API, {
        method: 'GET', headers: { Accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!res.ok) return undefined;
      const parsed = Release.safeParse(await res.json());
      if (!parsed.success) return undefined;
      const r = parsed.data;
      if (r.draft || r.prerelease) return null;
      return { version: r.tag_name.replace(/^v/, ''), url: r.html_url, notes: (r.body ?? '').trim().slice(0, MAX_NOTES_CHARS) };
    } catch {
      return undefined;
    }
  }

  private readCache(): CacheData | null {
    try {
      const parsed = Cache.safeParse(JSON.parse(readFileSync(this.file, 'utf8')));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}
