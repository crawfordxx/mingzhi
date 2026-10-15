import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { BackgroundSpec } from '../background/resolve.js';
import type { VersionState } from '../edit/apply.js';
import type { SubjectBox } from '../matting/composite.js';
import type { CoverOptions } from '../pipeline/finish-step.js';
import { mediaOf } from '../pipeline/media-deps.js';
import type { ProjectFile } from '../pipeline/project.js';
import type { PipelineArgs } from '../pipeline/run.js';
import { backgroundStage, matteStage } from '../pipeline/stages.js';
import type { CardQaEntry } from '../qa/visual.js';
import type { VersionEnv } from './runner.js';
import { FINAL_FILE, isInside, linkFile, linkIfExists, MATTE_META, readJson, writeJsonAtomic, type MatteMeta } from './runner-files.js';

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

/** 抠像推理：人像写版本目录；遮罩与 matte.json 写 matteDir（首个版本为 base/），再引用进版本目录 */
export async function matteInto(env: VersionEnv, args: PipelineArgs, cut: string, bgPath: string, matteDir: string): Promise<Person> {
  const person = join(env.dir, 'person.mp4');
  const matte = join(matteDir, 'matte.mp4');
  const res = await matteStage(args, cut, bgPath, { person, matte }, env.complete);
  writeJsonAtomic(join(matteDir, MATTE_META), { subject: res.subject, fgMean: res.fgMean, frames: res.frames } satisfies MatteMeta);
  if (matteDir !== env.dir) linkMatte(matteDir, env.dir);
  return { person, subject: res.subject };
}

/** 把 from 目录的遮罩与 matte.json 引用到 to 目录；没有遮罩返回 false */
export function linkMatte(from: string, to: string): boolean {
  if (!existsSync(join(from, 'matte.mp4')) || !existsSync(join(from, MATTE_META))) return false;
  linkFile(join(from, 'matte.mp4'), join(to, 'matte.mp4'));
  linkFile(join(from, MATTE_META), join(to, MATTE_META));
  return true;
}

/** 只用遮罩 + 背景合成（不跑抠像推理）；遮罩须已在版本目录 */
export async function compositeInto(env: VersionEnv, args: PipelineArgs, cut: string, bgPath: string): Promise<Person> {
  const person = join(env.dir, 'person.mp4');
  const meta = readJson<MatteMeta>(join(env.dir, MATTE_META), '抠像信息');
  const started = Date.now();
  await mediaOf(args.media).composite({ input: cut, matte: join(env.dir, 'matte.mp4'), backgroundPath: bgPath, output: person, fgMean: meta.fgMean, cfg: args.cfg, signal: args.signal });
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  env.complete('matte', `换背景合成完成（复用抠像遮罩，未重新推理）· 用时 ${secs} 秒`, { subject: meta.subject, artifacts: { person } });
  return { person, subject: meta.subject };
}

/**
 * 背景图：与父版本同一个背景就沿用它落地的图片（一句话生成的图不重复付费），否则重新落地。
 * 父版本目录里的图片引用进本版本目录。
 */
export async function resolveBg(env: VersionEnv, args: PipelineArgs, spec: BackgroundSpec, parent: ProjectFile | null, pdir: string): Promise<string> {
  const prev = parent?.background;
  if (!prev || JSON.stringify(prev.spec) !== JSON.stringify(spec) || !existsSync(prev.path)) return (await backgroundStage(args, spec, env.complete)).path;
  const path = isInside(pdir, prev.path) ? join(env.dir, basename(prev.path)) : prev.path;
  if (path !== prev.path) linkFile(prev.path, path);
  env.record({ background: { spec, path } });
  return path;
}

/** 整版复用父版本的人像（含遮罩与背景图） */
export function reusePerson(env: VersionEnv, pdir: string, parent: ProjectFile | null): Person {
  const person = join(env.dir, 'person.mp4');
  linkFile(join(pdir, 'person.mp4'), person);
  linkMatte(pdir, env.dir);
  const bg = parent?.background;
  const bgCopy = bg && isInside(pdir, bg.path) ? join(env.dir, basename(bg.path)) : null;
  if (bg && bgCopy && linkIfExists(bg.path, bgCopy)) env.record({ background: { spec: bg.spec, path: bgCopy } });
  const meta = existsSync(join(env.dir, MATTE_META)) ? readJson<MatteMeta>(join(env.dir, MATTE_META), '抠像信息') : null;
  env.record({ artifacts: { person } });
  return { person, subject: parent?.subject ?? meta?.subject ?? null };
}

/** 卡片自检平均分：每张卡片取最后一次四维平均，再对卡片取平均，保留 1 位小数；没有打分返回 undefined */
export function qaScoreOf(cards: CardQaEntry[]): number | undefined {
  const last = cards.flatMap((c) => (c.scores.length > 0 ? [c.scores[c.scores.length - 1]] : []));
  if (last.length === 0) return undefined;
  const avg = last.reduce((sum, s) => sum + (s.layout + s.hierarchy + s.motion + s.brand) / 4, 0) / last.length;
  return Math.round(avg * 10) / 10;
}
