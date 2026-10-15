import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError } from '../src/cancel.js';
import { loadConfig } from '../src/config.js';
import { startApp, type RunningApp } from '../src/server/app.js';
import type { AppDeps } from '../src/server/context.js';
import type { KeyStore } from '../src/workspace/keychain.js';
import type { RunnerCtx } from '../src/workspace/runner.js';
import { makeState } from './helpers/edit-state.js';

export const GOOD_KEY = 'sk-goodkey1234567890';

export function memoryKeyStore(initial: string | null = null): KeyStore & { value: () => string | null } {
  let value = initial;
  return { get: async () => value, set: async (k) => { value = k; }, clear: async () => { value = null; }, value: () => value };
}

/** 假运行器的可控开关：gate 不为空时运行器会等它；每次启动记下 (kind, ops) */
export interface RunControl {
  gate?: Promise<void>;
  calls: { kind: 'first' | 'next'; parent?: number; ops?: unknown[]; summary?: string }[];
  failWith?: string;
}

async function fakeRun(ctx: RunnerCtx, id: string, meta: { parent?: number; summary: string }, control: RunControl): Promise<ReturnType<RunnerCtx['store']['addVersion']>> {
  const v = ctx.store.addVersion(id, { ...meta, changedShots: [], costYuan: 0.5, status: 'running' });
  const dir = ctx.store.versionDir(id, v.n);
  const emit = (step: 'probe' | 'done', message: string): void => { ctx.bus.publish({ t: Date.now(), spaceId: id, version: v.n, step, message }); };
  emit('probe', '开始');
  try {
    if (control.gate) await control.gate;
    if (ctx.signal?.aborted) throw new CancelledError();
    if (control.failWith) throw new Error(control.failWith);
  } catch (err) {
    ctx.store.updateVersion(id, v.n, { status: 'failed' });
    throw err;
  }
  writeFileSync(join(dir, 'final.mp4'), Buffer.alloc(1000, 7));
  writeFileSync(join(dir, 'cover-3x4.png'), 'png34');
  writeFileSync(join(dir, 'cover-4x3.png'), 'png43');
  writeFileSync(join(dir, 'state.json'), JSON.stringify(makeState()));
  const done = ctx.store.updateVersion(id, v.n, { status: 'done' });
  emit('done', join(dir, 'final.mp4'));
  return done;
}

export interface TestApp extends RunningApp {
  root: string;
  keyStore: ReturnType<typeof memoryKeyStore>;
  control: RunControl;
  exportDir: string;
  webDir: string;
  call: (method: string, path: string, body?: unknown, headers?: Record<string, string>) => Promise<{ status: number; json: any; headers: Headers; text: string }>;
}

export interface TestOptions { key?: string | null; env?: string; devPort?: number; deps?: Partial<AppDeps> }

/** 起一个随机端口的服务：外部依赖（校验 key、探测视频、运行器、预览渲染）全是假的，数据放临时目录 */
export async function startTestApp(o: TestOptions = {}): Promise<TestApp> {
  const root = mkdtempSync(join(tmpdir(), 'mz-server-'));
  const webDir = join(root, 'web');
  mkdirSync(join(webDir, 'assets'), { recursive: true });
  writeFileSync(join(webDir, 'index.html'), '<!doctype html><title>明知</title>');
  writeFileSync(join(webDir, 'assets', 'app.js'), 'console.log(1)');
  const exportDir = join(root, 'export');
  const keyStore = memoryKeyStore(o.key ?? null);
  const control: RunControl = { calls: [] };
  const cfg = { ...loadConfig({}), dataDir: join(root, 'data'), kexiangKey: o.env };
  const running = await startApp({
    cfg, keyStore, webDir, exportDir, devPort: o.devPort,
    deps: {
      validateKey: async (k) => {
        if (k === 'neterr') throw new Error('无法校验 key：网络错误');
        return k === GOOD_KEY;
      },
      probe: async (p) => {
        if (readFileSync(p).toString('latin1', 0, 3) === 'bad') throw new Error('ffprobe 失败');
        return { durationSec: 12, width: 1080, height: 1920, fps: 30, hasAudio: true };
      },
      loadPrices: async () => ({}),
      runFirst: (ctx, id) => { control.calls.push({ kind: 'first' }); return fakeRun(ctx, id, { summary: '首个版本' }, control); },
      runNext: (ctx, id, parent, ops, summary) => { control.calls.push({ kind: 'next', parent, ops, summary }); return fakeRun(ctx, id, { parent, summary }, control); },
      makeThumb: async (src, dest) => { mkdirSync(join(dest, '..'), { recursive: true }); copyFileSync(src, dest); },
      renderCaptionPreview: async (id, dest) => { mkdirSync(join(dest, '..'), { recursive: true }); writeFileSync(dest, `preview-${id}`); },
      ...o.deps,
    },
  }, 0);
  const call: TestApp['call'] = async (method, path, body, headers = {}) => {
    const res = await fetch(`${running.url}${path}`, {
      method, headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const text = await res.text();
    let json: unknown;
    try { json = JSON.parse(text); } catch { json = undefined; }
    return { status: res.status, json, headers: res.headers, text };
  };
  return { ...running, root, keyStore, control, exportDir, webDir, call };
}

/** 创建项目并上传一段假视频（内容 'ok…'，假 probe 认可），返回项目 id */
export async function spaceWithInput(t: TestApp, body: Record<string, unknown> = {}): Promise<string> {
  const created = await t.call('POST', '/api/spaces', body);
  const id = created.json.id as string;
  const up = await fetch(`${t.url}/api/spaces/${id}/inputs`, { method: 'POST', headers: { 'x-filename': encodeURIComponent('口播.mp4') }, body: Buffer.from('ok-video-bytes') });
  if (up.status !== 201) throw new Error(`上传失败 ${up.status} ${await up.text()}`);
  return id;
}

export async function waitFor(check: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('等待超时');
}
