import type { WorkEvent } from '../workspace/events.js';
import { findVersion, loadSpace, parseVersionNumber } from './lookup.js';
import { HttpError } from './http.js';
import type { AppCtx } from './context.js';
import type { RouteCtx } from './router.js';

const HEARTBEAT_MS = 15_000;

/** 默认看正在排队或运行的版本，没有就看最新版本 */
function pickVersion(app: AppCtx, id: string, raw: string | null): number {
  const space = loadSpace(app, id);
  if (raw !== null) {
    const n = parseVersionNumber(raw);
    // 排队中的版本还没建，允许订阅它即将出现的版本号
    if (app.runs.state(id)?.version !== n) findVersion(space, n);
    return n;
  }
  const active = app.runs.state(id);
  const latest = space.versions.reduce((max, v) => Math.max(max, v.n), 0);
  if (active) return active.version;
  if (latest === 0) throw new HttpError(404, '还没有版本');
  return latest;
}

/**
 * 事件直播（SSE）：先订阅，再补发已落盘的历史，之后推实时。
 * 两段都按事件 seq 去重（seq 在项目+版本内单调递增），断线重连带 Last-Event-ID 时只补它之后的。
 */
export function handleEvents(app: AppCtx, c: RouteCtx): void {
  const { req, res } = c;
  if (req.method === 'HEAD') throw new HttpError(405, '事件流不支持 HEAD 请求');
  const id = c.params.id;
  const version = pickVersion(app, id, c.query.get('version'));
  const resumeFrom = Number(req.headers['last-event-id'] ?? c.query.get('lastEventId') ?? 0);
  let last = Number.isFinite(resumeFrom) ? resumeFrom : 0;
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no',
  });
  res.write(`retry: 3000\n: connected v${version}\n\n`);
  const send = (e: WorkEvent): void => {
    if (e.version !== version || e.seq <= last) return;
    last = e.seq;
    res.write(`id: ${e.seq}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  const unsubscribe = app.bus.subscribe(id, send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  req.on('close', () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
  app.bus.history(id, version).forEach(send);
}
