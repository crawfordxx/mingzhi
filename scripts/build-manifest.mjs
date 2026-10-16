// 生成启动器首次运行的下载清单 dist/manifest.json。
//   node scripts/build-manifest.mjs [--out dist/manifest.json] [--app <platform>=<tar.zst>]... [--app-version X] [--release-repo URL]
//       锁定清单 launcher/manifest.lock.json（入库）+ 可选 app 条目 → 最终清单。不联网。
//   --platform <p> / --only <kind>   只输出（或只校验/更新）该平台（含 any）/该类型的条目
//   --verify        实际下载锁定清单里每个 url，核对 sha256 与 size（体积大，建议配合 --only/--platform 分批）
//   --update-lock   按 scripts/manifest-sources.mjs 下载并计算 sha256/size，写回锁定清单（url 与已知 sha256 未变的条目不重下，--force 强制重算；带过滤时被过滤的项保留旧条目）
// 下载走代理时加 NODE_USE_ENV_PROXY=1。
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import {
  DEFAULT_RELEASE_REPO, SCHEMA_VERSION, buildManifestWithApps, filterItems, hashUrl, parseAppSpecs, validateLock, validateManifest, verifyItem,
} from './manifest-lib.mjs';
import { updateLockItems } from './manifest-lock.mjs';
import { sourceItems } from './manifest-sources.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_LOCK = join(ROOT, 'launcher', 'manifest.lock.json');
const DEFAULT_OUT = join(ROOT, 'dist', 'manifest.json');

const { values: opts } = parseArgs({
  options: {
    out: { type: 'string' }, lock: { type: 'string' }, app: { type: 'string', multiple: true }, 'app-version': { type: 'string' },
    'release-repo': { type: 'string' }, platform: { type: 'string' }, only: { type: 'string' },
    verify: { type: 'boolean' }, 'update-lock': { type: 'boolean' }, force: { type: 'boolean' },
  },
  strict: true,
});

const lockPath = resolve(opts.lock ?? DEFAULT_LOCK);
const filter = { platform: opts.platform, kind: opts.only };
const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
const writeJson = (path, data) => {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  renameSync(tmp, path);
};

/** 带进度的下载计算：每 ~2 秒在同一行刷新一次速度 */
async function hashWithLog(url) {
  const started = Date.now();
  let lastLog = started;
  const r = await hashUrl(url, {
    onProgress: (n) => {
      if (Date.now() - lastLog < 2000) return;
      lastLog = Date.now();
      process.stderr.write(`\r    ${mb(n)}  ${mb(n / ((Date.now() - started) / 1000))}/s   `);
    },
  });
  process.stderr.write('\r\x1b[K');
  return { ...r, seconds: (Date.now() - started) / 1000 };
}

async function updateLock() {
  const existing = existsSync(lockPath) ? validateLock(JSON.parse(readFileSync(lockPath, 'utf8'))).items : [];
  const drafts = sourceItems();
  const wanted = new Set(filterItems(drafts, filter).map((i) => i.id));
  const hash = async (url) => {
    const got = await hashWithLog(url);
    console.log(`  完成 ${mb(got.size)}，${got.seconds.toFixed(1)}s，${mb(got.size / got.seconds)}/s，sha256 ${got.sha256}`);
    return got;
  };
  const write = (items) => writeJson(lockPath, validateLock({ schemaVersion: SCHEMA_VERSION, items }));
  const items = await updateLockItems({ drafts, existing, wanted, force: opts.force, hash, log: console.log, save: write });
  const missing = drafts.filter((d) => !items.some((i) => i.id === d.id));
  if (missing.length) console.warn(`提示：${missing.length} 项没有旧条目且被过滤，未写入锁定清单：${missing.map((m) => m.id).join('、')}`);
  write(items);
  console.log(`锁定清单已写入 ${lockPath}（${items.length} 项）`);
}

async function verifyLock() {
  const lock = validateLock(JSON.parse(readFileSync(lockPath, 'utf8')));
  const items = filterItems(lock.items, filter);
  let failed = 0;
  for (const item of items) {
    console.log(`校验 ${item.id}（${mb(item.size)}，${item.urls.length} 个 url）`);
    const results = await verifyItem(item);
    for (const r of results) {
      const speed = r.size ? `${mb(r.size / r.seconds)}/s` : '-';
      console.log(`  ${r.ok ? 'OK  ' : 'FAIL'} ${r.url}  ${r.seconds.toFixed(1)}s ${speed}${r.error ? `\n       ${r.error}` : ''}`);
      if (!r.ok) failed += 1;
    }
  }
  if (failed) throw new Error(`${failed} 个 url 校验失败`);
  console.log(`全部通过：${items.length} 项`);
}

async function build() {
  const lock = validateLock(JSON.parse(readFileSync(lockPath, 'utf8')));
  const appVersion = opts['app-version'] ?? JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).version;
  const full = await buildManifestWithApps(lock, { appVersion, apps: parseAppSpecs(opts.app ?? []), repoUrl: opts['release-repo'] ?? DEFAULT_RELEASE_REPO });
  const manifest = validateManifest({ ...full, items: filterItems(full.items, filter) });
  const out = resolve(opts.out ?? DEFAULT_OUT);
  writeJson(out, manifest);
  const total = manifest.items.reduce((s, i) => s + i.size, 0);
  console.log(`清单已写入 ${out}：${manifest.items.length} 项，共 ${mb(total)}`);
}

try {
  if (opts['update-lock']) await updateLock();
  else if (opts.verify) await verifyLock();
  else await build();
} catch (e) {
  console.error(`错误：${e.message}`);
  process.exit(1);
}
