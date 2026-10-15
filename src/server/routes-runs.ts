import { planEdit } from '../edit/plan.js';
import { validateOps } from '../edit/validate.js';
import { EDIT_PLAN_YUAN, estimateCost, formatEstimate, requiredYuan, type Estimate } from '../cost/estimate.js';
import { CostMeter, roundYuan } from '../cost/meter.js';
import type { Space } from '../workspace/store.js';
import { opsYuan, remainingYuan, requireBudget } from './budget.js';
import { loadPricesOrEmpty, type AppCtx } from './context.js';
import { exportVersion } from './export.js';
import { HttpError, readJsonBody, sendJson } from './http.js';
import { doneVersion, loadSpace, parseVersionNumber, pickParent, readState } from './lookup.js';
import { requireKey } from './keys.js';
import { route, type Route, type RouteCtx } from './router.js';
import { handleEvents } from './sse.js';
import { publicSettings } from './spaces.js';

export const MAX_MESSAGE_CHARS = 2000;
export const MAX_OPS = 20;
const MAX_SUMMARY_CHARS = 80;
const DEFAULT_SUMMARY = '对话修改';

/** 按口播总时长与当前设置估算首个版本的花费 */
async function estimateOf(app: AppCtx, space: Space): Promise<Estimate & { durationSec: number }> {
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
  return { ...est, durationSec };
}

async function estimate(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const est = await estimateOf(app, space);
  const { budgetYuan } = space.settings;
  sendJson(c.res, 200, { ...est, budgetYuan, text: formatEstimate(est, budgetYuan) });
}

async function start(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  if (space.inputs.length === 0) throw new HttpError(400, '还没有上传口播视频');
  if (space.versions.some((v) => v.status === 'done')) throw new HttpError(409, '已经出过片了，请在对话里提出修改');
  // 剪口误、字幕校对、分镜不查预算（没有它们出不了片），所以开始前先确认剩余额度够它们
  requireBudget(space, requiredYuan(await estimateOf(app, space)), '剪口误、字幕校对与分镜');
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
  requireBudget(space, EDIT_PLAN_YUAN, '一次对话规划');
  const key = await requireKey(app);
  const state = readState(app, space.id, version);
  const meter = new CostMeter(await loadPricesOrEmpty(app.deps, key), remainingYuan(space));
  let plan: Awaited<ReturnType<typeof planEdit>>;
  try {
    plan = await planEdit(app.deps.planClient(key, meter), message, state);
  } catch (err) {
    addChatCost(app, space.id, meter.total); // 模型已经调用过，失败也要记账
    throw new HttpError(502, app.keys.redact(err instanceof Error ? err.message : String(err)));
  }
  const chatCostYuan = addChatCost(app, space.id, meter.total);
  sendJson(c.res, 200, { ...plan, version, costYuan: roundYuan(meter.total), chatCostYuan });
}

/** 把一次对话的花费并入项目的 chatCostYuan（读-改-写，不覆盖期间别处的修改）；返回累计值 */
function addChatCost(app: AppCtx, id: string, yuan: number): number {
  if (yuan <= 0) return app.store.get(id).chatCostYuan ?? 0;
  return app.store.update(id, (s) => ({ ...s, chatCostYuan: roundYuan((s.chatCostYuan ?? 0) + yuan) })).chatCostYuan ?? 0;
}

async function apply(app: AppCtx, c: RouteCtx): Promise<void> {
  const space = loadSpace(app, c.params.id);
  const body = await readJsonBody(c.req);
  if (!Array.isArray(body.ops) || body.ops.length === 0) throw new HttpError(400, 'ops 必须是非空数组');
  if (body.ops.length > MAX_OPS) throw new HttpError(400, `一次最多执行 ${MAX_OPS} 个操作`);
  const parent = pickParent(space, body.parent);
  const { ops, dropped } = validateOps(body.ops, readState(app, space.id, parent));
  if (ops.length === 0) throw new HttpError(400, `没有可执行的修改：${dropped.join('；')}`);
  requireBudget(space, opsYuan(ops), '这次修改');
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

/** 版本状态：自定义背景只给文件名，不外露本机路径 */
function versionState(app: AppCtx, c: RouteCtx): void {
  const n = doneVersion(loadSpace(app, c.params.id), parseVersionNumber(c.params.n)).n;
  const state = readState(app, c.params.id, n);
  sendJson(c.res, 200, { ...state, settings: publicSettings(state.settings) });
}

export function runRoutes(app: AppCtx): Route[] {
  return [
    route('GET', 'api/spaces/:id/estimate', (c) => estimate(app, c)),
    route('POST', 'api/spaces/:id/start', (c) => start(app, c)),
    route('POST', 'api/spaces/:id/messages', (c) => messages(app, c)),
    route('POST', 'api/spaces/:id/apply', (c) => apply(app, c)),
    route('POST', 'api/spaces/:id/cancel', (c) => cancel(app, c)),
    route('GET', 'api/spaces/:id/events', (c) => handleEvents(app, c)),
    route('GET', 'api/spaces/:id/versions/:n/state', (c) => versionState(app, c)),
    route('POST', 'api/spaces/:id/versions/:n/revert', (c) => revert(app, c)),
    route('POST', 'api/spaces/:id/versions/:n/export', (c) => exportRoute(app, c)),
  ];
}
