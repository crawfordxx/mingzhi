import { join } from 'node:path';
import type { BrollDeps } from '../broll/fulfill.js';
import { CancelledError, throwIfCancelled } from '../cancel.js';
import type { AppConfig } from '../config.js';
import { CostMeter } from '../cost/meter.js';
import type { Price } from '../cost/prices.js';
import type { VersionState } from '../edit/apply.js';
import type { EditOp } from '../edit/plan.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import type { CoverDeps } from '../pipeline/finish-step.js';
import type { MediaDeps } from '../pipeline/media-deps.js';
import { projectRecorder, type ProjectFile, type ProjectPatch } from '../pipeline/project.js';
import type { QaDeps } from '../pipeline/qa-step.js';
import { costsOf, makeComplete, type ProgressEvent } from '../pipeline/run.js';
import type { Complete } from '../pipeline/stages.js';
import { toWorkEvent, type EventBus } from './events.js';
import { produceFirst } from './runner-first.js';
import { FINAL_FILE, SOURCE_FILE, STATE_FILE, writeJsonAtomic } from './runner-files.js';
import { produceNext } from './runner-next.js';
import type { Space, SpaceStore, VersionMeta } from './store.js';

export { FINAL_FILE } from './runner-files.js';

/** 版本运行器的依赖；每个任务一份（signal 属于这一次运行） */
export interface RunnerCtx {
  store: SpaceStore;
  bus: EventBus;
  cfg: AppConfig;
  /** 按本版本的计费器构造模型与任务客户端：版本里的每一笔花费都记到这个版本 */
  clients: (meter: CostMeter) => { llm: LlmClient; task?: TaskClient };
  /** 模型单价（元 / 千 token）；缺省空表，按内置最贵价估算 */
  prices?: Record<string, Price>;
  /** 取消信号：步骤之间与抠像、渲染内部响应 */
  signal?: AbortSignal;
  /** 以下仅供测试注入 */
  media?: Partial<MediaDeps>;
  brollDeps?: (meter: CostMeter) => BrollDeps;
  coverDeps?: CoverDeps;
  qaDeps?: QaDeps;
}

/** 一个正在产出的版本：目录、账本、事件与 project.json 记录器 */
export interface VersionEnv {
  ctx: RunnerCtx; space: Space; n: number; base: string; dir: string;
  meter: CostMeter; llm: LlmClient; task?: TaskClient;
  record: (patch: ProjectPatch) => ProjectFile;
  complete: Complete;
  emit: (e: ProgressEvent) => void;
}

/** changedShots：本版实际重渲的镜头序号；qaScore：本版卡片自检的平均分（没有自检时沿用父版本） */
export interface VersionOutcome { state: VersionState; changedShots: number[]; qaScore?: number }

/** 多段口播拼成的合成原片：之后的识别时间戳、剪口误、抠像、各版本修改都把它当作单段原片 */
const sourceOf = (base: string): string => join(base, SOURCE_FILE);

/** 流程使用的原片：单段口播就是上传的文件，多段是 base/ 里的合成原片（首个版本负责生成） */
function inputOf(ctx: RunnerCtx, space: Space): string {
  if (space.inputs.length === 0) throw new Error('还没有上传口播视频');
  return space.inputs.length > 1 ? sourceOf(ctx.store.baseDir(space.id)) : space.inputs[0];
}

function makeEnv(ctx: RunnerCtx, space: Space, n: number): VersionEnv {
  const dir = ctx.store.versionDir(space.id, n);
  const meter = new CostMeter(ctx.prices ?? {}, space.settings.budgetYuan);
  const { llm, task } = ctx.clients(meter);
  const record = projectRecorder(join(dir, 'project.json'), space.inputs[0] ?? '');
  const emit = (e: ProgressEvent): void => { ctx.bus.publish(toWorkEvent(space.id, n, e)); };
  const complete = makeComplete({ record, meter, onProgress: emit, signal: ctx.signal });
  return { ctx, space, n, base: ctx.store.baseDir(space.id), dir, meter, llm, ...(task ? { task } : {}), record, complete, emit };
}

/** 收尾：先写 state.json（版本完整的标志），再置 done，最后发 done 事件 */
function finish(env: VersionEnv, out: VersionOutcome): VersionMeta {
  writeJsonAtomic(join(env.dir, STATE_FILE), out.state);
  const final = join(env.dir, FINAL_FILE);
  env.record({ costs: costsOf(env.meter) });
  const meta = env.ctx.store.updateVersion(env.space.id, env.n, {
    status: 'done', costYuan: env.meter.total, changedShots: out.changedShots, ...(out.qaScore !== undefined ? { qaScore: out.qaScore } : {}),
  });
  env.emit({ step: 'done', message: final });
  return meta;
}

/** 失败（含取消）：版本置 failed 并记下已花费；已取消时以取消为准 */
function fail(env: VersionEnv, err: unknown): unknown {
  const final = env.ctx.signal?.aborted && !(err instanceof CancelledError) ? new CancelledError() : err;
  try { env.record({ costs: costsOf(env.meter) }); } catch { /* 写盘失败不盖掉原错误 */ }
  try { env.ctx.store.updateVersion(env.space.id, env.n, { status: 'failed', costYuan: env.meter.total }); } catch { /* 同上 */ }
  return final;
}

/** 新建版本 → 产出 → 成功置 done / 失败置 failed；父版本目录只读不写 */
async function runVersion(ctx: RunnerCtx, spaceId: string, meta: { parent?: number; summary: string }, body: (env: VersionEnv, input: string) => Promise<VersionOutcome>): Promise<VersionMeta> {
  const space = ctx.store.get(spaceId);
  const version = ctx.store.addVersion(spaceId, { ...meta, changedShots: [], costYuan: 0, status: 'running' });
  let env: VersionEnv;
  try {
    env = makeEnv(ctx, space, version.n);
  } catch (err) {
    ctx.store.updateVersion(spaceId, version.n, { status: 'failed' });
    throw err;
  }
  try {
    throwIfCancelled(ctx.signal);
    return finish(env, await body(env, inputOf(ctx, space)));
  } catch (err) {
    throw fail(env, err);
  }
}

/**
 * 首个版本：跑完整流程；探测、识别、剪口误、cut.mp4、整条抠像图层写 base/，其余写 v<n>/。
 * 项目已有出片版本时拒绝：base/ 里的分析结果被所有版本共用，重跑会换掉它（剪口误结果不确定），旧版本再改剪辑就会错位。
 */
export async function runFirstVersion(ctx: RunnerCtx, spaceId: string): Promise<VersionMeta> {
  if (ctx.store.get(spaceId).versions.some((v) => v.status === 'done')) throw new Error('项目已有出片版本，不能重新跑首个版本；请在已有版本上修改');
  return runVersion(ctx, spaceId, { summary: '首个版本' }, produceFirst);
}

/**
 * 修改版本：读父版本 state.json → 校验并应用修改 → 只跑受影响的阶段，其余从父版本引用；
 * ops 为空时整版复用父版本（回退用）。分段渲染缓存在 base/segments，各版本共用。
 */
export function runNextVersion(ctx: RunnerCtx, spaceId: string, parent: number, ops: EditOp[], summary: string): Promise<VersionMeta> {
  return runVersion(ctx, spaceId, { parent, summary }, (env, input) => produceNext(env, input, parent, ops, summary));
}
