// 打应用本体包 dist/mingzhi-app-<platform>.tar.zst（启动器解到 app/<版本>/，用 `node --import tsx src/server/index.ts` 启动）。
//   node scripts/bundle-app.mjs [--out-dir dist] [--level 19] [--keep-staging]
// 先 `pnpm build:web`。只能打当前平台的包（原生模块随平台）：在临时目录里放 src/ render/ assets/ web/dist 等，
// `pnpm install --prod --frozen-lockfile`（hoisted 布局，无符号链接），剪掉测试 / source map / 类型声明 / 文档 / 其它平台二进制，
// 按启动器同一套严格文件名规则自检，最后写 tar.zst 并输出 sha256 与大小。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { APP_ENTRIES, MAX_ENTRIES, collectEntries, currentPlatform, unpackBudget, writeTarZst } from './bundle-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const { values: opts } = parseArgs({
  options: { 'out-dir': { type: 'string' }, level: { type: 'string' }, 'keep-staging': { type: 'boolean' } },
  strict: true,
});

const mb = (n) => `${(n / 1048576).toFixed(1)}MB`;
const elapsed = (t) => `${((Date.now() - t) / 1000).toFixed(1)}s`;

/** 把仓库里的应用文件复制到 staging（web/dist 必须已构建） */
function assemble(staging) {
  if (!existsSync(join(ROOT, 'web', 'dist', 'index.html'))) throw new Error('web/dist 不存在，先运行 pnpm build:web');
  for (const rel of APP_ENTRIES) {
    const src = join(ROOT, rel);
    if (!existsSync(src)) throw new Error(`缺少 ${rel}`);
    cpSync(src, join(staging, rel), { recursive: true, filter: (p) => basename(p) !== '.DS_Store' });
  }
}

/** 只装生产依赖；hoisted 布局让 node_modules 是普通目录（启动器在 Windows 上不解符号链接）；不跑安装脚本（各平台原生包自带二进制） */
function installProd(staging) {
  execFileSync('pnpm', ['install', '--prod', '--frozen-lockfile', '--ignore-scripts', '--config.node-linker=hoisted', '--config.confirmModulesPurge=false'], {
    cwd: staging, stdio: 'inherit', shell: process.platform === 'win32',
  });
}

function printProblems(problems) {
  console.error(`\n文件名自检未通过：${problems.length} 处（启动器按 Windows 严格规则拒绝这些路径，三个平台都会装不上）`);
  for (const p of problems.slice(0, 50)) console.error(`  ${p.path}\n      ${p.reason}`);
  if (problems.length > 50) console.error(`  …… 另有 ${problems.length - 50} 处`);
  console.error([
    '处理办法：',
    '  1. 运行时用不到的文件/目录（文档、测试、示例、其它平台的二进制）→ 在 scripts/bundle-lib.mjs 的 keepPath 里剪掉；',
    '  2. 运行时需要且无法改名 → 用 pnpm patch 改名并同步改引用，或换掉这个依赖；',
    '  3. 只差大小写的重名 → 删掉其中运行时用不到的一个（同样在 keepPath 里）；',
    '  4. 符号链接 → 确认 pnpm 用的是 node-linker=hoisted，且没有包自带符号链接。',
  ].join('\n'));
}

/** node_modules 顶层各包的体积（打印最大的几个，便于控制包体积） */
function topPackages(entries, n = 12) {
  const sizes = new Map();
  for (const e of entries) {
    const parts = e.path.split('/');
    if (parts[0] !== 'node_modules' || e.type !== 'file' || parts.length < 3) continue;
    const name = parts[1].startsWith('@') ? `${parts[1]}/${parts[2]}` : parts[1];
    sizes.set(name, (sizes.get(name) ?? 0) + e.size);
  }
  return [...sizes].sort((a, b) => b[1] - a[1]).slice(0, n);
}

async function main() {
  const t0 = Date.now();
  const platform = currentPlatform();
  const outDir = resolve(opts['out-dir'] ?? join(ROOT, 'dist'));
  const out = join(outDir, `mingzhi-app-${platform}.tar.zst`);
  const level = Number(opts.level ?? 19);
  const work = mkdtempSync(join(tmpdir(), 'mingzhi-bundle-'));
  const staging = join(work, 'app');
  mkdirSync(staging);
  try {
    assemble(staging);
    installProd(staging);
    const { entries, problems } = collectEntries(staging, platform);
    if (problems.length) {
      printProblems(problems);
      process.exitCode = 1;
      return;
    }
    if (entries.length >= MAX_ENTRIES) throw new Error(`条目 ${entries.length} 个，超过启动器上限 ${MAX_ENTRIES}`);
    console.log(`文件名自检通过：${entries.length} 个条目（启动器上限 ${MAX_ENTRIES}），最长路径 ${Math.max(...entries.map((e) => e.path.length))} 字符`);

    const t1 = Date.now();
    mkdirSync(outDir, { recursive: true });
    const stats = await writeTarZst(staging, entries, out, { level });
    if (stats.bytes > unpackBudget(stats.size)) {
      throw new Error(`解压后 ${mb(stats.bytes)} 超过启动器上限 ${mb(unpackBudget(stats.size))}（压缩包 ×20 或 512MB）`);
    }
    const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex');
    writeFileSync(`${out}.sha256`, `${sha256}  ${basename(out)}\n`);

    console.log('\nnode_modules 最大的包：');
    for (const [name, size] of topPackages(entries)) console.log(`  ${mb(size).padStart(8)}  ${name}`);
    console.log(`\n${out}`);
    console.log(`  平台      ${platform}`);
    console.log(`  文件      ${stats.files} 个，目录 ${stats.dirs} 个，解压后 ${mb(stats.bytes)}`);
    console.log(`  压缩包    ${stats.size} 字节（${mb(stats.size)}，zstd -${level}，压缩用时 ${elapsed(t1)}）`);
    console.log(`  sha256    ${sha256}`);
    console.log(`  总用时    ${elapsed(t0)}`);
  } finally {
    if (opts['keep-staging']) console.log(`（保留了临时目录 ${staging}）`);
    else rmSync(work, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(`错误：${e.message}`);
  process.exit(1);
});
