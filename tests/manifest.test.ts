// 下载清单：schema 校验、镜像顺序、平台过滤、--app 合并、坏哈希检出。全程不联网（本地小文件 + 假 fetch）。
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KINDS, PLATFORMS, UNPACKS, itemFields, validateManifest, validateLock, filterItems, parseAppSpecs,
  buildManifest, buildManifestWithApps, type ManifestItem, sha256File, hashUrl, verifyItem, isGithubUrl,
} from '../scripts/manifest-lib.mjs';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const LOCK_PATH = join(ROOT, 'launcher', 'manifest.lock.json');
const SCHEMA_PATH = join(ROOT, 'launcher', 'manifest.schema.json');
const BUILD_SCRIPT = join(ROOT, 'scripts', 'build-manifest.mjs');

const sha = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const tmp = () => mkdtempSync(join(tmpdir(), 'mz-manifest-'));
const readJson = (p: string) => JSON.parse(readFileSync(p, 'utf8'));

const goodItem = {
  id: 'model-demo', kind: 'model', platform: 'any', sha256: sha('x'), size: 1,
  dest: 'data/models/demo.onnx', urls: ['https://mirror.example/demo.onnx', 'https://origin.example/demo.onnx'],
};
const manifestOf = (items: unknown[]) => ({ version: '0.1.0', items });

/** 假 fetch：按 url 返回给定内容，缺省 404 */
function fakeFetch(files: Record<string, string | Buffer>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const body = files[String(input)];
    if (body === undefined) return new Response('nope', { status: 404 });
    return new Response(body, { status: 200 });
  }) as typeof fetch;
}

describe('清单 schema 校验', () => {
  it('合法条目通过', () => {
    expect(() => validateManifest(manifestOf([goodItem]))).not.toThrow();
  });

  it.each([
    ['缺 sha256', { ...goodItem, sha256: undefined }],
    ['sha256 不是 64 位小写十六进制', { ...goodItem, sha256: 'ABC' }],
    ['未知 kind', { ...goodItem, kind: 'font' }],
    ['未知平台', { ...goodItem, platform: 'linux-x64' }],
    ['urls 为空', { ...goodItem, urls: [] }],
    ['url 不是 https', { ...goodItem, urls: ['http://mirror.example/a'] }],
    ['url 重复', { ...goodItem, urls: ['https://a.example/x', 'https://a.example/x'] }],
    ['size 非正整数', { ...goodItem, size: 0 }],
    ['dest 为绝对路径', { ...goodItem, dest: '/etc/passwd' }],
    ['dest 含 ..', { ...goodItem, dest: 'data/../../x' }],
    ['dest 含反斜杠', { ...goodItem, dest: 'data\\models\\x' }],
    ['未知 unpack', { ...goodItem, unpack: 'rar' }],
    ['node 的平台不能是 any', { ...goodItem, kind: 'node', platform: 'any' }],
    ['strip 没有 unpack', { ...goodItem, strip: 1 }],
    ['exec 不在 dest 之内', { ...goodItem, dest: 'runtime/x', unpack: 'zip', exec: 'runtime/y/bin' }],
    ['出现未声明字段', { ...goodItem, extra: 1 }],
  ])('拒绝：%s', (_name, item) => {
    expect(() => validateManifest(manifestOf([item]))).toThrow();
  });

  it('顶层是 { version, items }：拒绝重复 id、缺 version、非语义化版本、多余顶层字段', () => {
    expect(() => validateManifest(manifestOf([goodItem, goodItem]))).toThrow(/重复/);
    expect(() => validateManifest({ items: [goodItem] })).toThrow();
    expect(() => validateManifest({ ...manifestOf([goodItem]), version: 'latest' })).toThrow();
    expect(() => validateManifest({ ...manifestOf([goodItem]), schemaVersion: 1 })).toThrow();
  });

  it('{app} 占位原样保留在最终清单里（由启动器展开为 app/<version>），且只能作首段', () => {
    expect(() => validateManifest(manifestOf([{ ...goodItem, dest: '{app}/node_modules/x' }]))).not.toThrow();
    expect(() => validateManifest(manifestOf([{ ...goodItem, dest: 'data/{app}/x' }]))).toThrow();
  });

  it('exec 写明 dest 内可执行文件的相对路径', () => {
    const chrome = { ...goodItem, kind: 'chrome', platform: 'win32-x64', dest: 'runtime/chrome/1', unpack: 'zip', strip: 1, exec: 'runtime/chrome/1/chrome-headless-shell.exe' };
    expect(() => validateManifest(manifestOf([chrome]))).not.toThrow();
  });

  it('strip 可选且为非负整数；带顶层目录的 Node 包要 strip 1', () => {
    expect(() => validateManifest(manifestOf([{ ...goodItem, unpack: 'tar.gz', strip: 1 }]))).not.toThrow();
    expect(() => validateManifest(manifestOf([{ ...goodItem, unpack: 'tar.gz', strip: -1 }]))).toThrow();
  });

  it('锁定文件允许 {app} 占位，但只能出现在首段', () => {
    const lockOf = (dest: string) => ({ schemaVersion: 1, items: [{ ...goodItem, dest }] });
    expect(() => validateLock(lockOf('{app}/node_modules/x'))).not.toThrow();
    expect(() => validateLock(lockOf('data/{app}/x'))).toThrow();
  });

  it('JSON Schema 文件与校验器的枚举、必填字段一致', () => {
    const schema = readJson(SCHEMA_PATH);
    const item = schema.$defs.item;
    expect(item.properties.kind.enum).toEqual([...KINDS]);
    expect(item.properties.platform.enum).toEqual([...PLATFORMS]);
    expect(item.properties.unpack.enum).toEqual([...UNPACKS]);
    expect(item.properties.optional.type).toBe('boolean');
    expect(Object.keys(item.properties).sort()).toEqual(Object.keys(itemFields.shape).sort());
    expect([...item.required].sort()).toEqual(['dest', 'id', 'kind', 'platform', 'sha256', 'size', 'urls']);
  });
});

describe('入库的锁定清单 launcher/manifest.lock.json', () => {
  const lock = validateLock(readJson(LOCK_PATH));
  const byKind = (k: string) => lock.items.filter((i: { kind: string }) => i.kind === k);

  it('node / ffmpeg / ffprobe / chrome 各有三个平台', () => {
    for (const kind of ['node', 'chrome']) {
      expect(byKind(kind).map((i: { platform: string }) => i.platform).sort()).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64']);
    }
    for (const id of ['ffmpeg', 'ffprobe']) {
      const ids = lock.items.filter((i: { id: string }) => i.id.startsWith(`${id}-`)).map((i: { platform: string }) => i.platform).sort();
      expect(ids).toEqual(['darwin-arm64', 'darwin-x64', 'win32-x64']);
    }
  });

  it('不含 app 条目（app 只由 --app 合并进来）', () => {
    expect(byKind('app')).toHaveLength(0);
  });

  it('Node 优先 npmmirror，其次 nodejs.org；版本钉死在 22.x', () => {
    for (const n of byKind('node')) {
      expect(n.urls[0]).toMatch(/^https:\/\/npmmirror\.com\/mirrors\/node\/v22\.\d+\.\d+\//);
      expect(n.urls[1]).toMatch(/^https:\/\/nodejs\.org\/dist\/v22\.\d+\.\d+\//);
    }
  });

  it('带顶层目录的包必须填好 strip：Node 与 Chrome 都剥 1 层，解包后路径固定', () => {
    for (const n of [...byKind('node'), ...byKind('chrome')]) expect(n.strip, n.id).toBe(1);
  });

  it('Chrome 钉死 149.0.7790.0，cdn.npmmirror.com 优先、storage.googleapis.com 其次，装进 runtime/ 并给出 exec 路径', () => {
    const byPlatform = Object.fromEntries(byKind('chrome').map((c: { platform: string }) => [c.platform, c])) as Record<string, ManifestItem>;
    const dirs = { 'darwin-arm64': 'mac-arm64', 'darwin-x64': 'mac-x64', 'win32-x64': 'win64' } as const;
    for (const [platform, cft] of Object.entries(dirs)) {
      const c = byPlatform[platform];
      expect(c.urls[0]).toBe(`https://cdn.npmmirror.com/binaries/chrome-for-testing/149.0.7790.0/${cft}/chrome-headless-shell-${cft}.zip`);
      expect(c.urls[1]).toBe(`https://storage.googleapis.com/chrome-for-testing-public/149.0.7790.0/${cft}/chrome-headless-shell-${cft}.zip`);
      expect(c.dest).toBe(`runtime/chrome-headless-shell/149.0.7790.0/${cft}`);
      expect(c.exec).toBe(`${c.dest}/chrome-headless-shell${platform === 'win32-x64' ? '.exe' : ''}`);
    }
  });

  it('GitHub 直链排在镜像之后；ffmpeg 和 ffprobe 都带可执行标记并落在 data/bin', () => {
    for (const i of lock.items) {
      const firstGithub = i.urls.findIndex(isGithubUrl);
      if (firstGithub >= 0) expect(i.urls.slice(firstGithub).every(isGithubUrl), i.id).toBe(true);
    }
    for (const i of lock.items.filter((x: { id: string }) => /^ff(mpeg|probe)-/.test(x.id))) {
      expect(i.executable, i.id).toBe(true);
      expect(i.dest).toMatch(/^data\/bin\/ff(mpeg|probe)(\.exe)?$/);
    }
  });

  it('模型和素材沿用现有目录：data/models、data/assets，且与现有清单的 sha256 一致', () => {
    const models = byKind('model');
    expect(models.map((m: { dest: string }) => m.dest).sort()).toEqual([
      'data/models/rvm_mobilenetv3_fp32.onnx',
      'data/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/model.int8.onnx',
      'data/models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/tokens.txt',
      'data/models/silero_vad.onnx',
    ]);
    const rvm = models.find((m: { id: string }) => m.id === 'model-rvm');
    expect(rvm.sha256).toBe('88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828');
    const assets = byKind('asset');
    for (const a of assets) expect(a.dest).toMatch(/^data\/assets\//);
    const fonts = readJson(join(ROOT, 'assets', 'fonts.json')).fonts;
    for (const f of fonts) expect(assets.find((a: { id: string }) => a.id === `font-${f.id}`)?.sha256, f.id).toBe(f.sha256);
    const zips = readJson(join(ROOT, 'assets', 'music.json')).zips;
    for (const [k, z] of Object.entries<{ sha256: string; url: string }>(zips)) {
      const a = assets.find((x: { id: string }) => x.id === `music-${k}`);
      expect(a.sha256).toBe(z.sha256);
      expect(a.urls).toContain(z.url);
    }
  });

  it('Node 条目带 exec：mac 为 runtime/node/bin/node，win 为 runtime/node/node.exe', () => {
    for (const n of byKind('node')) {
      expect(n.exec, n.id).toBe(n.platform === 'win32-x64' ? 'runtime/node/node.exe' : 'runtime/node/bin/node');
    }
  });

  it('素材（配乐、字体）标记 optional，核心依赖（node/ffmpeg/chrome/model）都不是 optional', () => {
    for (const i of lock.items) expect(i.optional === true, i.id).toBe(i.kind === 'asset');
  });

  it('清单里不出现分支名引用（main / master / HEAD），版本都钉死', () => {
    for (const i of lock.items) for (const url of i.urls) expect(url, `${i.id}: ${url}`).not.toMatch(/\/(main|master|HEAD)\/|@(main|master|HEAD)\//);
  });

  it('GPL 许可字段不丢：ffmpeg / ffprobe 的 license 含 GPL', () => {
    for (const i of lock.items.filter((x: { id: string }) => /^ff(mpeg|probe)-/.test(x.id))) expect(i.license, i.id).toMatch(/GPL/);
  });

  it('配乐转码依赖 ffmpeg：transcode 的输出是 data/assets/music/<id>.mp3，且同平台必有 data/bin/ffmpeg 条目、排在素材之前', () => {
    const transcoding = lock.items.filter((i: ManifestItem) => i.entries?.some((e: { transcode?: string }) => e.transcode));
    expect(transcoding.length).toBeGreaterThan(0);
    for (const i of transcoding) {
      for (const e of i.entries) expect(e.dest, i.id).toMatch(/^data\/assets\/music\/[\w.-]+\.mp3$/);
    }
    const m = buildManifest(lock, { appVersion: '0.1.0', appItems: [] });
    for (const platform of PLATFORMS.filter((p: string) => p !== 'any')) {
      const ffmpegIdx = m.items.findIndex((i: ManifestItem) => i.dest === `data/bin/ffmpeg${platform === 'win32-x64' ? '.exe' : ''}` && i.platform === platform);
      expect(ffmpegIdx, platform).toBeGreaterThanOrEqual(0);
      expect(ffmpegIdx).toBeLessThan(m.items.findIndex((i: ManifestItem) => transcoding.some((t: ManifestItem) => t.id === i.id)));
    }
  });

  it('JSON Schema 的 relPath 正则与校验器对同一批路径给出相同结论', () => {
    const re = new RegExp(readJson(SCHEMA_PATH).$defs.relPath.pattern);
    const cases = ['data/models/a.onnx', '{app}', '{app}/x', 'runtime/node', '.hidden/x', '/abs', 'a/../b', 'a\\b', 'C:/x', 'data/{app}/x', 'a//b', 'a/', './a', ''];
    for (const p of cases) {
      let valid = true;
      try { validateManifest(manifestOf([{ ...goodItem, dest: p }])); } catch { valid = false; }
      expect(re.test(p), JSON.stringify(p)).toBe(valid);
    }
  });

  it('每个 id 唯一；锁定文件可直接生成合法清单', () => {
    const m = buildManifest(lock, { appVersion: '0.1.0', appItems: [] });
    expect(() => validateManifest(m)).not.toThrow();
    expect(m.version).toBe('0.1.0');
  });
});

describe('平台与类型过滤', () => {
  const items = [
    { ...goodItem, id: 'n1', kind: 'node', platform: 'darwin-arm64' },
    { ...goodItem, id: 'n2', kind: 'node', platform: 'win32-x64' },
    { ...goodItem, id: 'm1', kind: 'model', platform: 'any' },
  ];
  it('--platform 保留该平台与 any', () => {
    expect(filterItems(items, { platform: 'darwin-arm64' }).map((i: { id: string }) => i.id)).toEqual(['n1', 'm1']);
  });
  it('--only 按 kind 过滤，可与 --platform 叠加', () => {
    expect(filterItems(items, { kind: 'node' }).map((i: { id: string }) => i.id)).toEqual(['n1', 'n2']);
    expect(filterItems(items, { kind: 'node', platform: 'win32-x64' }).map((i: { id: string }) => i.id)).toEqual(['n2']);
  });
  it('不认识的 platform / kind 直接报错，不静默返回空', () => {
    expect(() => filterItems(items, { platform: 'linux-x64' })).toThrow();
    expect(() => filterItems(items, { kind: 'font' })).toThrow();
  });
});

describe('--app 合并', () => {
  const lock = validateLock({ schemaVersion: 1, items: [{ ...goodItem, id: 'node-x', kind: 'node', platform: 'darwin-arm64', dest: '{app}/node_modules/x', unpack: 'zip' }] });

  it('解析 <platform>=<path>，拒绝格式错误、未知平台、重复平台', () => {
    expect(parseAppSpecs(['darwin-arm64=/a/b.tar.zst'])).toEqual([{ platform: 'darwin-arm64', path: '/a/b.tar.zst' }]);
    expect(() => parseAppSpecs(['darwin-arm64'])).toThrow();
    expect(() => parseAppSpecs(['linux-x64=/a'])).toThrow();
    expect(() => parseAppSpecs(['win32-x64=/a', 'win32-x64=/b'])).toThrow(/重复/);
  });

  it('未提供 --app 时清单不含 app 条目，{app} 占位保留，顶层 version 为应用版本', () => {
    const m = buildManifest(lock, { appVersion: '1.2.3', appItems: [] });
    expect(m.items.some((i: { kind: string }) => i.kind === 'app')).toBe(false);
    expect(m.items[0].dest).toBe('{app}/node_modules/x');
    expect(m.version).toBe('1.2.3');
  });

  it('提供 --app 时合并 app 条目：实际文件的 sha256/size，GitHub Release 直链，且排在最前（安装顺序）', async () => {
    const dir = tmp();
    const file = join(dir, 'mingzhi-app-darwin-arm64.tar.zst');
    writeFileSync(file, 'fake-archive-bytes');
    const apps = [{ platform: 'darwin-arm64', path: file }];
    const m = await buildManifestWithApps(lock, { appVersion: '1.2.3', apps });
    const app = m.items.find((i: { kind: string }) => i.kind === 'app');
    expect(app).toMatchObject({
      id: 'app-darwin-arm64', platform: 'darwin-arm64', unpack: 'tar.zst', dest: '{app}',
      sha256: sha('fake-archive-bytes'), size: Buffer.byteLength('fake-archive-bytes'),
      urls: ['https://github.com/crawfordxx/mingzhi/releases/download/v1.2.3/mingzhi-app-darwin-arm64.tar.zst'],
    });
    expect(m.items[0].kind).toBe('app');
    expect(() => validateManifest(m)).not.toThrow();
  });

  it('sha256File 与 crypto 结果一致', async () => {
    const f = join(tmp(), 'a.bin');
    writeFileSync(f, 'hello');
    expect(await sha256File(f)).toBe(sha('hello'));
  });
});

describe('--verify：下载每个 url 计算 sha256 与 size 并核对', () => {
  const body = 'model-bytes';
  const item = { ...goodItem, sha256: sha(body), size: Buffer.byteLength(body) };

  it('全部 url 都对时 ok', async () => {
    const f = fakeFetch({ [item.urls[0]]: body, [item.urls[1]]: body });
    const res = await verifyItem(item, { fetch: f });
    expect(res.map((r: { ok: boolean }) => r.ok)).toEqual([true, true]);
  });

  it('坏 sha 被检出，并报告实际哈希；其它 url 不受影响', async () => {
    const f = fakeFetch({ [item.urls[0]]: 'tampered!!!!', [item.urls[1]]: body });
    const res = await verifyItem(item, { fetch: f });
    expect(res[0].ok).toBe(false);
    expect(res[0].error).toMatch(/sha256/);
    expect(res[0].sha256).toBe(sha('tampered!!!!'));
    expect(res[1].ok).toBe(true);
  });

  it('size 与清单不符、HTTP 404 都算失败', async () => {
    const f = fakeFetch({ [item.urls[0]]: body });
    const bad = await verifyItem({ ...item, size: 999 }, { fetch: f });
    expect(bad[0].ok).toBe(false);
    expect(bad[0].error).toMatch(/size/);
    expect(bad[1].ok).toBe(false);
    expect(bad[1].error).toMatch(/404/);
  });

  it('网络异常被收进结果而不是抛出', async () => {
    const boom = (async () => { throw new Error('ECONNRESET'); }) as unknown as typeof fetch;
    const res = await verifyItem(item, { fetch: boom });
    expect(res.every((r: { ok: boolean }) => !r.ok)).toBe(true);
    expect(res[0].error).toMatch(/ECONNRESET/);
  });

  it('hashUrl 流式计算并回报进度', async () => {
    let last = 0;
    const r = await hashUrl(item.urls[0], { fetch: fakeFetch({ [item.urls[0]]: body }), onProgress: (n: number) => { last = n; } });
    expect(r).toEqual({ sha256: sha(body), size: Buffer.byteLength(body) });
    expect(last).toBe(Buffer.byteLength(body));
  });
});

describe('build-manifest 命令行', () => {
  it('锁定清单 + --app 生成 dist 风格的清单文件，且通过校验', () => {
    const dir = tmp();
    const app = join(dir, 'mingzhi-app-win32-x64.tar.zst');
    writeFileSync(app, 'zzz');
    const out = join(dir, 'manifest.json');
    execFileSync('node', [BUILD_SCRIPT, '--out', out, '--app-version', '9.9.9', '--app', `win32-x64=${app}`], { cwd: ROOT, stdio: 'pipe' });
    const m = validateManifest(readJson(out));
    expect(m.version).toBe('9.9.9');
    expect(m.items.filter((i: { kind: string }) => i.kind === 'app').map((i: { id: string }) => i.id)).toEqual(['app-win32-x64']);
  });

  it('--platform 只输出该平台与 any 的条目', () => {
    const out = join(tmp(), 'm.json');
    execFileSync('node', [BUILD_SCRIPT, '--out', out, '--platform', 'win32-x64'], { cwd: ROOT, stdio: 'pipe' });
    const m = readJson(out);
    expect(m.items.every((i: { platform: string }) => i.platform === 'win32-x64' || i.platform === 'any')).toBe(true);
    expect(m.items.some((i: { kind: string }) => i.kind === 'node')).toBe(true);
  });

  it('未知参数、格式错误的 --app 以非零码退出', () => {
    expect(() => execFileSync('node', [BUILD_SCRIPT, '--bogus'], { cwd: ROOT, stdio: 'pipe' })).toThrow();
    expect(() => execFileSync('node', [BUILD_SCRIPT, '--app', 'nope'], { cwd: ROOT, stdio: 'pipe' })).toThrow();
  });
});
