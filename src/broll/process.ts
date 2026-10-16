import { renameSync, rmSync } from 'node:fs';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { meanRgb, type Rgb } from '../matting/composite.js';
import { run, runBuffer } from '../media/exec.js';
import { parseProbe } from '../media/probe.js';
import { planCrop, type CropPlan, type Downgrade, type Point, type Size } from './crop.js';
import { needsWb, wbFilter, wbGains } from './grade.js';
import { CUT_SCORE, parseFrameStats, pickSegment, type FrameStat, type Segment } from './segment.js';

/** 项目统一 LUT（scripts/make-lut.mjs 生成，随仓库提供） */
export const PROJECT_LUT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets', 'lut', 'mingzhi-warm.cube');
/** 时间线帧率 */
const OUT_FPS = 30;
/** 选段分析最多看前 60 秒，长素材不全片解码 */
const ANALYZE_MAX_SEC = 60;
/** LUT 文件名会写进滤镜参数：只允许安全字符，避免滤镜转义问题 */
const SAFE_NAME = /^[\w.-]+$/;

export interface ProcessInput {
  file: string;
  kind: 'video' | 'photo';
  focal: Point;
  target: Size;
  /** 源帧率、源时长：探测失败时的兜底（来自图库元数据） */
  fps?: number;
  durationSec?: number;
  /** 期望输出时长（秒），夹在 2–4，默认 3 */
  wantSec?: number;
}
export interface ProcessContext {
  ffmpeg: string;
  /** 不传时取 ffmpeg 同目录的 ffprobe */
  ffprobe?: string;
  lut: string;
  /** 人物背景的平均色（0–1）；传入时素材向它做白平衡微调 */
  whiteBalance?: { r: number; g: number; b: number };
}
export interface ProcessResult { file: string; durationSec?: number; modified: string[]; downgrade?: Downgrade }

/** untagged：视频没标色彩矩阵（按 HD 惯例当 bt709 读，与浏览器播放一致；ffmpeg 默认会按 bt601 读偏色） */
interface SourceInfo { width: number; height: number; fps: number; durationSec: number; hasAudio: boolean; untagged: boolean }
interface ProbeJson { streams?: { codec_type?: string; width?: number; height?: number; color_space?: string }[]; format?: { duration?: string } }

const ffprobeOf = (ctx: ProcessContext): string =>
  ctx.ffprobe ?? join(dirname(ctx.ffmpeg), basename(ctx.ffmpeg).replace(/ffmpeg/i, 'ffprobe'));

/** 探测尺寸、帧率、时长；探测不到帧率或时长时用图库元数据兜底 */
async function probeSource(file: string, input: ProcessInput, ffprobe: string): Promise<SourceInfo> {
  const { stdout } = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const json = JSON.parse(stdout) as ProbeJson;
  const v = json.streams?.find((s) => s.codec_type === 'video');
  if (input.kind === 'photo') {
    if (!v?.width || !v.height) throw new Error(`素材图片读不出尺寸：${file}`);
    return { width: v.width, height: v.height, fps: OUT_FPS, durationSec: 0, hasAudio: false, untagged: false };
  }
  const format = Number(json.format?.duration) > 0 ? json.format : { ...json.format, duration: String(input.durationSec ?? 'N/A') };
  const info = parseProbe({ ...json, format });
  const untagged = !v?.color_space || v.color_space === 'unknown';
  return { ...info, fps: info.fps > 0 ? info.fps : input.fps ?? OUT_FPS, untagged: untagged && info.height >= 720 };
}

/** 裁切 + 缩放（lanczos）；源与目标一致时省掉 */
function geometryFilters(src: SourceInfo, plan: CropPlan): { filters: string[]; modified: string[] } {
  const { crop, output } = plan;
  const tag = src.untagged ? ['setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709'] : [];
  const cropped = crop.width < src.width - 1 || crop.height < src.height - 1;
  const scaled = output.width !== crop.width || output.height !== crop.height;
  return {
    filters: [
      ...tag,
      ...(cropped ? [`crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}`] : []),
      ...(scaled ? [`scale=${output.width}:${output.height}:flags=lanczos`] : []),
      'setsar=1',
    ],
    modified: [...(cropped ? ['crop'] : []), ...(scaled ? ['scale'] : [])],
  };
}

const seekArgs = (seg?: Segment): string[] => (seg ? ['-ss', seg.start.toFixed(3), '-t', seg.sourceSec.toFixed(3)] : []);

/** 选段分析：缩小后逐帧打印帧差与剪辑点分数 */
async function analyzeVideo(ffmpeg: string, file: string): Promise<FrameStat[]> {
  const vf = `scale=192:-2,signalstats,scdet=threshold=${CUT_SCORE},metadata=mode=print:file=-`;
  const { stdout } = await run(ffmpeg, ['-v', 'error', '-t', String(ANALYZE_MAX_SEC), '-i', file, '-an', '-vf', vf, '-f', 'null', '-']);
  return parseFrameStats(stdout);
}

/** 套完几何与 LUT 后的平均色：视频每秒取 2 帧，各缩成 1 像素再平均 */
async function measureMean(ffmpeg: string, file: string, chain: string[], cwd: string, seg?: Segment): Promise<Rgb> {
  const vf = [...chain, ...(seg ? ['fps=2'] : []), 'scale=1:1:flags=area'].join(',');
  const args = ['-v', 'error', ...seekArgs(seg), '-i', file, '-vf', vf, ...(seg ? [] : ['-frames:v', '1']), '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'];
  return meanRgb(await runBuffer(ffmpeg, args, { cwd }));
}

function lutFilter(lut: string): string {
  const name = basename(lut);
  if (!SAFE_NAME.test(name)) throw new Error(`LUT 文件名只能含字母、数字、点、下划线和连字符：${name}`);
  return `lut3d=file=${name}:interp=tetrahedral`;
}

/** 输出先写临时文件（保留扩展名让 ffmpeg 认格式），成功后改名 */
async function encodeTo(out: string, encode: (tmp: string) => Promise<void>): Promise<void> {
  const ext = extname(out);
  const tmp = `${out.slice(0, out.length - ext.length)}.part${ext}`;
  try {
    await encode(tmp);
    renameSync(tmp, out);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const videoArgs = (file: string, vf: string, seg: Segment, out: string): string[] => [
  '-v', 'error', '-y', ...seekArgs(seg), '-i', file, '-an', '-vf', vf, '-frames:v', String(Math.round(seg.outSec * OUT_FPS)),
  '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
  '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-movflags', '+faststart', out,
];

const photoArgs = (file: string, vf: string, out: string): string[] =>
  ['-v', 'error', '-y', '-i', file, '-vf', vf, '-frames:v', '1', ...(/\.jpe?g$/i.test(out) ? ['-q:v', '2'] : []), out];

/** 视频的变速、统一帧率与输出色彩矩阵（滤镜在 RGB 域，转回 yuv 时明确用 bt709） */
function timingFilters(src: SourceInfo, seg: Segment): { filters: string[]; modified: string[] } {
  const slow = seg.speed !== 1;
  const refps = Math.abs(src.fps * seg.speed - OUT_FPS) > 0.5;
  return {
    filters: [...(slow ? [`setpts=PTS/${seg.speed}`] : []), `fps=${OUT_FPS}`, 'scale=out_color_matrix=bt709:out_range=tv', 'format=yuv420p'],
    modified: ['trim', ...(slow ? [`speed${seg.speed}`] : []), ...(refps ? ['fps30'] : []), ...(src.hasAudio ? ['mute'] : [])],
  };
}

/**
 * 素材加工：按 focal 智能裁切（分辨率不够返回降级版式，不硬放大）→ 统一 LUT → 向人物背景白平衡微调；
 * 视频另外避开内部剪辑点选 2–4 秒平稳段、60fps 升格 0.5×、统一 30fps、去音轨、H.264。
 * modified 记录做过的加工（写进 credits.json）。
 */
export async function processAsset(input: ProcessInput, out: string, ctx: ProcessContext): Promise<ProcessResult> {
  try {
    return await processOnce(input, out, ctx);
  } catch (err) {
    throw new Error(`素材加工失败（${basename(input.file)}）：${err instanceof Error ? err.message : String(err)}`);
  }
}

async function processOnce(input: ProcessInput, out: string, ctx: ProcessContext): Promise<ProcessResult> {
  const file = resolve(input.file);
  const cwd = dirname(resolve(ctx.lut));
  const src = await probeSource(file, input, ffprobeOf(ctx));
  const plan = planCrop(src, input.focal, input.target);
  const geo = geometryFilters(src, plan);
  const seg = input.kind === 'video'
    ? pickSegment(await analyzeVideo(ctx.ffmpeg, file), { fps: src.fps, durationSec: Math.min(src.durationSec, ANALYZE_MAX_SEC), wantSec: input.wantSec })
    : undefined;
  const graded = [...geo.filters, lutFilter(ctx.lut)];
  const ref = ctx.whiteBalance;
  const gains = ref ? wbGains(await measureMean(ctx.ffmpeg, file, graded, cwd, seg), [ref.r, ref.g, ref.b]) : undefined;
  const wb = gains && needsWb(gains) ? [wbFilter(gains)] : [];
  const timing = seg ? timingFilters(src, seg) : { filters: [], modified: [] };
  const vf = [...graded, ...wb, ...timing.filters].join(',');
  await encodeTo(resolve(out), (tmp) => run(ctx.ffmpeg, seg ? videoArgs(file, vf, seg, tmp) : photoArgs(file, vf, tmp), { cwd }).then(() => undefined));
  return {
    file: out,
    ...(seg ? { durationSec: seg.outSec } : {}),
    modified: [...geo.modified, ...timing.modified, 'lut', ...(wb.length ? ['wb'] : [])],
    ...(plan.downgrade ? { downgrade: plan.downgrade } : {}),
  };
}
