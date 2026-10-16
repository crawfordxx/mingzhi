// 应用本体烟测（CI 在启动器解包之后跑；本机也可用）：
//   node scripts/smoke-app.mjs <应用目录> [--port 4391] [--chrome <Chrome Headless Shell 可执行文件>]
// 1. 原生模块能加载：onnxruntime-node、sherpa-onnx-node，且有本平台的 @remotion/compositor-*
// 2. 只靠包里的依赖起服务：`node --import tsx src/server/index.ts`（cwd = 应用目录，数据目录用临时目录），
//    读到「已启动：URL」后 GET /api/status 与首页都要 200
// 3. 给了 --chrome 时走渲染链路：包内 Remotion bundle() 打包 render/，经 MINGZHI_CHROME 用这个 Chrome 渲染一张
//    标题卡静帧，断言 PNG 是 1080×960，且 Remotion 没有自己往 node_modules/.remotion 下载浏览器
// 用的是当前 node（CI 里是 setup-node 装的、与清单同版本的 Node 22），不是启动器下载的那份运行时。
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: opts, positionals } = parseArgs({ options: { port: { type: 'string' }, chrome: { type: 'string' } }, allowPositionals: true, strict: true });
if (positionals.length !== 1) {
  console.error('用法：node scripts/smoke-app.mjs <应用目录> [--port 4391] [--chrome <可执行文件>]');
  process.exit(2);
}
const appDir = resolve(positionals[0]);
const port = opts.port ?? '4391';
const READY_TIMEOUT_MS = 120_000;
const READY = /已启动：(http:\/\/127\.0\.0\.1:\d+)/;

function checkNative() {
  const compositor = readdirSync(join(appDir, 'node_modules', '@remotion')).filter((n) => n.startsWith('compositor-'));
  if (compositor.length !== 1) throw new Error(`@remotion/compositor-* 应恰好 1 个，实际：${compositor.join(', ') || '无'}`);
  const code = "const r = require('node:module').createRequire(process.cwd() + '/package.json'); r('onnxruntime-node'); r('sherpa-onnx-node'); console.log('原生模块加载正常');";
  const res = spawnSync(process.execPath, ['-e', code], { cwd: appDir, encoding: 'utf8' });
  if (res.status !== 0) throw new Error(`原生模块加载失败：\n${res.stderr}`);
  console.log(`${res.stdout.trim()}；@remotion/${compositor[0]}`);
}

function startServer(dataDir) {
  const t0 = Date.now();
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/server/index.ts'], {
    cwd: appDir,
    env: { ...process.env, MINGZHI_DATA_DIR: dataDir, MINGZHI_PORT: port },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  const url = new Promise((ok, fail) => {
    const timer = setTimeout(() => fail(new Error(`${READY_TIMEOUT_MS / 1000} 秒内没有启动`)), READY_TIMEOUT_MS);
    const onData = (chunk) => {
      log += chunk;
      const m = READY.exec(log);
      if (m) {
        clearTimeout(timer);
        ok(m[1]);
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', (code) => {
      clearTimeout(timer);
      fail(new Error(`服务提前退出（${code}）`));
    });
  });
  return { child, url, since: () => `${((Date.now() - t0) / 1000).toFixed(1)}s`, log: () => log };
}

async function expectOk(url) {
  const res = await fetch(url);
  if (res.status !== 200) throw new Error(`${url} 返回 ${res.status}`);
  return res;
}

const CARD = { width: 1080, height: 960 };
const RENDER_TIMEOUT_MS = 300_000;
// 在应用目录里（cwd + --import tsx）调用包内的 renderCardStill
const RENDER_SCRIPT = `import { pathToFileURL } from 'node:url';
const [appDir, workDir, output] = process.argv.slice(2);
const { renderCardStill } = await import(pathToFileURL(appDir + '/src/compose/render.ts').href);
await renderCardStill({ workDir, output, card: { template: 'title', props: { title: '烟测' } } });
`;

/** PNG 的宽高（IHDR） */
function pngSize(buf) {
  if (buf.length < 24 || buf.toString('latin1', 1, 4) !== 'PNG') throw new Error('输出不是 PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

function checkRender(chrome) {
  if (!existsSync(chrome)) throw new Error(`Chrome 不存在：${chrome}`);
  const tmp = mkdtempSync(join(tmpdir(), 'mingzhi-render-'));
  try {
    const script = join(tmp, 'render.mjs');
    const output = join(tmp, 'card.png');
    writeFileSync(script, RENDER_SCRIPT);
    const t0 = Date.now();
    const res = spawnSync(process.execPath, ['--import', 'tsx', script, appDir, tmp, output], {
      cwd: appDir, env: { ...process.env, MINGZHI_CHROME: chrome }, encoding: 'utf8', timeout: RENDER_TIMEOUT_MS,
    });
    if (res.status !== 0) throw new Error(`渲染失败（${res.status ?? res.signal}）：\n${res.stdout}\n${res.stderr}`);
    const size = pngSize(readFileSync(output));
    if (size.width !== CARD.width || size.height !== CARD.height) throw new Error(`静帧尺寸 ${size.width}×${size.height}，应为 ${CARD.width}×${CARD.height}`);
    if (existsSync(join(appDir, 'node_modules', '.remotion'))) throw new Error('Remotion 自己下载了浏览器（没有用 MINGZHI_CHROME）');
    console.log(`渲染链路正常：bundle() + MINGZHI_CHROME 出标题卡 ${size.width}×${size.height}（${((Date.now() - t0) / 1000).toFixed(1)}s）`);
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
}

async function main() {
  if (!existsSync(join(appDir, 'src', 'server', 'index.ts'))) throw new Error(`${appDir} 下没有 src/server/index.ts`);
  checkNative();
  const dataDir = mkdtempSync(join(tmpdir(), 'mingzhi-smoke-'));
  const server = startServer(dataDir);
  try {
    const base = await server.url;
    console.log(`服务已启动：${base}（${server.since()}）`);
    const status = await (await expectOk(`${base}/api/status`)).json();
    console.log(`/api/status 200：${JSON.stringify(status).slice(0, 200)}`);
    const html = await (await expectOk(`${base}/`)).text();
    if (!html.includes('<div id="root"')) throw new Error('首页不是工作台');
    console.log('首页 200');
  } catch (e) {
    console.error(server.log());
    throw e;
  } finally {
    server.child.removeAllListeners('exit');
    server.child.kill();
    rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  }
  if (opts.chrome) checkRender(resolve(opts.chrome));
  else console.log('未给 --chrome，跳过渲染链路');
  console.log('烟测通过');
}

main().catch((e) => {
  console.error(`烟测失败：${e.message}`);
  process.exit(1);
});
