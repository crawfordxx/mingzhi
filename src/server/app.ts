import { mkdirSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createKeyStore } from '../workspace/keychain.js';
import { ServerBus } from './bus.js';
import { SpaceStore } from '../workspace/store.js';
import { buildDeps, defaultExportDir, type AppCtx, type AppOptions } from './context.js';
import { serveStatic } from './media.js';
import { asHttpError, HttpError, sendJson } from './http.js';
import { KeyCache } from './keys.js';
import { findRoute, splitUrl } from './router.js';
import { buildRoutes } from './routes.js';
import { RunManager } from './runs.js';
import { guardRequest } from './security.js';

export const HOST = '127.0.0.1';
export const DEFAULT_PORT = 4321;
const PORT_TRIES = 20;
const API_PREFIXES = new Set(['api', 'media', 'thumbs', 'previews']);
const METHODS = new Set(['GET', 'HEAD', 'POST', 'PATCH', 'DELETE']);
const DEFAULT_WEB_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web', 'dist');

export interface RunningApp { url: string; port: number; app: AppCtx; close: () => Promise<void> }

/** 服务重启后，上次没跑完的版本（状态还停在 running）改记为失败，免得项目一直显示「出片中」 */
function failInterrupted(app: AppCtx): void {
  for (const space of app.store.list()) {
    for (const v of space.versions.filter((x) => x.status === 'running')) app.store.updateVersion(space.id, v.n, { status: 'failed' });
  }
}

function buildApp(opts: AppOptions, portOf: () => number): AppCtx {
  const spacesRoot = join(opts.cfg.dataDir, 'spaces');
  mkdirSync(spacesRoot, { recursive: true });
  const store = new SpaceStore(spacesRoot);
  const keyStore = opts.keyStore ?? createKeyStore(opts.cfg.dataDir);
  const keys = new KeyCache(opts.cfg, keyStore);
  const versionExists = (id: string, n: number): boolean => {
    try {
      return store.get(id).versions.some((v) => v.n === n);
    } catch {
      return true; // 读不到项目时保守处理：不删任何东西
    }
  };
  const bus = new ServerBus((id, n) => store.versionDir(id, n), (t) => keys.redact(t), versionExists);
  const runs = new RunManager(bus);
  const devPort = opts.devPort ?? (Number(process.env.MINGZHI_DEV_PORT) || undefined);
  const app: AppCtx = {
    cfg: opts.cfg, store, bus, spacesRoot, runs, keyStore, keys,
    deps: buildDeps(opts.cfg, opts.deps), webDir: opts.webDir ?? DEFAULT_WEB_DIR, exportDir: opts.exportDir ?? defaultExportDir(), devPort, port: portOf,
  };
  runs.attach(app);
  failInterrupted(app);
  return app;
}

/** 所有响应都禁止被内嵌（防点击劫持）、禁止猜测内容类型 */
const SECURITY_HEADERS: Record<string, string> = { 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "frame-ancestors 'none'", 'X-Content-Type-Options': 'nosniff' };

async function sendError(app: AppCtx, res: ServerResponse, err: unknown): Promise<void> {
  const mapped = asHttpError(err);
  const known = mapped instanceof HttpError;
  const raw = mapped instanceof Error ? mapped.message : String(mapped);
  const message = app.keys.redact(known ? raw : `服务内部出错：${raw}`);
  if (!known) console.error(message);
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, known ? mapped.status : 500, { error: message });
}

async function dispatch(app: AppCtx, routes: ReturnType<typeof buildRoutes>, req: IncomingMessage, res: ServerResponse): Promise<void> {
  guardRequest(req, { port: app.port(), devPort: app.devPort });
  const method = req.method ?? 'GET';
  if (!METHODS.has(method)) throw new HttpError(405, '不支持这个请求方法');
  const { segments, query } = splitUrl(req.url ?? '/');
  if (!segments) throw new HttpError(404, '路径不合法');
  const matched = findRoute(routes, method, segments);
  if (matched) {
    await matched.handler({ req, res, params: matched.params, query });
  } else if (API_PREFIXES.has(segments[0])) {
    throw new HttpError(404, '接口不存在');
  } else if (method === 'GET' || method === 'HEAD') {
    serveStatic(app, req, res, segments);
  } else {
    throw new HttpError(405, '不支持这个请求方法');
  }
}

/** 创建服务（未监听）。端口在 listen 之后才确定，守卫通过 port() 读取 */
export function createApp(opts: AppOptions): { server: Server; app: AppCtx } {
  let server!: Server;
  const app = buildApp(opts, () => (server.address() as AddressInfo).port);
  const routes = buildRoutes(app);
  server = createServer((req, res) => {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) res.setHeader(name, value);
    dispatch(app, routes, req, res).catch((err: unknown) => sendError(app, res, err));
  });
  server.requestTimeout = 0; // 上传大视频可能超过默认的 5 分钟（本机服务，不防慢速攻击）
  return { server, app };
}

function listenOn(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error): void => reject(err);
    server.once('error', onError);
    server.listen(port, HOST, () => {
      server.off('error', onError);
      resolve();
    });
  });
}

/** 只监听 127.0.0.1；端口被占用时顺延（port 为 0 时由系统分配，测试用） */
export async function startApp(opts: AppOptions, port: number = DEFAULT_PORT): Promise<RunningApp> {
  const { server, app } = createApp(opts);
  for (let i = 0; i < PORT_TRIES; i += 1) {
    try {
      await listenOn(server, port === 0 ? 0 : port + i);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EADDRINUSE' || i === PORT_TRIES - 1) throw err;
    }
  }
  const actual = (server.address() as AddressInfo).port;
  const close = (): Promise<void> => new Promise((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return { url: `http://${HOST}:${actual}`, port: actual, app, close };
}
