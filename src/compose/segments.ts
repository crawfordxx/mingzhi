import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captionAt, shotAt } from './layout.js';
import { renderAudioTrack, renderVideoSegment, withBundle } from './render.js';
import { transformAt } from '../../render/layers/PersonLayer.js';
import { DEFAULT_CAPTION_STYLE } from '../captions/styles.js';
import { run } from '../media/exec.js';
import { CANVAS, type Shot, type TalkProps } from '../storyboard/schema.js';

export interface FrameRange { start: number; end: number }
/** shots：完整镜头列表（用于相邻镜头、转场、是否末镜头）；range：本段帧区间 [start,end)；salt：画面素材与渲染代码的指纹 */
export interface HashContext { shots?: Shot[]; range?: FrameRange; salt?: string }

const sha1 = (text: string): string => createHash('sha1').update(text).digest('hex');
const secToFrame = (sec: number): number => Math.round(sec * CANVAS.fps);

/** 各镜头的帧区间：首段从 0 起、末段到总帧数止，每段起点 = 镜头起点四舍五入，相邻段首尾相接；总帧数 = round(时长×30) */
export function segmentBounds(shots: Shot[], durationSec: number): FrameRange[] {
  const total = secToFrame(durationSec);
  const starts = shots.map((s, i) => (i === 0 ? 0 : Math.min(total, secToFrame(s.start))));
  const monotonic = starts.reduce<number[]>((acc, s) => [...acc, Math.max(s, acc[acc.length - 1] ?? 0)], []);
  return monotonic.map((start, i) => ({ start, end: i + 1 < monotonic.length ? monotonic[i + 1] : total }));
}

/**
 * 本段每一帧的画面指纹，列出所有会影响该帧的因素（逐帧算，宁可多算不少算）：
 * - 该帧落在哪个镜头（含卡片内容、起止时间、是否全片最后一个镜头：末镜头不淡出）；
 *   镜头起点非整帧时，段边缘的帧可能属于相邻镜头，所以按帧而不是按镜头索引判断
 * - 人像位置：由本镜头版式、前一镜头版式与时长（0.4 秒过渡）、取景框、人像尺寸共同决定，直接用渲染用的 transformAt 逐帧算出
 * - 该帧显示的字幕文字（跨镜头边界的字幕会同时进入两段）
 */
function frameFingerprints(props: Omit<TalkProps, 'shots'>, shots: Shot[], range: FrameRange): { shots: unknown[]; frames: string[] } {
  const full: TalkProps = { ...props, shots };
  const seen: number[] = [];
  const frames = Array.from({ length: Math.max(0, range.end - range.start) }, (_, k) => {
    const sec = (range.start + k) / CANVAS.fps;
    const hit = shotAt(shots, sec);
    if (hit && !seen.includes(hit.index)) seen.push(hit.index);
    const t = transformAt(shots, sec, full);
    return `${hit ? seen.indexOf(hit.index) : '-'}|${captionAt(props.captions, sec)?.text ?? ''}|${t.scale}|${t.x}|${t.y}`;
  });
  return { shots: seen.map((i) => ({ shot: shots[i], last: i === shots.length - 1 })), frames };
}

/**
 * 镜头缓存键。index 不参与哈希：镜头只是换了序号而画面没变时应复用缓存。
 * 不带 ctx 时只看该镜头自身（无相邻镜头信息），出片流程必须传 shots 与 range。
 */
export function shotHash(shot: Shot, props: Omit<TalkProps, 'shots'>, _index: number, ctx: HashContext = {}): string {
  const shots = ctx.shots ?? [shot];
  const range = ctx.range ?? { start: secToFrame(shot.start), end: secToFrame(shot.end) };
  const { shots: hit, frames } = frameFingerprints(props, shots, range);
  const head = { v: 1, range, shot, hit, salt: ctx.salt ?? '', person: props.person, w: props.personWidth, h: props.personHeight, subject: props.subject,
    style: props.captionStyle ?? DEFAULT_CAPTION_STYLE, font: props.captionFontFile ?? '' };
  return sha1(`${JSON.stringify(head)}\n${frames.join('\n')}`);
}

// ---- 盐值：素材文件与渲染代码的指纹（同名文件被覆盖、模板代码升级后缓存必须失效）----

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_DIRS = [join(ROOT, 'render'), join(ROOT, 'src', 'captions'), join(ROOT, 'src', 'compose')];
let codeStampCache: string | undefined;

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(dir, e.name)) : /\.(tsx?|json)$/.test(e.name) ? [join(dir, e.name)] : []));
}

/** 渲染代码指纹：render/ 与字幕样式、版式代码的内容哈希（进程内只算一次） */
function codeStamp(): string {
  codeStampCache ??= sha1(CODE_DIRS.flatMap(walk).sort().map((f) => `${f}\n${readFileSync(f, 'utf8')}`).join('\0'));
  return codeStampCache;
}

function fileStamp(workDir: string, name: string | undefined): string {
  if (!name) return '';
  const st = existsSync(join(workDir, name)) ? statSync(join(workDir, name)) : null;
  return st ? `${name}:${st.size}:${Math.round(st.mtimeMs)}` : `${name}:missing`;
}

/** 卡片引用的素材（图片、视频），按镜头收集 */
function shotMedia(shot: Shot | undefined): string[] {
  const p = (shot?.card?.props ?? {}) as { image?: unknown; video?: unknown };
  return [p.image, p.video].filter((v): v is string => typeof v === 'string');
}

/** 第 i 段的盐值：渲染代码 + 人像与字幕字体 + 本镜头及前后相邻镜头引用的素材文件 */
function segmentSalt(workDir: string, props: TalkProps, i: number): string {
  const media = [-1, 0, 1].flatMap((d) => shotMedia(props.shots[i + d]));
  const fonts = props.captionFontFile ? `fonts/${props.captionFontFile}` : undefined;
  return [codeStamp(), fileStamp(workDir, props.person), fileStamp(workDir, fonts), ...media.map((m) => fileStamp(workDir, m))].join('|');
}

// ---- 分段渲染 ----

export interface SegmentedOptions {
  workDir: string; cacheDir: string; props: TalkProps; output: string; ffmpeg?: string;
  onProgress?: (done: number, total: number, reused: number) => void;
}
export interface SegmentedResult { rendered: number[]; reused: number[] }

/** concat 列表里的路径用单引号包裹，路径里的单引号要转义 */
const concatLine = (file: string): string => `file '${file.replace(/'/g, "'\\''")}'`;

/** -t 把 aac 编码补出的尾部静音（约 0.05 秒）裁掉，使音轨不长于画面 */
async function concatWithAudio(opts: { ffmpeg: string; files: string[]; audio: string; listFile: string; output: string; durationSec: number }): Promise<void> {
  writeFileSync(opts.listFile, `${opts.files.map(concatLine).join('\n')}\n`);
  const tmp = `${opts.output}.tmp.mp4`;
  await run(opts.ffmpeg, ['-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', opts.listFile, '-i', opts.audio, '-map', '0:v', '-map', '1:a', '-c', 'copy', '-t', String(opts.durationSec), '-movflags', '+faststart', tmp]);
  renameSync(tmp, opts.output);
}

/** 渲染到临时文件再改名，中途取消不会留下半截缓存 */
async function renderToCache(serveUrl: string, props: TalkProps, range: FrameRange, file: string): Promise<void> {
  const tmp = `${file}.tmp.mp4`;
  try {
    await renderVideoSegment({ serveUrl, props, output: tmp, startFrame: range.start, endFrame: range.end });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 按镜头分段渲染画面（命中缓存则复用），音轨整条单独渲染，最后无损拼接；一次打包用于所有分段 */
export async function renderSegmented(opts: SegmentedOptions): Promise<SegmentedResult> {
  const { workDir, cacheDir, props } = opts;
  mkdirSync(cacheDir, { recursive: true });
  const { shots, ...rest } = props;
  const bounds = segmentBounds(shots, props.durationSec);
  const plan = bounds.map((range, i) => ({ range, i, file: join(cacheDir, `${shotHash(shots[i], rest, i, { shots, range, salt: segmentSalt(workDir, props, i) })}.mp4`) })).filter((s) => s.range.end > s.range.start);
  const rendered: number[] = [];
  const reused: number[] = [];
  const audio = join(workDir, 'audio.m4a');
  await withBundle(workDir, async (serveUrl) => {
    for (const s of plan) {
      if (existsSync(s.file)) reused.push(s.i);
      else {
        await renderToCache(serveUrl, props, s.range, s.file);
        rendered.push(s.i);
      }
      opts.onProgress?.(rendered.length + reused.length, plan.length, reused.length);
    }
    await renderAudioTrack({ serveUrl, props, output: audio });
  });
  await concatWithAudio({ ffmpeg: opts.ffmpeg ?? 'ffmpeg', files: plan.map((s) => s.file), audio, listFile: join(workDir, 'segments.txt'), output: opts.output, durationSec: secToFrame(props.durationSec) / CANVAS.fps });
  return { rendered, reused };
}
