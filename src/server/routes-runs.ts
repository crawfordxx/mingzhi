import { planEdit } from '../edit/plan.js';
import { validateOps } from '../edit/validate.js';
import { estimateCost, formatEstimate } from '../cost/estimate.js';
import { CostMeter } from '../cost/meter.js';
import { loadPricesOrEmpty, type AppCtx } from './context.js';
import { exportVersion } from './export.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { doneVersion, loadSpace, parseVersionNumber, pickParent, readState } from './lookup.js';
import { requireKey } from './keys.js';
import { route, type Route, type RouteCtx } from './router.js';
import { handleEvents } from './sse.js';
import { round4, saveSpace } from './spaces.js';

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_OPS = 20;
const MAX_SUMMARY_CHARS = 80;
const DEFAULT_SUMMARY = '对话修改';

async function estimate(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  if (space.inputs.length === 0) throw new HttpError(400, '还没有上传口播视频');
  const infos = await Promise.all(space.inputs.map((p) => app.deps.probe(p))).catch(() => {
    throw new HttpError(500, '读取口播视频时长失败，请重新上传');
  });
  const { settings } = space;
  const durationSec = infos.reduce((s, i) => s + i.durationSec, 0);
  const est = estimateCost({
    durationSec, bgPrompt: settings.background?.kind === 'prompt',
    broll: settings.broll, maxVideos: settings.maxVideos, qa: true, cover: true,
  });
  sendJson(c.res, 200, { ...est, durationSec, budgetYuan: settings.budgetYuan, text: formatEstimate(est, settings.budgetYuan) });
}

async function start(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  if (space.inputs.length === 0) throw new HttpError(400, '还没有上传口播视频');
  // 运行器暂只支持一段口播（Task 9 支持多段后删掉这一行）
  if (space.inputs.length > 1) throw new HttpError(400, '暂只支持一段口播视频，请先删掉多余的');
  if (space.versions.some((v) => v.status === 'done')) throw new HttpError(409, '已经出过片了，请在对话里提出修改');
  const { version, ahead } = await app.runs.submit(space.id, { kind: 'first' });
  sendJson(c.res, 202, { version, queued: ahead });
}

async function messages(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const body = await readJsonBody(c.req);
  const message = typeof body.message === 'string' ? body.message.trim() : '';
  if (!message) throw new HttpError(400, '请先说说想改什么');
  if ([...message].length > MAX_MESSAGE_CHARS) throw new HttpError(400, `消息太长了（最多 ${MAX_MESSAGE_CHARS} 字）`);
  const version = pickParent(space, body.version);
  const key = await requireKey(app);
  const state = readState(app, space.id, version);
  const meter = new CostMeter(await loadPricesOrEmpty(app.deps, key), Number.POSITIVE_INFINITY);
  let plan: Awaited<ReturnType<typeof planEdit>>;
  try {
    plan = await planEdit(app.deps.planClient(key, meter), message, state);
  } catch (err) {
    addChatCost(app, space.id, meter.total); // 模型已经调用过，失败也要记账
    throw new HttpError(502, app.keys.redact(err instanceof Error ? err.message : String(err)));
  }
  const chatCostYuan = addChatCost(app, space.id, meter.total);
  sendJson(c.res, 200, { ...plan, version, costYuan: round4(meter.total), chatCostYuan });
}

/** 把一次对话的花费并入项目的 chatCostYuan（重新读项目，不覆盖期间别处的修改）；返回累计值 */
function addChatCost(app: AppCtx, id: string, yuan: number): number {
  const space = app.store.get(id);
  const total = round4((space.chatCostYuan ?? 0) + yuan);
  if (yuan > 0) saveSpace(app, { ...space, chatCostYuan: total });
  return total;
}

async function apply(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const body = await readJsonBody(c.req);
  if (!Array.isArray(body.ops) || body.ops.length === 0) throw new HttpError(400, 'ops 必须是非空数组');
  if (body.ops.length > MAX_OPS) throw new HttpError(400, `一次最多执行 ${MAX_OPS} 个操作`);
  const parent = pickParent(space, body.parent);
  const { ops, dropped } = validateOps(body.ops, readState(app, space.id, parent));
  if (ops.length === 0) throw new HttpError(400, `没有可执行的修改：${dropped.join('；')}`);
  const summary = typeof body.summary === 'string' && body.summary.trim() ? [...body.summary.trim()].slice(0, MAX_SUMMARY_CHARS).join('') : DEFAULT_SUMMARY;
  const { version, ahead } = await app.runs.submit(space.id, { kind: 'next', parent, ops, summary });
  sendJson(c.res, 202, { version, queued: ahead, dropped });
}

async function revert(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const n = doneVersion(space, parseVersionNumber(c.params.n)).n;
  const { version, ahead } = await app.runs.submit(space.id, { kind: 'next', parent: n, ops: [], summary: `回退到 v${n}` });
  sendJson(c.res, 202, { version, queued: ahead });
}

function cancel(app: AppCtx, c: RouteCtx): void {
  loadSpace(app, c.params.id);
  if (!app.runs.cancel(c.params.id)) throw new HttpError(409, '这个项目现在没有可取消的任务');
  sendJson(c.res, 200, { cancelled: true });
}

async function exportRoute(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const n = doneVersion(space, parseVersionNumber(c.params.n)).n;
  try {
    const files = await exportVersion(app.exportDir, space.title, n, app.store.versionDir(space.id, n));
    sendJson(c.res, 200, { dir: app.exportDir, files });
  } catch (err) {
    throw new HttpError(500, `导出失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

export function runRoutes(app: AppCtx): Route[] {
  return [
    route('GET', 'api/spaces/:id/estimate', (c) => estimate(app, c)),
    route('POST', 'api/spaces/:id/start', (c) => start(app, c)),
    route('POST', 'api/spaces/:id/messages', (c) => messages(app, c)),
    route('POST', 'api/spaces/:id/apply', (c) => apply(app, c)),
    route('POST', 'api/spaces/:id/cancel', (c) => cancel(app, c)),
    route('GET', 'api/spaces/:id/events', (c) => handleEvents(app, c)),
    route('GET', 'api/spaces/:id/versions/:n/state', (c) => sendJson(c.res, 200, readState(app, c.params.id, doneVersion(loadSpace(app, c.params.id), parseVersionNumber(c.params.n)).n))),
    route('POST', 'api/spaces/:id/versions/:n/revert', (c) => revert(app, c)),
    route('POST', 'api/spaces/:id/versions/:n/export', (c) => exportRoute(app, c)),
  ];
}
