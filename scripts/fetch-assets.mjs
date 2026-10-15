// 下载配乐与字体到 <dataDir>/assets/{music,fonts}（dataDir 默认 ~/.mingzhi，可用 MINGZHI_DATA_DIR 覆盖）
// 配乐：下载三个 CC0 压缩包 → 取出清单里的 mp3 → ffmpeg 转码为 music/<id>.mp3 → 删除压缩包
// 字体：逐个下载到 fonts/，得意黑从压缩包里取 zipEntry
// 清单见 assets/music.json、assets/fonts.json；所有下载都校验 sha256；已存在且大于 0 字节的产物跳过
// Node 内置 fetch 默认不走系统代理；需要代理时用 NODE_USE_ENV_PROXY=1 pnpm fetch-assets
// 解压用 `tar -xOf`：macOS 与 Windows 10+ 自带的 bsdtar 都能直接读 zip，不依赖 unzip
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, createReadStream, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const REPO_ASSETS = join(dirname(fileURLToPath(import.meta.url)), '..', 'assets');
const dataDir = process.env.MINGZHI_DATA_DIR || join(homedir(), '.mingzhi');
const assets = join(dataDir, 'assets');
const dirs = { tmp: join(assets, 'tmp'), music: join(assets, 'music'), fonts: join(assets, 'fonts') };
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

// 与 src/config.ts 保持一致：优先数据目录 bin 下自带的 ffmpeg（需 libass），否则用 PATH 里的
const EXE = process.platform === 'win32' ? '.exe' : '';
const bundledFfmpeg = join(dataDir, 'bin', `ffmpeg${EXE}`);
const ffmpeg = process.env.MINGZHI_FFMPEG ?? (existsSync(bundledFfmpeg) ? bundledFfmpeg : 'ffmpeg');

const readManifest = (name) => JSON.parse(readFileSync(join(REPO_ASSETS, name), 'utf8'));
const ready = (path) => existsSync(path) && statSync(path).size > 0;

async function sha256Of(path) {
  const hash = createHash('sha256');
  await pipeline(createReadStream(path), hash);
  return hash.digest('hex');
}

/** 先下载到 <dest>.part，完整后改名；校验 sha256，不符则删除并报错 */
async function download(url, dest, sha256) {
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  const actual = await sha256Of(part);
  if (actual !== sha256) {
    rmSync(part, { force: true });
    throw new Error(`sha256 校验失败：${url}\n  期望 ${sha256}\n  实际 ${actual}`);
  }
  renameSync(part, dest);
}

/** 从 zip 里取出单个文件的内容（stdout） */
function extractEntry(zip, entry) {
  return execFileSync('tar', ['-xOf', zip, entry], { maxBuffer: 1 << 30 });
}

function transcodeMp3(input, dest) {
  const part = `${dest}.part.mp3`;
  execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', 'pipe:0', '-vn', '-ac', '2', '-ar', '44100', '-b:a', '128k', part], { input });
  renameSync(part, dest);
}

async function fetchMusic() {
  const { zips, tracks } = readManifest('music.json');
  for (const [key, zip] of Object.entries(zips)) {
    const todo = tracks.filter((t) => t.zip === key && !ready(join(dirs.music, `${t.id}.mp3`)));
    if (todo.length === 0) continue;
    const zipPath = join(dirs.tmp, `${key}.zip`);
    if (!existsSync(zipPath) || (await sha256Of(zipPath)) !== zip.sha256) await download(zip.url, zipPath, zip.sha256);
    for (const t of todo) {
      console.log(`转码 ${t.id}`);
      transcodeMp3(extractEntry(zipPath, t.entry), join(dirs.music, `${t.id}.mp3`));
    }
    rmSync(zipPath, { force: true });
  }
}

async function fetchFont(f) {
  const dest = join(dirs.fonts, f.file);
  if (ready(dest)) return;
  if (!f.zipEntry) return download(f.url, dest, f.sha256);
  const zipPath = join(dirs.tmp, `${f.id}.zip`);
  await download(f.url, zipPath, f.sha256);
  writeFileSync(`${dest}.part`, extractEntry(zipPath, f.zipEntry));
  renameSync(`${dest}.part`, dest);
  rmSync(zipPath, { force: true });
}

await fetchMusic();
for (const f of readManifest('fonts.json').fonts) await fetchFont(f);
rmSync(dirs.tmp, { recursive: true, force: true });
console.log(`素材就绪：${assets}`);
