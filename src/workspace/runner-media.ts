import { existsSync, readdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BackgroundSpec } from '../background/resolve.js';
import type { TimeRange } from '../cut/plan.js';
import type { VersionState } from '../edit/apply.js';
import type { SubjectBox } from '../matting/composite.js';
import type { CoverOptions } from '../pipeline/finish-step.js';
import { mediaOf } from '../pipeline/media-deps.js';
import type { ProjectFile } from '../pipeline/project.js';
import type { PipelineArgs } from '../pipeline/run.js';
import { backgroundStage, throttledMatteProgress } from '../pipeline/stages.js';
import type { CardQaEntry } from '../qa/visual.js';
import type { VersionEnv } from './runner.js';
import { FINAL_FILE, isInside, LAYER_FILES, linkFile, linkIfExists, MATTE_META, readJson, writeJsonAtomic, type MatteMeta } from './runner-files.js';

/** 这个版本的流程参数：工作目录是版本目录，分段缓存在 base/segments；付费开关与预算取项目当前设置 */
export function pipelineArgs(env: VersionEnv, input: string, state: VersionState, cover: CoverOptions): PipelineArgs {
  const { ctx, space, dir, meter } = env;
  const { budgetYuan, broll, maxVideos } = space.settings;
  return {
    input, workDir: dir, output: join(dir, FINAL_FILE), cfg: ctx.cfg, llm: env.llm, task: env.task, meter,
    background: state.settings.background, captionStyle: state.settings.captionStyle, audio: state.bgm, cover,
    broll: { enabled: broll, maxVideos, budgetYuan, ...(ctx.cfg.pexelsKey ? { pexelsKey: ctx.cfg.pexelsKey } : {}) },
    ...(ctx.brollDeps ? { brollDeps: ctx.brollDeps(meter) } : {}),
    coverDeps: ctx.coverDeps, qaDeps: ctx.qaDeps, media: ctx.media, cacheDir: join(env.base, 'segments'), signal: ctx.signal, onProgress: env.emit,
  };
}

export interface Person { person: string; subject: SubjectBox | null }

/** 没有背景：人像就是剪切结果 */
export function cutAsPerson(env: VersionEnv, cut: string): Person {
  const person = join(env.dir, 'person.mp4');
  linkFile(cut, person);
  env.record({ artifacts: { person } });
  return { person, subject: null };
}

/** 进程被硬杀时留下的临时图层文件（取消与失败会自行清理） */
function removeStaleTemps(base: string): void {
  for (const name of readdirSync(base)) if (/^(fgr|matte)\.mp4\.[0-9a-f]+\.tmp\.mp4$/.test(name)) rmSync(join(base, name), { force: true });
}

/**
 * base/ 里整条原片（未剪切）的抠像图层：去溢色前景 fgr.mp4 + 灰度遮罩 matte.mp4 + matte.json（最后写，存在即完整）。
 * 只在第一次需要背景时跑一次 RVM；之后任何版本换背景、改剪辑都只做合成。
 * 前提：同一个项目同一时间只有一个任务（由本机服务的任务队列保证）；并发调用会重复抠像并互相覆盖图层（改名是原子的，不会损坏，只是浪费）。
 */
async function ensureLayers(env: VersionEnv, args: PipelineArgs): Promise<MatteMeta> {
  const metaFile = join(env.base, MATTE_META);
  const [fgr, matte] = LAYER_FILES.map((f) => join(env.base, f));
  if ([metaFile, fgr, matte].every((f) => existsSync(f))) return readJson<MatteMeta>(metaFile, '抠像信息');
  removeStaleTemps(env.base);
  env.emit({ step: 'matte', message: '对整条原片抠像（比只抠剪后片段多花约三分之一时间），之后换背景、改节奏都不用再抠' });
  const started = Date.now();
  const res = await mediaOf(args.media).matte({
    input: args.input, cfg: args.cfg, signal: args.signal, fgrOutput: fgr, matteOutput: matte, onProgress: throttledMatteProgress(env.emit),
  });
  const meta: MatteMeta = { subject: res.subject, fgMean: res.fgMean, frames: res.frames };
  writeJsonAtomic(metaFile, meta);
  const secs = Math.max((Date.now() - started) / 1000, 0.001);
  env.complete('matte', `抠像完成（整条原片）· ${res.frames} 帧 · ${(res.frames / secs).toFixed(1)} 帧/秒`);
  return meta;
}

/**
 * 有背景的人像：从整条图层里按本版剪辑方案取帧（与剪切逐帧对齐）合成到背景。
 * 取景框与人物平均色沿用整条原片的统计：剪掉的只是停顿与口误，人物位置与肤色分布基本不变，重算要再解码一遍遮罩，收益很小。
 */
export async function compositePerson(env: VersionEnv, args: PipelineArgs, keep: TimeRange[], bgPath: string): Promise<Person> {
  const meta = await ensureLayers(env, args);
  const person = join(env.dir, 'person.mp4');
  const [fgr, matte] = LAYER_FILES.map((f) => join(env.base, f));
  const started = Date.now();
  await mediaOf(args.media).composite({ cut: join(env.dir, 'cut.mp4'), fgr, matte, keep, backgroundPath: bgPath, output: person, fgMean: meta.fgMean, cfg: args.cfg, signal: args.signal });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  env.complete('matte', `换背景合成完成（复用整条抠像，未重新推理）· 用时 ${secs} 秒`, { subject: meta.subject, artifacts: { person } });
  return { person, subject: meta.subject };
}

/** 两个背景是否同一个（按种类与字段比较，不受键顺序影响） */
export function sameBackground(a: BackgroundSpec | undefined, b: BackgroundSpec | undefined): boolean {
  if (!a || !b) return a === b;
  if (a.kind === 'preset' && b.kind === 'preset') return a.id === b.id;
  if (a.kind === 'file' && b.kind === 'file') return a.path === b.path;
  return a.kind === 'prompt' && b.kind === 'prompt' && a.prompt === b.prompt;
}

/**
 * 背景图：与父版本同一个背景就沿用它落地的图片（一句话生成的图不重复付费），否则重新落地。
 * 父版本目录里的图片引用进本版本目录。
 */
export async function resolveBg(env: VersionEnv, args: PipelineArgs, spec: BackgroundSpec, parent: ProjectFile | null, pdir: string): Promise<string> {
  const prev = parent?.background;
  if (!prev || !sameBackground(prev.spec, spec) || !existsSync(prev.path)) return (await backgroundStage(args, spec, env.complete)).path;
  const path = isInside(pdir, prev.path) ? join(env.dir, basename(prev.path)) : prev.path;
  if (path !== prev.path) linkFile(prev.path, path);
  env.record({ background: { spec, path } });
  return path;
}

/** 整版复用父版本的人像与背景图 */
export function reusePerson(env: VersionEnv, pdir: string, parent: ProjectFile | null): Person {
  const person = join(env.dir, 'person.mp4');
  linkFile(join(pdir, 'person.mp4'), person);
  const bg = parent?.background;
  const bgCopy = bg && isInside(pdir, bg.path) ? join(env.dir, basename(bg.path)) : null;
  if (bg && bgCopy && linkIfExists(bg.path, bgCopy)) env.record({ background: { spec: bg.spec, path: bgCopy } });
  env.record({ artifacts: { person } });
  return { person, subject: parent?.subject ?? null };
}

/** 卡片自检平均分：每张卡片取最后一次四维平均，再对卡片取平均，保留 1 位小数；没有打分返回 undefined */
export function qaScoreOf(cards: CardQaEntry[]): number | undefined {
  const last = cards.flatMap((c) => (c.scores.length > 0 ? [c.scores[c.scores.length - 1]] : []));
  if (last.length === 0) return undefined;
  const avg = last.reduce((sum, s) => sum + (s.layout + s.hierarchy + s.motion + s.brand) / 4, 0) / last.length;
  return Math.round(avg * 10) / 10;
}
