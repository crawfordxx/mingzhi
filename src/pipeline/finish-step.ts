import { copyFile, rm } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import { normalizeLoudness } from '../audio/loudness.js';
import { DEFAULT_OUTRO, OUTRO_TEXT_MAX, type OutroOptions } from '../compose/ending.js';
import { COVER_YUAN } from '../cost/estimate.js';
import type { CostMeter } from '../cost/meter.js';
import type { TimedCaption } from '../captions/lines.js';
import { CAPTION_STYLES, type CaptionStyleId } from '../captions/styles.js';
import { COVER_STYLES, DEFAULT_COVER_STYLE, type CoverStyleId } from '../cover/styles.js';
import { coverTitle, makeCovers, type MakeCoversOptions, type MakeCoversResult } from '../cover/generate.js';
import { rethrowIfCancelled } from '../cancel.js';
import { InsufficientBalanceError } from '../llm/errors.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import type { Storyboard } from '../storyboard/schema.js';
import { validateAudio, type AudioOptions } from './audio-step.js';
import type { ProjectFile, ProjectPatch } from './project.js';

/** 封面选项：false 关闭；缺省按默认风格生成 */
export type CoverOptions = { style: CoverStyleId } | false;
/** 仅供测试注入的封面实现；缺省时用真实 makeCovers */
export interface CoverDeps { makeCovers: (o: MakeCoversOptions) => Promise<MakeCoversResult> }

export interface CoverContext {
  workDir: string;
  /** 最终成片路径；在工作目录之外时，封面会再复制一份到成片旁边 */
  output?: string;
  cfg: AppConfig; llm: LlmClient; task?: TaskClient; coverDeps?: CoverDeps;
  /** 统一记账；剩余预算不够生成封面时降级跳过 */
  meter?: CostMeter;
}
type Complete = (step: 'loudness' | 'cover', message: string, patch?: ProjectPatch) => ProjectFile;

const lufs = (n: number): string => n.toFixed(1);

/** 响度统一：raw → output；成功后才有最终文件，随后删除 raw。失败直接抛错（raw 保留，output 不产生）；开始前先清掉上次遗留的 output。normalize 仅供测试注入 */
export async function runLoudness(
  cfg: AppConfig, raw: string, output: string, complete: Complete, normalize: typeof normalizeLoudness = normalizeLoudness,
): Promise<void> {
  await rm(output, { force: true });
  const res = await normalize(raw, output, cfg).catch((err: unknown) => {
    rethrowIfCancelled(err);
    throw new Error(`响度统一失败（渲染结果保留在 ${raw}）：${err instanceof Error ? err.message : String(err)}`);
  });
  await rm(raw, { force: true });
  const artifacts = { output, final: output };
  if (!Number.isFinite(res.before)) {
    complete('loudness', '音轨是静音，无法统一响度，已原样输出', { artifacts });
    return;
  }
  const mode = res.mode === 'dynamic' ? ' · 动态模式' : '';
  complete('loudness', `响度 ${lufs(res.before)} → ${lufs(res.after)} LUFS · 真峰值 ${lufs(res.truePeak)} dBTP${mode}`, { loudness: { before: res.before, after: res.after }, artifacts });
}

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

const NEED_KEY = '没有可想 AI key，请设置环境变量 MINGZHI_KX_KEY，或加 --no-cover 关闭封面';

/** 封面实现与任务客户端：注入了测试实现时可以没有 task；真实路径没有 task 就报缺 key */
function resolveCover(ctx: CoverContext): { make: CoverDeps['makeCovers']; task: TaskClient } {
  if (ctx.coverDeps) return { make: ctx.coverDeps.makeCovers, task: ctx.task ?? { run: async () => { throw new Error(NEED_KEY); } } };
  if (!ctx.task) throw new Error(NEED_KEY);
  return { make: makeCovers, task: ctx.task };
}

/** extra：复制到成片旁的路径，或复制失败的说明（封面本身已生成，复制失败不算封面失败） */
function coverSummary(res: MakeCoversResult, extra: string[]): string {
  const person = res.person ? '' : ' · 未抠到人物，封面不含人物';
  const warn = res.unverified.length > 0 ? ` · 标题核对未通过（${res.unverified.join('、')}），请人工检查` : '';
  const reused = res.reused.length > 0 ? ` · 复用已有底图（${res.reused.join('、')}）` : '';
  const paths = [res.cover34, res.cover43, ...extra].map((p) => `\n  ${p}`).join('');
  return `封面已生成 · 生图 ${res.attempts} 次 · 花费 ¥${res.costYuan.toFixed(2)}${reused}${person}${warn}${paths}`;
}

const COVER_START = '生成封面中…（约 2 分钟，约 ¥1.2）';

/** -o 指到工作目录之外时，把两张封面复制到成片旁边（<成片名>_封面3x4.png / _封面4x3.png）；返回新路径，未复制返回空 */
async function copyBesideOutput(workDir: string, output: string | undefined, res: MakeCoversResult): Promise<string[]> {
  if (!output || !relative(resolve(workDir), resolve(output)).startsWith('..')) return [];
  const stem = join(dirname(output), basename(output, extname(output)));
  const targets: [string, string][] = [[res.cover34, `${stem}_封面3x4.png`], [res.cover43, `${stem}_封面4x3.png`]];
  await Promise.all(targets.map(([from, to]) => copyFile(from, to)));
  return targets.map(([, to]) => to);
}

/** 封面步骤的结果：封面是可选产物，没生成时给出原因（由调用方提示用户、版本状态仍是完成）；关闭或已生成为空对象 */
export interface CoverResult { missing?: string }

/**
 * 封面步骤：任何失败（无 key、生图失败、抠像失败、预算不足、可想 AI 余额不足）都只降级为一条进度消息并返回原因，绝不让成片失败。
 * 余额不足也不外抛：成片此时已经写完，抛错会让用户以为整条白跑；只有取消照常外抛
 */
export async function runCover(ctx: CoverContext, cover: CoverOptions | undefined, storyboard: Storyboard, captions: TimedCaption[], personVideo: string, complete: Complete): Promise<CoverResult> {
  if (cover === false) return {};
  if (ctx.meter && !ctx.meter.canSpend(COVER_YUAN)) {
    const reason = `预算不足（剩余 ¥${ctx.meter.remaining().toFixed(2)}，封面约需 ¥${COVER_YUAN.toFixed(2)}）`;
    complete('cover', `预算不足，已跳过封面（剩余 ¥${ctx.meter.remaining().toFixed(2)}，封面约需 ¥${COVER_YUAN.toFixed(2)}）`, { coverError: reason });
    return { missing: reason };
  }
  try {
    const { make, task } = resolveCover(ctx);
    const { title, subtitle } = storyboard.coverTitle ?? coverTitle(storyboard, captions);
    const style = cover?.style ?? DEFAULT_COVER_STYLE;
    complete('cover', COVER_START);
    const res = await make({
      workDir: ctx.workDir, style, title, ...(subtitle ? { subtitle } : {}),
      personVideo, cfg: ctx.cfg, task, client: ctx.llm, meter: ctx.meter,
    });
    const extra = await copyBesideOutput(ctx.workDir, ctx.output, res).catch((err: unknown) => [`（复制到成片旁失败：${errText(err)}）`]);
    complete('cover', coverSummary(res, extra), {
      artifacts: { cover34: res.cover34, cover43: res.cover43 },
      cover: { style, costYuan: res.costYuan, unverified: res.unverified, reused: res.reused },
      coverError: undefined,
    });
    return {};
  } catch (err) {
    rethrowIfCancelled(err);
    if (err instanceof InsufficientBalanceError) {
      complete('cover', `封面未生成：${err.message}（成片已完成，不受影响）`, { coverError: err.message });
      return { missing: err.message };
    }
    complete('cover', `封面生成失败，已跳过（成片不受影响）：${errText(err)}`, { coverError: errText(err) });
    return { missing: errText(err) };
  }
}

/** 提前校验字幕样式与封面风格 id（曲目 id 见 validateAudio） */
export function validateStyles(captionStyle: CaptionStyleId | undefined, cover: CoverOptions | undefined): void {
  if (captionStyle !== undefined && !Object.hasOwn(CAPTION_STYLES, captionStyle)) throw new Error(`未知字幕样式「${captionStyle}」，可用：${Object.keys(CAPTION_STYLES).join('、')}`);
  if (cover && !Object.hasOwn(COVER_STYLES, cover.style)) throw new Error(`未知封面风格「${cover.style}」，可用：${Object.keys(COVER_STYLES).join('、')}`);
}

/** 命令行参数 → 片尾设置；没给任何片尾参数时返回 undefined（流程按缺省：开启，默认 logo + 文字） */
function parseOutroArgs(values: { 'no-outro'?: boolean; 'outro-text'?: string }): OutroOptions | undefined {
  const text = values['outro-text']?.trim();
  if (text !== undefined && [...text].length > OUTRO_TEXT_MAX) throw new Error(`片尾文字最多 ${OUTRO_TEXT_MAX} 个字：${text}`);
  if (!values['no-outro'] && text === undefined) return undefined;
  return { enabled: !values['no-outro'], text: text ?? DEFAULT_OUTRO.text };
}

/** 命令行参数 → 配乐、字幕样式、封面、片尾选项；id 不合法时报错并列出可选项 */
export function parseFinishArgs(values: { bgm?: string; 'caption-style'?: string; 'cover-style'?: string; 'no-cover'?: boolean; 'no-outro'?: boolean; 'outro-text'?: string }): { audio: AudioOptions; captionStyle?: CaptionStyleId; cover: CoverOptions; outro?: OutroOptions } {
  const captionStyle = values['caption-style'] as CaptionStyleId | undefined;
  const cover: CoverOptions = values['no-cover'] ? false : { style: (values['cover-style'] as CoverStyleId | undefined) ?? DEFAULT_COVER_STYLE };
  const audio = { bgm: values.bgm ?? 'auto' };
  const outro = parseOutroArgs(values);
  validateAudio(audio);
  validateStyles(captionStyle, cover);
  return { audio, ...(captionStyle ? { captionStyle } : {}), cover, ...(outro ? { outro } : {}) };
}
