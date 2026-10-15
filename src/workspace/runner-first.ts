import { join } from 'node:path';
import { DEFAULT_COVER_STYLE } from '../cover/styles.js';
import { DEFAULT_PLAN_OPTIONS } from '../cut/plan.js';
import type { VersionState } from '../edit/apply.js';
import { validateArgs, type PipelineArgs } from '../pipeline/run.js';
import { analyzeStage, backgroundStage, captionsStage, composeStage, coverStage, cutStage, finalQaStage, qaCardsStage, storyboardStage, type Analysis } from '../pipeline/stages.js';
import type { VersionEnv, VersionOutcome } from './runner.js';
import { ANALYSIS_FILE, FINAL_FILE, linkBroll, linkFile, writeJsonAtomic, type BaseAnalysis } from './runner-files.js';
import { cutAsPerson, matteInto, pipelineArgs, qaScoreOf, type Person } from './runner-media.js';

/** 首个版本的初始状态（剪辑参数用默认值，修改都从这里叠加） */
function initialState(env: VersionEnv): Pick<VersionState, 'settings' | 'coverStyle' | 'bgm' | 'cutOptions' | 'extraCuts' | 'restored'> {
  return { settings: env.space.settings, coverStyle: env.space.settings.coverStyle ?? DEFAULT_COVER_STYLE, bgm: { bgm: 'auto' }, cutOptions: { ...DEFAULT_PLAN_OPTIONS }, extraCuts: [], restored: [] };
}

/** 分析写 base/：之后的版本重建剪辑方案与补字幕都读 analysis.json */
async function analyze(env: VersionEnv, args: PipelineArgs): Promise<Analysis> {
  const a = await analyzeStage(args, join(env.base, 'audio16k.wav'), env.complete);
  writeJsonAtomic(join(env.base, ANALYSIS_FILE), { media: a.media, transcript: a.transcript, cuts: a.cuts } satisfies BaseAnalysis);
  return a;
}

/** 剪切到 base/cut.mp4；有背景时抠像，遮罩存 base/matte.mp4，人像写版本目录 */
async function makePerson(env: VersionEnv, args: PipelineArgs, a: Analysis): Promise<Person> {
  const cut = join(env.base, 'cut.mp4');
  await cutStage(args, a.plan.keep, cut, env.complete);
  linkFile(cut, join(env.dir, 'cut.mp4'));
  if (!args.background) return cutAsPerson(env, cut);
  const bg = await backgroundStage(args, args.background, env.complete);
  return matteInto(env, args, cut, bg.path, env.base);
}

/** 首个版本：分析 → 剪切与抠像 → 字幕 → 分镜与素材 → 卡片自检 → 分段渲染 → 成片检查 → 封面 */
export async function produceFirst(env: VersionEnv, input: string): Promise<VersionOutcome> {
  const init = initialState(env);
  const args = pipelineArgs(env, input, { ...init, plan: { keep: [], sourceDurationSec: 0, outputDurationSec: 0 }, captions: [], storyboard: { shots: [] } }, { style: init.coverStyle });
  validateArgs(args);
  const a = await analyze(env, args);
  const { person, subject } = await makePerson(env, args, a);
  const captions = await captionsStage(args, a, join(env.dir, 'captions.ass'), env.complete);
  const planned = await storyboardStage(args, captions, a.plan.outputDurationSec, env.base, env.complete);
  linkBroll(planned, env.base, env.dir);
  const { storyboard, cards } = await qaCardsStage(args, env.meter, planned, captions, env.complete);
  const final = join(env.dir, FINAL_FILE);
  const res = await composeStage(args, { person, subject, captions, storyboard, outputDurationSec: a.plan.outputDurationSec, raw: join(env.dir, 'final.raw.mp4'), output: final, cacheDir: join(env.base, 'segments') }, env.complete);
  env.complete('compose', `分段渲染：新渲 ${res.rendered.length} 段 · 复用缓存 ${res.reused.length} 段`);
  await finalQaStage(args, final, storyboard, cards, env.complete);
  await coverStage(args, env.meter, storyboard, captions, person, env.complete);
  const state: VersionState = { ...init, plan: a.plan, captions, storyboard };
  const qaScore = qaScoreOf(cards);
  return { state, changedShots: res.rendered, ...(qaScore !== undefined ? { qaScore } : {}) };
}
