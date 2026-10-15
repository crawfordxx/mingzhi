// 下载清单的核心逻辑：schema 校验、过滤、--app 合并、下载哈希与核对。
// 纯函数 + 可注入的 fetch，便于离线测试；命令行入口见 build-manifest.mjs。
// JSON Schema 文件 launcher/manifest.schema.json 与这里的 zod 定义由 tests/manifest.test.ts 对账。
import { createHash } from 'node:crypto';
import { createReadStream, statSync } from 'node:fs';
import { basename } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { z } from 'zod';

/** 锁定清单文件自身的格式版本（最终清单不带） */
export const SCHEMA_VERSION = 1;
export const KINDS = ['node', 'ffmpeg', 'chrome', 'model', 'asset', 'app'];
export const PLATFORMS = ['darwin-arm64', 'darwin-x64', 'win32-x64', 'any'];
export const UNPACKS = ['tar.gz', 'tar.xz', 'zip', 'tar.zst', 'gz'];
/** 这些类型必须指定具体平台；模型与素材跨平台通用 */
const PLATFORM_BOUND = new Set(['node', 'ffmpeg', 'chrome', 'app']);
/** 安装顺序 */
export const KIND_ORDER = ['app', 'node', 'ffmpeg', 'chrome', 'model', 'asset'];
/** 用户未指定时，app 条目的 GitHub Release 下载基址 */
export const DEFAULT_RELEASE_REPO = 'https://github.com/crawfordxx/mingzhi';

const APP_PLACEHOLDER = '{app}';
const SHA256 = /^[0-9a-f]{64}$/;

/** 相对 AppRoot 的路径：不能是绝对路径、不含反斜杠 / .. / 空段；{app} 占位只允许出现在首段 */
function isSafeRelPath(p) {
  if (typeof p !== 'string' || p === '' || p.startsWith('/') || p.includes('\\') || /^[A-Za-z]:/.test(p)) return false;
  const segs = p.split('/');
  if (segs.some((s) => s === '' || s === '.' || s === '..')) return false;
  return segs.every((s, i) => !s.includes('{') || (i === 0 && s === APP_PLACEHOLDER));
}
const relPath = z.string().refine(isSafeRelPath, '必须是相对 AppRoot 的安全路径（不含 .. 、反斜杠；{app} 只能作首段）');

const entrySchema = z.object({
  entry: z.string().min(1),
  dest: relPath,
  transcode: z.literal('mp3').optional(),
}).strict();

/** 条目字段定义（未加跨字段规则），供与 JSON Schema 对账 */
export const itemFields = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9.-]*$/, 'id 只能含小写字母、数字、点、连字符'),
  kind: z.enum(KINDS),
  platform: z.enum(PLATFORMS),
  sha256: z.string().regex(SHA256, 'sha256 必须是 64 位小写十六进制'),
  size: z.number().int().positive(),
  dest: relPath,
  urls: z.array(z.string().url().startsWith('https://', 'url 必须是 https')).min(1),
  unpack: z.enum(UNPACKS).optional(),
  strip: z.number().int().min(0).max(8).optional(),
  entries: z.array(entrySchema).min(1).optional(),
  executable: z.boolean().optional(),
  exec: relPath.optional(),
  license: z.string().optional(),
}).strict();

export const itemSchema = itemFields.superRefine((it, ctx) => {
  const bad = (message) => ctx.addIssue({ code: 'custom', message });
  if (PLATFORM_BOUND.has(it.kind) && it.platform === 'any') bad(`${it.kind} 必须指定具体平台`);
  if (new Set(it.urls).size !== it.urls.length) bad('urls 有重复');
  if (it.strip !== undefined && !it.unpack) bad('strip 只能与 unpack 一起用');
  if (it.entries && !it.unpack) bad('entries 只能与 unpack 一起用');
  if (it.exec && !it.exec.startsWith(`${it.dest}/`)) bad('exec 必须位于 dest 目录之内');
  if (it.strip !== undefined && it.unpack === 'gz') bad('gz 是单文件，不支持 strip');
});

const itemsSchema = z.array(itemSchema).superRefine((items, ctx) => {
  const seen = new Set();
  for (const it of items) {
    if (seen.has(it.id)) ctx.addIssue({ code: 'custom', message: `id 重复：${it.id}` });
    seen.add(it.id);
  }
});

// 最终清单顶层：{ version: <应用版本>, items }。dest / marker.path 里的 {app} 由启动器展开为 app/<version>
export const manifestSchema = z.object({
  version: z.string().regex(/^\d+\.\d+\.\d+([-+][\w.]+)?$/, 'version 必须是语义化版本'),
  items: itemsSchema,
}).strict();

export const lockSchema = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  items: itemsSchema,
}).strict();

function parseWith(schema, label, data) {
  const r = schema.safeParse(data);
  if (r.success) return r.data;
  const msg = r.error.issues.map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`).join('；');
  throw new Error(`${label}校验失败：${msg}`);
}

/** 校验最终清单（dist/manifest.json） */
export function validateManifest(data) {
  return parseWith(manifestSchema, '清单', data);
}

/** 校验锁定清单（launcher/manifest.lock.json）：允许 {app} 占位 */
export function validateLock(data) {
  return parseWith(lockSchema, '锁定清单', data);
}

/** 按平台（保留该平台与 any）和/或 kind 过滤；传入未知值直接报错 */
export function filterItems(items, { platform, kind } = {}) {
  if (platform !== undefined && !PLATFORMS.includes(platform)) throw new Error(`未知平台：${platform}（可选 ${PLATFORMS.join(' / ')}）`);
  if (kind !== undefined && !KINDS.includes(kind)) throw new Error(`未知类型：${kind}（可选 ${KINDS.join(' / ')}）`);
  return items.filter((i) => (platform === undefined || i.platform === platform || i.platform === 'any') && (kind === undefined || i.kind === kind));
}

/** 解析 `--app <platform>=<path>`（可多次） */
export function parseAppSpecs(specs) {
  const out = [];
  for (const spec of specs) {
    const eq = spec.indexOf('=');
    const platform = eq > 0 ? spec.slice(0, eq) : '';
    const path = eq > 0 ? spec.slice(eq + 1) : '';
    if (!PLATFORMS.includes(platform) || platform === 'any' || !path) {
      throw new Error(`--app 格式应为 <platform>=<tar.zst 路径>，platform 取 darwin-arm64 / darwin-x64 / win32-x64：${spec}`);
    }
    if (out.some((o) => o.platform === platform)) throw new Error(`--app 平台重复：${platform}`);
    out.push({ platform, path });
  }
  return out;
}

export async function sha256File(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** 把本地 app 压缩包变成 app 条目；url 指向 GitHub Release（<repo>/releases/download/v<ver>/<文件名>） */
export async function makeAppItem({ platform, path }, { appVersion, repoUrl = DEFAULT_RELEASE_REPO }) {
  return {
    id: `app-${platform}`,
    kind: 'app',
    platform,
    sha256: await sha256File(path),
    size: statSync(path).size,
    dest: APP_PLACEHOLDER,
    unpack: 'tar.zst',
    urls: [`${repoUrl}/releases/download/v${appVersion}/${basename(path)}`],
  };
}

/** 锁定清单 + 已生成的 app 条目 → 最终清单，按安装顺序排列；{app} 占位原样保留，由启动器展开 */
export function buildManifest(lock, { appVersion, appItems = [] }) {
  const items = [...lock.items.filter((i) => i.kind !== 'app'), ...appItems];
  items.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
  return { version: appVersion, items };
}

/** 同 buildManifest，但 app 条目由本地压缩包现场计算 sha256 / size */
export async function buildManifestWithApps(lock, { appVersion, apps, repoUrl }) {
  const appItems = await Promise.all(apps.map((a) => makeAppItem(a, { appVersion, repoUrl })));
  return buildManifest(lock, { appVersion, appItems });
}

export const isGithubUrl = (url) => ['github.com', 'raw.githubusercontent.com'].includes(new URL(url).hostname);

const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
/** 连续这么久没收到数据就判定卡死（个别镜像会中途停住不断开） */
const IDLE_TIMEOUT_MS = 45_000;
const HEADERS = { 'user-agent': 'mingzhi-manifest/1' };

/** 流式下载并计算 sha256 与字节数，不落盘。Node 内置 fetch 走代理需 NODE_USE_ENV_PROXY=1 */
export async function hashUrl(url, { fetch: fetchImpl = fetch, timeoutMs = DOWNLOAD_TIMEOUT_MS, idleMs = IDLE_TIMEOUT_MS, onProgress } = {}) {
  const ctl = new AbortController();
  const total = setTimeout(() => ctl.abort(new Error('总超时')), timeoutMs);
  let idle = setTimeout(() => ctl.abort(new Error(`${idleMs / 1000}s 没有收到数据`)), idleMs);
  const poke = () => {
    clearTimeout(idle);
    idle = setTimeout(() => ctl.abort(new Error(`${idleMs / 1000}s 没有收到数据`)), idleMs);
  };
  try {
    const res = await fetchImpl(url, { headers: HEADERS, signal: ctl.signal });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of res.body) {
      poke();
      hash.update(chunk);
      size += chunk.length;
      onProgress?.(size);
    }
    return { sha256: hash.digest('hex'), size };
  } catch (e) {
    throw ctl.signal.aborted && ctl.signal.reason instanceof Error ? ctl.signal.reason : e;
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

/** 逐个下载条目的每个 url 并核对；返回每个 url 的结果，不抛出 */
export async function verifyItem(item, { fetch: fetchImpl = fetch, onProgress, timeoutMs } = {}) {
  const results = [];
  for (const url of item.urls) {
    const started = Date.now();
    try {
      const { sha256, size } = await hashUrl(url, { fetch: fetchImpl, onProgress: onProgress && ((n) => onProgress(url, n)), timeoutMs });
      const seconds = (Date.now() - started) / 1000;
      const errors = [];
      if (sha256 !== item.sha256) errors.push(`sha256 不符：期望 ${item.sha256}，实际 ${sha256}`);
      if (size !== item.size) errors.push(`size 不符：期望 ${item.size}，实际 ${size}`);
      results.push({ url, ok: errors.length === 0, sha256, size, seconds, ...(errors.length ? { error: errors.join('；') } : {}) });
    } catch (e) {
      results.push({ url, ok: false, seconds: (Date.now() - started) / 1000, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}
