import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateBackground } from '../background/resolve.js';
import type { TimedCaption } from '../captions/lines.js';
import type { EditPlan as CutPlan } from '../cut/plan.js';
import { applyOps, stagesFor, type Stage, type VersionState } from '../edit/apply.js';
import { validateOps, type EditOp } from '../edit/plan.js';
import { validateAudio } from '../pipeline/audio-step.js';
import { validateBroll } from '../pipeline/broll-step.js';
import { validateStyles } from '../pipeline/finish-step.js';
import type { ProjectFile } from '../pipeline/project.js';
import type { PipelineArgs } from '../pipeline/run.js';
import { brollStage, composeStage, filmQaStage, finalQaStage, placeEnding, qaCardsStage, whiteBalanceOf, type BrollStageExtra } from '../pipeline/stages.js';
import type { BrollMark } from '../pipeline/broll-redo.js';
import type { BeatRecord } from '../pipeline/broll-beats.js';
import { writeStoryboardCredits } from '../broll/credit-store.js';
import type { SegmentedResult } from '../compose/segments.js';
import type { CardQaEntry } from '../qa/visual.js';
import type { CardSpec, Storyboard } from '../storyboard/schema.js';
import type { VersionEnv, VersionOutcome } from './runner.js';
import { ANALYSIS_FILE, COVER_FILES, FINAL_FILE, MARKS_FILE, linkBroll, linkFile, linkIfExists, readJson, STATE_FILE, type BaseAnalysis } from './runner-files.js';
import { makeCover } from './runner-cover.js';
import { compositePerson, cutAsPerson, pipelineArgs, qaScoreOf, resolveBg, reusePerson, sameBackground, type Person } from './runner-media.js';
import { recut, retime, writeAss } from './runner-retime.js';

interface Change { next: VersionState; ops: EditOp[]; dropped: string[]; stages: Set<Stage>; newCover: boolean }
interface Parent { n: number; dir: string; state: VersionState; project: ProjectFile | null; hashes?: string[]; contents?: string[] }
interface Made extends Person { plan: CutPlan; captions: TimedCaption[]; storyboard: Storyboard; brollBeats?: BeatRecord[] }

const STAGE_LABEL: Record<Stage, string> = { cut: '剪切', matte: '换背景', captions: '字幕', storyboard: '分镜', broll: '素材', compose: '成片' };

function readParent(env: VersionEnv, n: number): Parent {
  const meta = env.space.versions.find((v) => v.n === n);
  if (!meta) throw new Error(`版本不存在：v${n}`);
  const dir = env.ctx.store.versionDir(env.space.id, n);
  if (meta.status !== 'done' || !existsSync(join(dir, STATE_FILE))) throw new Error(`v${n} 还没有完成，不能在它上面修改`);
  const project = existsSync(join(dir, 'project.json')) ? readJson<ProjectFile>(join(dir, 'project.json'), `v${n} 的工程文件`) : null;
  const state = readJson<VersionState>(join(dir, STATE_FILE), `v${n} 的版本状态`);
  return { n, dir, state, project, ...(meta.shotHashes ? { hashes: meta.shotHashes } : {}), ...(meta.contentHashes ? { contents: meta.contentHashes } : {}) };
}

/** 校验并应用修改；付费开关与预算以项目当前设置为准 */
function planChange(env: VersionEnv, parent: VersionState, raw: EditOp[]): Change {
  const { ops, dropped } = validateOps(raw, parent);
  if (raw.length > 0 && ops.length === 0) throw new Error(`没有可执行的修改：${dropped.join('；')}`);
  const applied = applyOps(parent, ops);
  const { budgetYuan, broll, maxVideos, grain, outro } = env.space.settings;
  const next = { ...applied, settings: { ...applied.settings, budgetYuan, broll, maxVideos, ...(grain === undefined ? {} : { grain }), ...(outro === undefined ? {} : { outro }) } };
  return { next, ops, dropped, stages: stagesFor(ops), newCover: next.coverStyle !== parent.coverStyle };
}

function editMessage(summary: string, c: Change): string {
  const rerun = [...c.stages].map((s) => STAGE_LABEL[s]);
  return [
    `修改：${summary}`,
    c.ops.length === 0 ? '无修改，整版沿用上一版' : `应用 ${c.ops.length} 项修改`,
    rerun.length > 0 ? `重跑：${rerun.join('、')}` : '',
    c.newCover ? '重做封面' : '',
    c.dropped.length > 0 ? `忽略 ${c.dropped.length} 项：${c.dropped.join('；')}` : '',
  ].filter(Boolean).join(' · ');
}

/** project.json 先沿用父版本的分析与制作结果（本版重跑的步骤会覆盖），账目、自检、封面、素材记录与文件路径不沿用 */
function seedProject(env: VersionEnv, p: ProjectFile | null): void {
  if (!p) return;
  const { version: _v, input: _i, createdAt: _c, artifacts: _a, costs: _co, qa: _q, cover: _cv, broll: _b, ...rest } = p;
  env.record(rest);
}

/** 只在背景换了（需要重新落地背景图）时检查背景；素材步骤要跑时检查素材依赖 */
function validateNext(args: PipelineArgs, c: Change, parent: VersionState): void {
  validateAudio(args.audio);
  validateStyles(args.captionStyle, args.cover);
  if (c.stages.has('broll')) validateBroll(args.broll, args.brollDeps, args.task);
  const bg = c.next.settings.background;
  if (bg && !sameBackground(bg, parent.settings.background)) validateBackground(bg, args.cfg, args.task);
}

/** 人像：没背景用剪切结果；没重剪也没换背景整版沿用；否则从 base 的整条抠像图层按本版剪辑方案合成（不再跑抠像推理，除非图层还不存在） */
async function nextPerson(env: VersionEnv, args: PipelineArgs, p: Parent, c: Change, plan: CutPlan): Promise<Person> {
  const spec = c.next.settings.background;
  if (!spec) return cutAsPerson(env, args, join(env.dir, 'cut.mp4'));
  if (!c.stages.has('cut') && !c.stages.has('matte')) return reusePerson(env, p.dir, p.project);
  const bgPath = await resolveBg(env, args, spec, p.project, p.dir);
  return compositePerson(env, args, plan.keep, bgPath);
}

/** 剪切 → 人像 → 字幕与分镜（剪辑类修改时平移）→ 素材；不需要重跑的从父版本引用 */
async function remake(env: VersionEnv, args: PipelineArgs, p: Parent, c: Change): Promise<Made> {
  const a = readJson<BaseAnalysis>(join(env.base, ANALYSIS_FILE), '分析结果');
  const recutting = c.stages.has('cut');
  const plan = recutting ? await recut(env, args, a, c.next) : p.state.plan;
  if (!recutting) linkFile(join(p.dir, 'cut.mp4'), join(env.dir, 'cut.mp4'));
  const person = await nextPerson(env, args, p, c, plan);
  const timed = recutting ? retime(env, a, p.state, c.next, plan) : { captions: c.next.captions, storyboard: c.next.storyboard };
  if (!recutting) env.record({ artifacts: { ass: writeAss(env, a, timed.captions) } });
  // CTA 提前（幂等：剪辑改了时间线或片尾设置变了会重新放置；已提前的 CTA 先还原再放）
  const placed = placeEnding(args, timed.storyboard, timed.captions, plan.outputDurationSec);
  // 素材名额先让给没改动的卡片（它们的视频已经付过费），改动过的卡片排在后面
  const storyboard = c.stages.has('broll') ? await brollStage(args, placed, plan.outputDurationSec, env.base, env.complete, {
    captions: timed.captions, deferShots: changedShots(p.state, placed), edit: brollEdit(p, c),
    whiteBalance: await whiteBalanceOf(args, env.record({}).background?.path ?? person.person),
  }) : placed;
  linkBroll(storyboard, env.base, env.dir);
  // 节拍记录：素材步骤跑了用它更新后的，否则沿用父版本
  const brollBeats = c.stages.has('broll') ? env.record({}).broll?.beats : parentBeats(p);
  return { ...person, plan, captions: timed.captions, storyboard, ...(brollBeats ? { brollBeats } : {}) };
}

/**
 * 修改版本的 B-roll 重做请求：「换一张 B-roll」指向的镜头（按镜头中点的成片秒数定位，素材步骤前的 CTA 放置不影响）、
 * 上一版素材面板的标记（remove 去掉、replace 换一张）与上一版的节拍记录。不重新规划节拍
 */
function brollEdit(p: Parent, c: Change): NonNullable<BrollStageExtra['edit']> {
  const shots = c.next.storyboard.shots;
  const redoAt = c.ops.flatMap((o) => (o.type === 'replaceBroll' && shots[o.shotIndex] ? [(shots[o.shotIndex].start + shots[o.shotIndex].end) / 2] : []));
  return { redoAt, marks: readMarks(p.dir), records: parentBeats(p) ?? [] };
}

/** 父版本的节拍记录：版本状态里的为准，旧版本退回 project.json */
const parentBeats = (p: Parent): BeatRecord[] | undefined => p.state.brollBeats ?? p.project?.broll?.beats;

/** 上一版素材面板的标记（credits-marks.json，键是素材相对路径）；没有或损坏当作没有标记 */
function readMarks(dir: string): Record<string, BrollMark> {
  const file = join(dir, MARKS_FILE);
  if (!existsSync(file)) return {};
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { action?: unknown }>;
    return Object.fromEntries(Object.entries(raw).flatMap(([k, v]) => (v?.action === 'replace' || v?.action === 'remove' ? [[k, v.action]] : [])));
  } catch {
    return {};
  }
}

/** 键排序后序列化：同一张卡片不因字段顺序不同被当成改过 */
function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj).sort().map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** 卡片的比较键：hook 的序号（index/total）由版式整理自动重排，不算卡片改过 */
function cardKey(card: CardSpec): string {
  if (card.template !== 'hook') return stable(card);
  const { index: _i, total: _t, ...props } = card.props;
  return stable({ ...card, props });
}

/**
 * 本版改动的共同口径：本版第 i 个镜头的内容键不在父版本的内容键里，就算改动（与是否命中渲染缓存无关）。
 * 画面用分段哈希（含本段帧区间，所以等于比较同一时间位置的画面），卡片自检用卡片内容。
 */
function changedAgainst(parentKeys: readonly string[], keys: readonly (string | undefined)[]): number[] {
  const known = new Set(parentKeys);
  return keys.flatMap((k, i) => (k !== undefined && !known.has(k) ? [i] : []));
}

/** 父版本里没有的卡片（新换的、重取素材的）所在的镜头序号 */
function changedShots(parent: VersionState, storyboard: Storyboard): number[] {
  const parentCards = parent.storyboard.shots.flatMap((s) => (s.card ? [cardKey(s.card)] : []));
  const cards = storyboard.shots.map((s) => (s.layout === 'split' && s.card ? cardKey(s.card) : undefined));
  return changedAgainst(parentCards, cards);
}

/** 用户在对话里直接换上的卡片（replaceCard）所在的镜头：自检只打分不重写，免得换掉用户要的模板和文字 */
function userCards(ops: EditOp[], storyboard: Storyboard, changed: number[]): number[] {
  const wanted = ops.flatMap((o) => (o.type === 'replaceCard' ? [o] : []));
  return changed.filter((i) => wanted.some((o) => o.shotIndex === i && storyboard.shots[i]?.card?.template === o.card.template));
}

/** 卡片自检只查父版本里没有的卡片 */
function checkChanged(env: VersionEnv, args: PipelineArgs, parent: VersionState, c: Change, m: Made): Promise<{ storyboard: Storyboard; cards: CardQaEntry[] }> {
  const changed = changedShots(parent, m.storyboard);
  if (changed.length === 0) return Promise.resolve({ storyboard: m.storyboard, cards: [] });
  return qaCardsStage(args, env.meter, m.storyboard, m.captions, env.complete, changed, userCards(c.ops, m.storyboard, changed));
}

interface Rendered { changed: number[]; rerendered: number[]; hashes?: string[]; contents?: string[]; outroStartSec?: number }

/** 实际重渲的镜头（含交叉淡出波及的）：和父版本的渲染哈希比；父版本没记哈希（旧数据）时退回本次实际重渲的镜头 */
function rerenderedAgainst(p: Parent, res: SegmentedResult): number[] {
  return p.hashes ? changedAgainst(p.hashes, res.hashes) : res.rendered;
}

/** 用户可见的改动：和父版本的内容哈希比（不含仅因上一张卡淡出而重渲的镜头）；父版本没有内容哈希（旧数据）时退回渲染哈希的比较 */
function changedAgainstParent(p: Parent, res: SegmentedResult): number[] {
  return p.contents ? changedAgainst(p.contents, res.contents) : rerenderedAgainst(p, res);
}

/** 有阶段要跑才渲染（未改动的镜头命中分段缓存）；只换封面或回退时直接引用父版本成片，画面与父版本相同 */
async function render(env: VersionEnv, args: PipelineArgs, p: Parent, c: Change, m: Made): Promise<Rendered> {
  const final = join(env.dir, FINAL_FILE);
  if (c.stages.size === 0) {
    linkFile(join(p.dir, FINAL_FILE), final);
    env.record({ artifacts: { output: final, final } });
    return { changed: [], rerendered: [], ...(p.hashes ? { hashes: p.hashes } : {}), ...(p.contents ? { contents: p.contents } : {}) };
  }
  const input = {
    person: m.person, subject: m.subject, captions: m.captions, storyboard: m.storyboard, outputDurationSec: m.plan.outputDurationSec,
    raw: join(env.dir, 'final.raw.mp4'), output: final, cacheDir: join(env.base, 'segments'),
  };
  const res = await composeStage(args, input, env.complete);
  env.complete('compose', `分段渲染：重渲 ${res.rendered.length} 段 · 复用缓存 ${res.reused.length} 段`);
  // 修改版本只做整片自检、不局部重做：用户点名的改动不被自检改掉
  await filmQaStage(args, input, res, env.complete, false, env.base);
  return { changed: changedAgainstParent(p, res), rerendered: rerenderedAgainst(p, res), hashes: res.hashes, contents: res.contents, ...(res.outroStartSec === undefined ? {} : { outroStartSec: res.outroStartSec }) };
}

/** 封面只在换了封面风格时重做，否则引用父版本的封面 */
async function cover(env: VersionEnv, args: PipelineArgs, p: Parent, c: Change, m: Made): Promise<void> {
  if (c.newCover) return makeCover(env, args, c.next.coverStyle, m.storyboard, m.captions, m.person);
  const [cover34, cover43] = COVER_FILES.map((f) => join(env.dir, f));
  const linked = COVER_FILES.filter((f) => linkIfExists(join(p.dir, f), join(env.dir, f)));
  if (linked.length === COVER_FILES.length) env.record({ artifacts: { cover34, cover43 }, ...(p.project?.cover ? { cover: p.project.cover } : {}) });
}

/** 修改版本：校验应用 → 只重跑受影响的阶段 → 只检查改动过的卡片 → 渲染（复用缓存）→ 整片自检（只检查）→ 成片检查（每版都做）→ 封面 */
export async function produceNext(env: VersionEnv, input: string, parentN: number, raw: EditOp[], summary: string): Promise<VersionOutcome> {
  const p = readParent(env, parentN);
  const c = planChange(env, p.state, raw);
  seedProject(env, p.project);
  env.complete('edit', editMessage(summary, c));
  const args = pipelineArgs(env, input, c.next, c.newCover ? { style: c.next.coverStyle } : false);
  validateNext(args, c, p.state);
  const made = await remake(env, args, p, c);
  const { storyboard, cards } = await checkChanged(env, args, p.state, c, made);
  const m = { ...made, storyboard };
  const rendered = await render(env, args, p, c, m);
  await finalQaStage(args, join(env.dir, FINAL_FILE), storyboard, cards, env.complete, rendered.outroStartSec);
  await cover(env, args, p, c, m);
  env.record({ plan: m.plan, captions: m.captions, storyboard });
  const qaScore = qaScoreOf(cards) ?? env.space.versions.find((v) => v.n === parentN)?.qaScore;
  // 授权记录按卡片自检之后的最终分镜写
  writeStoryboardCredits(storyboard, env.base, env.dir);
  const state = { ...c.next, plan: m.plan, captions: m.captions, storyboard, ...(m.brollBeats ? { brollBeats: m.brollBeats } : {}) };
  return { state, changedShots: rendered.changed, rerenderedShots: rendered.rerendered, ...(rendered.hashes ? { shotHashes: rendered.hashes } : {}), ...(rendered.contents ? { contentHashes: rendered.contents } : {}), ...(qaScore !== undefined ? { qaScore } : {}) };
}
