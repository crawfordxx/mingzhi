// 生成 THIRD_PARTY_NOTICES.md：启动器二进制里静态链接的 Rust 库（来自 launcher/Cargo.lock）及其许可全文。
//   node scripts/third-party-notices.mjs [--out dist/THIRD_PARTY_NOTICES.md]
// 需要 cargo（会按 Cargo.lock 取各库的源码来读 LICENSE 文件）。内容相同的许可全文只写一份。
// 随启动器分发的其它组件（FFmpeg、模型、字体等）的许可见 README「许可证」一节与启动器进度页「关于」。
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LICENSE_FILE = /^(LICEN[CS]E|COPYING|NOTICE|UNLICENSE)/i;

/** 取一个库目录下的许可文件：[{ file, text }] */
export function readLicenseFiles(dir) {
  return readdirSync(dir)
    .filter((f) => LICENSE_FILE.test(f) && statSync(join(dir, f)).isFile())
    .sort()
    .map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8').trim() }));
}

const HEADER = `# 第三方许可声明（启动器）

明知AI剪辑启动器（\`mingzhi-launcher\`）是 MIT 许可。它静态链接了下面这些 Rust 库，各自的许可如下。
这份清单由 \`launcher/Cargo.lock\` 生成，包含其它平台才会用到的库（如 Windows 专用的 windows-sys），所以可能比你这个平台的二进制里实际带的多。

随启动器下载的其它组件（FFmpeg、Chrome Headless Shell、Node.js、SenseVoice 等模型、字体、配乐、音效）的许可见项目 README「许可证」一节：https://github.com/crawfordxx/mingzhi#许可证

This file lists the Rust crates statically linked into the launcher binary, generated from \`launcher/Cargo.lock\`, with their license texts. Components the launcher downloads at runtime (FFmpeg, Chrome Headless Shell, Node.js, models, fonts, music, sound effects) are covered in the License section of the project README.
`;

/**
 * @param packages cargo metadata 的 packages（已去掉根包）
 * @param read     (dir) => [{ file, text }]，可注入便于测试
 */
export function renderNotices(packages, read = readLicenseFiles) {
  const sorted = [...packages].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
  const texts = new Map(); // sha -> { text, crates: [] }
  const table = [];
  for (const p of sorted) {
    const id = `${p.name} ${p.version}`;
    table.push(`| ${p.name} | ${p.version} | ${p.license ?? '见许可文件'} | ${p.repository ?? ''} |`);
    for (const { text } of read(dirname(p.manifest_path))) {
      if (!text) continue;
      const sha = createHash('sha256').update(text).digest('hex');
      const entry = texts.get(sha) ?? { text, crates: [] };
      entry.crates.push(id);
      texts.set(sha, entry);
    }
  }
  const sections = [...texts.values()].map(({ text, crates }, i) => (
    `### 许可文本 ${i + 1}\n\n适用于：${crates.join('、')}\n\n\`\`\`text\n${text}\n\`\`\``
  ));
  return [
    HEADER,
    '## 库清单\n',
    '| 库 | 版本 | 许可 | 仓库 |\n| --- | --- | --- | --- |',
    ...table,
    '',
    '## 许可全文\n',
    sections.join('\n\n'),
    '',
  ].join('\n');
}

function cargoPackages() {
  const raw = execFileSync(
    'cargo',
    ['metadata', '--format-version', '1', '--locked', '--manifest-path', join(ROOT, 'launcher', 'Cargo.toml')],
    { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 },
  );
  const meta = JSON.parse(raw);
  const roots = new Set(meta.workspace_members);
  return meta.packages.filter((p) => !roots.has(p.id));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const { values } = parseArgs({ options: { out: { type: 'string' } }, strict: true });
  const out = values.out ?? join(ROOT, 'dist', 'THIRD_PARTY_NOTICES.md');
  const packages = cargoPackages();
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, renderNotices(packages));
  console.log(`已生成 ${out}（${packages.length} 个库）`);
}
