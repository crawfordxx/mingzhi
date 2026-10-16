import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captionAt, captionSec, grainOn, shotAt, underlayAt, visualShots, type PersonTransform } from './layout.js';
import { cardCarry, cardLead } from './card-carry.js';
import { renderAudioTrack, renderVideoSegment, withBundle, type SegmentRenderOptions } from './render.js';
import { transformAt } from '../../render/layers/PersonLayer.js';
import { DEFAULT_CAPTION_STYLE } from '../captions/styles.js';
import { run } from '../media/exec.js';
import { throwIfCancelled } from '../cancel.js';
import { CANVAS, type Shot, type TalkProps } from '../storyboard/schema.js';

export interface FrameRange { start: number; end: number }
/** shots：完整镜头列表（用于相邻镜头、转场、是否末镜头）；range：本段帧区间 [start,end)；salt：画面素材与渲染代码的指纹（见 segmentSalt） */
/**
 * layer：render 是渲染缓存键（含上一张卡的交叉淡出，缺省）；content 是「这个镜头自己的内容」键，不含仅因上一张卡淡出而重渲的部分，
 * 用来判断用户可见的改动（changedShots）。两者其余口径一致
 */
export type HashLayer = 'render' | 'content';
export interface HashContext { shots: Shot[]; range: FrameRange; salt?: string; layer?: HashLayer }

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
 * - 画面按画面时间轴（visualShots）判断：全屏插入的 J-cut 前 2 帧仍是上一个镜头的画面（字幕也按字幕时钟取切点前那句）；
 *   镜头的版式与素材字段（文件、焦点、Ken Burns、时长）随镜头进入指纹；画中画退出过渡里垫底的上一镜素材也计入
 * - 卡片交叉过渡：镜头开头 0.3 秒里仍在淡出的上一张卡（镜头与淡出进度）也计入；从无卡镜头切进分屏时卡片时钟提前（cardLead）也计入
 */
function frameFingerprints(props: Omit<TalkProps, 'shots'>, shots: Shot[], range: FrameRange, layer: HashLayer = 'render'): { shots: unknown[]; frames: string[] } {
  const vis = visualShots(shots);
  const full: TalkProps = { ...props, shots: vis };
  const secs = frameSecs(range);
  const hits = secs.map((sec) => shotAt(vis, sec)?.index ?? -1);
  const unders = secs.map((sec) => underlayAt(vis, sec)?.index ?? -1);
  const carries = secs.map((sec) => (layer === 'render' ? cardCarry(vis, sec) : null));
  const seen = [...new Set([...hits, ...unders, ...carries.map((c) => c?.index ?? -1)].filter((i) => i >= 0))];
  const frames = secs.map((sec, k) => {
    const t = transformAt(vis, sec, full);
    const under = unders[k] < 0 || unders[k] === hits[k] ? '' : `|u${seen.indexOf(unders[k])}`;
    const c = carries[k];
    const carry = c ? `|c${seen.indexOf(c.index)}:${c.t.toFixed(4)}` : '';
    const lead = hits[k] >= 0 && cardLead(vis, hits[k]) > 0 ? '|l' : '';
    return `${hits[k] < 0 ? '-' : seen.indexOf(hits[k])}|${captionAt(props.captions, captionSec(shots, sec))?.text ?? ''}|${t.scale}|${t.x}|${t.y}${clipStamp(t)}${under}${carry}${lead}`;
  });
  return { shots: seen.map((i) => ({ shot: vis[i], last: i === shots.length - 1 })), frames };
}

const frameSecs = (range: FrameRange): number[] => Array.from({ length: Math.max(0, range.end - range.start) }, (_, k) => (range.start + k) / CANVAS.fps);

/** 画中画窗口进指纹；全屏/分屏没有窗口时为空串（与旧指纹格式一致） */
const clipStamp = (t: PersonTransform): string => (t.clip ? `|${t.clip.x},${t.clip.y},${t.clip.w},${t.clip.h},${t.clip.radius}` : '');

/**
 * 镜头缓存键。index 不参与哈希：镜头只是换了序号而画面没变时应复用缓存。
 * ctx 必填：转场、末镜头判断都要看完整镜头列表与本段帧区间。
 */
export function shotHash(shot: Shot, props: Omit<TalkProps, 'shots'>, _index: number, ctx: HashContext): string {
  const { shots, range } = ctx;
  const { shots: hit, frames } = frameFingerprints(props, shots, range, ctx.layer);
  const head = { v: 1, range, shot, hit, salt: ctx.salt ?? '', person: props.person, w: props.personWidth, h: props.personHeight, subject: props.subject,
    style: props.captionStyle ?? DEFAULT_CAPTION_STYLE, font: props.captionFontFile ?? '', ...(grainOn({ ...props, shots }) ? { grain: true } : {}), ...(props.outro && range.end > secToFrame(props.outro.startSec) ? { outro: props.outro } : {}) };
  return sha1(`${JSON.stringify(head)}\n${frames.join('\n')}`);
}

// ---- 盐值：素材文件与渲染代码的指纹（同名文件被覆盖、渲染代码或 Remotion 升级后缓存必须失效）----

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CODE_DIRS = [join(ROOT, 'render'), join(ROOT, 'src')];
const REMOTION_PACKAGES = ['remotion', '@remotion/renderer', '@remotion/bundler'];

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.isDirectory()) return walk(join(dir, e.name));
    return /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [];
  });
}

/** 参与代码指纹的文件清单 */
export const codeFiles = (): string[] => CODE_DIRS.flatMap(walk).sort();

/** 渲染代码指纹：render/ 与 src/ 全部 ts/tsx 的内容哈希 + package.json 里 Remotion 各包的版本（渲染包的传递依赖都在其中，宁多勿少） */
export function codeStamp(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
  const versions = REMOTION_PACKAGES.map((n) => `${n}@${pkg.dependencies?.[n] ?? ''}`).join(',');
  return sha1(`${versions}\0${codeFiles().map((f) => `${f}\n${readFileSync(f, 'utf8')}`).join('\0')}`);
}

/** 一次渲染内共用的指纹器：代码指纹只算一次，每个素材文件只读一次（按相对路径缓存） */
export interface Stamper { code: string; file: (name: string | undefined) => Promise<string> }

function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash('sha1');
    createReadStream(path).on('data', (c) => h.update(c)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/** code 可注入（测试用），缺省为当前渲染代码的指纹 */
export function createStamper(workDir: string, code: string = codeStamp()): Stamper {
  const cache = new Map<string, Promise<string>>();
  const file = (name: string | undefined): Promise<string> => {
    if (!name) return Promise.resolve('');
    const path = join(workDir, name);
    const hit = cache.get(name) ?? (existsSync(path) ? hashFile(path).then((d) => `${name}:${d}`) : Promise.resolve(`${name}:missing`));
    cache.set(name, hit);
    return hit;
  };
  return { code, file };
}

/** 镜头引用的素材（卡片的图片、视频与镜头的 B-roll 素材），按镜头收集 */
function shotMedia(shot: Shot | undefined): string[] {
  const p = (shot?.card?.props ?? {}) as { image?: unknown; video?: unknown };
  return [p.image, p.video, shot?.broll?.file].filter((v): v is string => typeof v === 'string');
}

/** 本段帧区间里实际出现的镜头序号（按画面时间轴；各层每帧只画当前镜头、画中画退出时垫底的上一镜与交叉过渡里淡出的上一张卡，所以只有这些镜头的素材会进画面） */
function shotsInRange(shots: Shot[], range: FrameRange, layer: HashLayer = 'render'): number[] {
  const vis = visualShots(shots);
  const idx = frameSecs(range).flatMap((sec) => [shotAt(vis, sec)?.index ?? -1, underlayAt(vis, sec)?.index ?? -1, layer === 'render' ? cardCarry(vis, sec)?.index ?? -1 : -1]);
  return [...new Set(idx.filter((i) => i >= 0))];
}

/**
 * 第 i 段的盐值：渲染代码 + 人像与字幕字体的内容 + 本段画面里出现的镜头引用的素材内容。
 * 只看本段帧里实际出现的镜头：相邻镜头换了带图的卡片不会让本段被误判为改动（镜头边界不在整帧上时，段边缘的帧属于相邻镜头，照样计入）
 */
export async function segmentSalt(stamper: Stamper, props: TalkProps, i: number, range: FrameRange = segmentBounds(props.shots, props.durationSec)[i], layer: HashLayer = 'render'): Promise<string> {
  const media = shotsInRange(props.shots, range, layer).flatMap((k) => shotMedia(props.shots[k]));
  const fonts = props.captionFontFile ? `fonts/${props.captionFontFile}` : undefined;
  const logo = props.outro && range.end > secToFrame(props.outro.startSec) ? props.outro.logo : undefined;
  const files = await Promise.all([props.person, fonts, logo, ...media].map((n) => stamper.file(n)));
  return [stamper.code, ...files].join('|');
}

// ---- 分段渲染 ----

export interface ConcatOptions { ffmpeg: string; files: string[]; audio: string; listFile: string; output: string; durationSec: number }

/** 打包、分段画面、整条音轨与拼接的实现；缺省为真实的 Remotion + ffmpeg，仅供测试注入假实现 */
export interface SegmentBackend {
  withBundle: <T>(workDir: string, fn: (serveUrl: string) => Promise<T>) => Promise<T>;
  renderVideo: (opts: SegmentRenderOptions & { startFrame: number; endFrame: number }) => Promise<void>;
  renderAudio: (opts: SegmentRenderOptions) => Promise<void>;
  concat: (opts: ConcatOptions) => Promise<void>;
}

export interface SegmentedOptions {
  workDir: string; cacheDir: string; props: TalkProps; output: string; ffmpeg?: string;
  /** 仅供测试注入 */
  backend?: SegmentBackend;
  onProgress?: (done: number, total: number, reused: number) => void;
  /** 取消信号：每段开始前检查，正在渲染的那一段也会被终止（抛 CancelledError，不留半截缓存） */
  signal?: AbortSignal;
}
/** rendered / reused：本次实际重渲与命中缓存的镜头序号；hashes：每个镜头（按序号）的渲染哈希（含交叉淡出）；contents：每个镜头自己内容的哈希（不含交叉淡出），用于和父版本比较用户可见的改动 */
export interface SegmentedResult { rendered: number[]; reused: number[]; hashes: string[]; contents: string[] }

/** concat 列表里的路径用单引号包裹，路径里的单引号要转义 */
const concatLine = (file: string): string => `file '${file.replace(/'/g, "'\\''")}'`;
/** 临时文件名带随机后缀，同一目录并发渲染同一段也不会互相覆盖 */
const tmpName = (file: string): string => `${file}.${randomUUID().slice(0, 8)}.tmp.mp4`;
/** 命中缓存要求文件非空（写满磁盘或外部损坏留下的空文件不复用） */
const cached = (file: string): boolean => existsSync(file) && statSync(file).size > 0;

/** -t 把 aac 编码补出的尾部静音（约 0.05 秒）裁掉，使音轨不长于画面 */
async function concatWithAudio(opts: ConcatOptions): Promise<void> {
  writeFileSync(opts.listFile, `${opts.files.map(concatLine).join('\n')}\n`);
  const tmp = tmpName(opts.output);
  try {
    await run(opts.ffmpeg, [
      '-v', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', opts.listFile, '-i', opts.audio,
      '-map', '0:v', '-map', '1:a', '-c', 'copy', '-t', String(opts.durationSec), '-movflags', '+faststart', tmp,
    ]);
    renameSync(tmp, opts.output);
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** 渲染到临时文件再改名，中途取消不会留下半截缓存 */
async function renderToCache(
  backend: SegmentBackend, serveUrl: string, props: TalkProps, range: FrameRange, file: string, signal?: AbortSignal,
): Promise<void> {
  const tmp = tmpName(file);
  try {
    await backend.renderVideo({ serveUrl, props, output: tmp, startFrame: range.start, endFrame: range.end, signal });
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true });
  }
}

const REAL_BACKEND: SegmentBackend = { withBundle, renderVideo: renderVideoSegment, renderAudio: renderAudioTrack, concat: concatWithAudio };

/** 按镜头分段渲染画面（命中缓存则复用），音轨整条单独渲染，最后无损拼接；一次打包用于所有分段 */
export async function renderSegmented(opts: SegmentedOptions): Promise<SegmentedResult> {
  const { workDir, cacheDir, props } = opts;
  const backend = opts.backend ?? REAL_BACKEND;
  throwIfCancelled(opts.signal);
  const { shots, ...rest } = props;
  if (shots.length === 0) throw new Error('分镜为空，无法分段渲染');
  mkdirSync(cacheDir, { recursive: true });
  const stamper = createStamper(workDir);
  const plan = await Promise.all(segmentBounds(shots, props.durationSec).map(async (range, i) => {
    const salt = await segmentSalt(stamper, props, i, range);
    const hash = shotHash(shots[i], rest, i, { shots, range, salt });
    const content = shotHash(shots[i], rest, i, { shots, range, salt: await segmentSalt(stamper, props, i, range, 'content'), layer: 'content' });
    return { range, i, hash, content, file: join(cacheDir, `${hash}.mp4`) };
  }));
  const todo = plan.filter((s) => s.range.end > s.range.start);
  const audio = join(workDir, 'audio.m4a');
  let done: { i: number; reused: boolean }[] = [];
  await backend.withBundle(workDir, async (serveUrl) => {
    for (const s of todo) {
      const reused = cached(s.file);
      if (!reused) await renderToCache(backend, serveUrl, props, s.range, s.file, opts.signal);
      done = [...done, { i: s.i, reused }];
      opts.onProgress?.(done.length, todo.length, done.filter((d) => d.reused).length);
    }
    await backend.renderAudio({ serveUrl, props, output: audio, signal: opts.signal });
  });
  await backend.concat({
    ffmpeg: opts.ffmpeg ?? 'ffmpeg', files: todo.map((s) => s.file), audio, listFile: join(workDir, 'segments.txt'),
    output: opts.output, durationSec: secToFrame(props.durationSec) / CANVAS.fps,
  });
  return {
    rendered: done.filter((d) => !d.reused).map((d) => d.i),
    reused: done.filter((d) => d.reused).map((d) => d.i),
    hashes: plan.map((s) => s.hash),
    contents: plan.map((s) => s.content),
  };
}
