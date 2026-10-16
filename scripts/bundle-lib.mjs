// 应用本体打包（scripts/bundle-app.mjs）的纯逻辑：剪枝规则、严格文件名自检、tar.zst 写出。
// 文件名规则与启动器 launcher/src/paths.rs 的 is_safe_component 完全一致（tests/bundle-app.test.ts 会比对源码）。
import { createWriteStream, lstatSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import * as zlib from 'node:zlib';

/** 应用目录由仓库里的这些路径组成（再加上 pnpm install --prod 得到的 node_modules） */
export const APP_ENTRIES = ['src', 'render', 'assets', 'web/dist', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'LICENSE'];

/** 与 paths.rs 相同：路径组件里不允许出现的字符 */
export const UNSAFE_CHARS = ':<>"|?*';
/** 与 paths.rs 相同：Windows 保留设备名（不含扩展名部分，大小写不敏感） */
export const DEVICE_NAMES = [
  'CON', 'PRN', 'AUX', 'NUL', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8',
  'COM9', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
];

/** 与 install.rs 相同：解压总字节上限 = max(压缩包大小 × 20, 512MB)；条目数上限 50 万（unpack.rs） */
export const UNPACK_RATIO = 20;
export const MIN_UNPACK_BUDGET = 512 * 1024 * 1024;
export const MAX_ENTRIES = 500_000;
export const unpackBudget = (archiveSize) => Math.max(archiveSize * UNPACK_RATIO, MIN_UNPACK_BUDGET);

const PLATFORMS = { 'darwin-arm64': ['darwin', 'arm64'], 'darwin-x64': ['darwin', 'x64'], 'win32-x64': ['win32', 'x64'] };

/** 清单里的平台名（darwin-arm64 / darwin-x64 / win32-x64） */
export function currentPlatform(platform = process.platform, arch = process.arch) {
  const name = `${platform}-${arch}`;
  if (!PLATFORMS[name]) throw new Error(`不支持在 ${name} 上打包（只支持 ${Object.keys(PLATFORMS).join(' / ')}）`);
  return name;
}

// Rust char::is_control = Unicode Cc 类
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** 单个路径组件不合规时返回原因，合规返回 undefined */
export function nameProblem(name) {
  if (CONTROL.test(name)) return '含控制字符';
  const bad = [...UNSAFE_CHARS].find((c) => name.includes(c));
  if (bad) return `含字符 ${bad}`;
  if (name.endsWith('.')) return '以点结尾';
  if (name.endsWith(' ')) return '以空格结尾';
  const stem = name.split('.')[0].trimEnd().toUpperCase();
  if (DEVICE_NAMES.includes(stem)) return `是 Windows 设备名（${stem}）`;
  return undefined;
}

/**
 * 逐个路径检查：每个组件按严格规则（同一个坏目录只报一次，报到最短的那一级）；
 * 再找只差大小写的重名（macOS 默认文件系统与 Windows 不区分大小写，后解出的会覆盖先解出的）。
 */
export function checkNames(paths) {
  const problems = [];
  const reported = new Set();
  for (const path of paths) {
    const parts = path.split('/');
    for (let i = 0; i < parts.length; i += 1) {
      const why = nameProblem(parts[i]);
      if (!why) continue;
      const prefix = parts.slice(0, i + 1).join('/');
      if (!reported.has(prefix)) problems.push({ path: prefix, reason: `「${parts[i]}」${why}` });
      reported.add(prefix);
      break;
    }
  }
  const seen = new Map();
  for (const path of paths) {
    const key = path.toLowerCase();
    const first = seen.get(key);
    if (first !== undefined && first !== path) problems.push({ path, reason: `与 ${first} 只差大小写，在 macOS / Windows 上会互相覆盖` });
    else seen.set(key, path);
  }
  return problems;
}

const KEEP_DOC = /^(licen[cs]e|notice|copying|third[-_]?party)/i;
const ORT_BIN = /^node_modules\/onnxruntime-node\/bin\/napi-v3\/([^/]+)(?:\/([^/]+))?/;
const NM_JUNK_FILES = new Set(['.modules.yaml', '.package-lock.json', '.pnpm-workspace-state.json', '.pnpm-workspace-state-v1.json']);

/**
 * 打包时是否保留这个路径（文件或目录，posix 风格相对应用根目录）。
 * 只剪 node_modules：.bin（pnpm 的符号链接 / 命令行垫片，运行时用不到）、测试、source map、类型声明、
 * 说明文档（许可证与 NOTICE 保留）、onnxruntime-node 自带的其它平台二进制；任何位置的 .DS_Store 都去掉。
 */
export function keepPath(relPath, platform) {
  const parts = relPath.split('/');
  const base = parts.at(-1);
  if (base === '.DS_Store') return false;
  if (parts[0] !== 'node_modules') return true;
  if (parts.includes('.bin') || parts.includes('__tests__')) return false;
  if (parts.length === 2 && NM_JUNK_FILES.has(base)) return false;
  if (/\.(map|tsbuildinfo)$/.test(base) || /\.d\.[cm]?ts$/.test(base)) return false;
  if (/\.(md|markdown)$/i.test(base) && !KEEP_DOC.test(base)) return false;
  const ort = ORT_BIN.exec(relPath);
  if (ort) {
    const [os, arch] = PLATFORMS[platform];
    if (ort[1] !== os) return false;
    if (ort[2] !== undefined && ort[2] !== arch) return false;
  }
  return true;
}

/**
 * 收集应用目录里要打包的条目（按路径字典序，目录在其内容之前），同时做文件名自检。
 * 符号链接不打包而记为问题：启动器在 Windows 上会跳过符号链接，pnpm 必须用 hoisted 布局。
 */
export function collectEntries(root, platform) {
  const entries = [];
  const problems = [];
  const walk = (dir, prefix) => {
    for (const d of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${d.name}` : d.name;
      if (!keepPath(rel, platform)) continue;
      const abs = join(dir, d.name);
      if (d.isSymbolicLink()) {
        problems.push({ path: rel, reason: '是符号链接（Windows 上启动器会跳过；pnpm 需 node-linker=hoisted）' });
      } else if (d.isDirectory()) {
        entries.push({ path: rel, type: 'dir', mode: 0o755, size: 0 });
        walk(abs, rel);
      } else if (d.isFile()) {
        const st = lstatSync(abs);
        entries.push({ path: rel, type: 'file', mode: st.mode & 0o111 ? 0o755 : 0o644, size: st.size });
      } else {
        problems.push({ path: rel, reason: '不是普通文件或目录' });
      }
    }
  };
  walk(root, '');
  entries.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  problems.push(...checkNames(entries.map((e) => e.path)));
  return { entries, problems };
}

// ---- tar（ustar + PAX 长路径 / 非 ASCII 路径）----

const BLOCK = 512;
const ZERO = Buffer.alloc(BLOCK * 2);

function octal(buf, offset, len, value) {
  buf.write(`${value.toString(8).padStart(len - 1, '0')}\0`, offset, len, 'ascii');
}

function header({ name, mode, size, mtime, type }) {
  const h = Buffer.alloc(BLOCK);
  h.write(name, 0, 100, 'utf8');
  octal(h, 100, 8, mode);
  octal(h, 108, 8, 0);
  octal(h, 116, 8, 0);
  octal(h, 124, 12, size);
  octal(h, 136, 12, mtime);
  h.fill(0x20, 148, 156);
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

const pad = (n) => Buffer.alloc((BLOCK - (n % BLOCK)) % BLOCK);

/** PAX 记录 "<长度> path=<值>\n"，长度含自身位数 */
function paxRecord(key, value) {
  const body = ` ${key}=${value}\n`;
  const bodyLen = Buffer.byteLength(body);
  let len = bodyLen + 1;
  while (String(len).length + bodyLen !== len) len = String(len).length + bodyLen;
  return Buffer.from(`${len}${body}`, 'utf8');
}

function* entryBlocks(root, entry, mtime) {
  const name = entry.type === 'dir' ? `${entry.path}/` : entry.path;
  const ascii = /^[\x20-\x7e]*$/.test(name);
  let shortName = name;
  if (!ascii || Buffer.byteLength(name) > 100) {
    const pax = paxRecord('path', name);
    yield header({ name: 'PaxHeader', mode: 0o644, size: pax.length, mtime, type: 'x' });
    yield pax;
    yield pad(pax.length);
    shortName = name.replace(/[^\x20-\x7e]/g, '_').slice(-99);
  }
  if (entry.type === 'dir') {
    yield header({ name: shortName, mode: entry.mode, size: 0, mtime, type: '5' });
    return;
  }
  const data = readFileSync(join(root, ...entry.path.split('/')));
  yield header({ name: shortName, mode: entry.mode, size: data.length, mtime, type: '0' });
  yield data;
  yield pad(data.length);
}

/**
 * 把条目写成 tar.zst（先写 .tmp 再改名）。uid/gid 为 0、mtime 固定（SOURCE_DATE_EPOCH 或 0），
 * 同样的输入产出同样的字节。返回文件数、目录数、文件内容总字节数与压缩后大小。
 */
export async function writeTarZst(root, entries, out, { level = 19, mtime = Number(process.env.SOURCE_DATE_EPOCH) || 0 } = {}) {
  let bytes = 0;
  function* blocks() {
    for (const e of entries) {
      if (e.type === 'file') bytes += statSync(join(root, ...e.path.split('/'))).size;
      yield* entryBlocks(root, e, mtime);
    }
    yield ZERO;
  }
  if (typeof zlib.createZstdCompress !== 'function') throw new Error(`需要 Node 22.15 以上（内置 zstd），当前 ${process.version}`);
  const tmp = `${out}.tmp`;
  const Z = zlib.constants;
  const zstd = zlib.createZstdCompress({
    params: { [Z.ZSTD_c_compressionLevel]: level, [Z.ZSTD_c_checksumFlag]: 1 },
  });
  try {
    await pipeline(Readable.from(blocks()), zstd, createWriteStream(tmp));
    renameSync(tmp, out);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return {
    files: entries.filter((e) => e.type === 'file').length,
    dirs: entries.filter((e) => e.type === 'dir').length,
    bytes,
    size: statSync(out).size,
  };
}
