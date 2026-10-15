import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import ort from 'onnxruntime-node';
import type { AppConfig } from '../config.js';
import { loadBackgroundRgb } from '../background/prepare.js';
import { probe, type MediaInfo } from '../media/probe.js';
import { runBuffer } from '../media/exec.js';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { alphaBox, chooseDownsample, colorMatchGains, compositeFrame, foregroundMean, meanRgb, medianBox, type Rgb, type SubjectBox } from './composite.js';

export const RVM_FILE = 'rvm_mobilenetv3_fp32.onnx';
const OUT_FPS = 30;
/** 估计人物平均色时抽取的帧数 */
const SAMPLE_FRAMES = 8;
/** 每隔多少帧记录一次取景框与进度 */
const BOX_EVERY = 15;
const DEFAULT_BLUR = 6;

export interface MatteOptions {
  input: string; output: string; backgroundPath: string; cfg: AppConfig; blurSigma?: number; colorMatch?: boolean; onProgress?: (done: number, total: number) => void;
  /** 取消信号：逐帧检查，取消时抛 CancelledError 并结束子进程 */
  signal?: AbortSignal;
  /** 同时把 alpha 遮罩存成灰度视频（30fps、与 input 同尺寸）；之后换背景只需合成（见 composite-matte.ts），不必重新推理 */
  matteOutput?: string;
}
/** fgMean：人物平均色（与背景无关，换背景时据此重算增益）；抠不出人或关闭调色时为 null */
export interface MatteResult { frames: number; subject: SubjectBox | null; gains: Rgb; fps: number; fgMean: Rgb | null }

export function rvmReady(modelsDir: string): boolean {
  return existsSync(join(modelsDir, RVM_FILE));
}

type Recurrent = Record<'r1i' | 'r2i' | 'r3i' | 'r4i', ort.Tensor>;
const zeroState = (): Recurrent => {
  const z = (): ort.Tensor => new ort.Tensor('float32', new Float32Array(1), [1, 1, 1, 1]);
  return { r1i: z(), r2i: z(), r3i: z(), r4i: z() };
};

/** 一个 RVM 推理会话：保存循环状态，逐帧推理（rgb24 交错 → fgr 平面 CHW 与 pha） */
class RvmSession {
  private state = zeroState();
  private readonly src: Float32Array;
  private readonly dsr: ort.Tensor;
  private constructor(private readonly session: ort.InferenceSession, private readonly w: number, private readonly h: number) {
    this.src = new Float32Array(3 * w * h);
    this.dsr = new ort.Tensor('float32', new Float32Array([chooseDownsample(w, h)]), [1]);
  }
  static async create(modelsDir: string, w: number, h: number): Promise<RvmSession> {
    if (!rvmReady(modelsDir)) throw new Error(`缺少抠像模型 ${RVM_FILE}，请先运行 pnpm fetch-models`);
    const session = await ort.InferenceSession.create(join(modelsDir, RVM_FILE), { executionProviders: ['cpu'] });
    return new RvmSession(session, w, h);
  }
  async infer(rgb: Buffer): Promise<{ fgr: Float32Array; pha: Float32Array }> {
    const plane = this.w * this.h;
    for (let i = 0; i < plane; i += 1) {
      this.src[i] = rgb[i * 3] / 255;
      this.src[plane + i] = rgb[i * 3 + 1] / 255;
      this.src[2 * plane + i] = rgb[i * 3 + 2] / 255;
    }
    const o = await this.session.run({ src: new ort.Tensor('float32', this.src, [1, 3, this.h, this.w]), ...this.state, downsample_ratio: this.dsr });
    this.state = { r1i: o.r1o, r2i: o.r2o, r3i: o.r3o, r4i: o.r4o };
    return { fgr: o.fgr.data as Float32Array, pha: o.pha.data as Float32Array };
  }
  reset(): void {
    this.state = zeroState();
  }
  /** 释放 ORT 原生会话（模型权重与推理缓冲区），用完必须调用 */
  release(): Promise<void> {
    return this.session.release();
  }
}

/** 启动 ffmpeg 解码为 rgb24 原始帧流 */
function decoder(cfg: AppConfig, input: string, vf: string): ChildProcessWithoutNullStreams {
  const p = spawn(cfg.ffmpeg, ['-v', 'error', '-nostdin', '-i', input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  p.stdin.on('error', () => {}); // 解码器不读 stdin，进程提前退出时的 EPIPE 无需处理
  return p;
}

/** 进程结束；非 0 退出时带 stderr 报错。返回的 promise 已挂空 catch，不会成为未处理的 rejection */
function exited(p: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} 失败（退出码 ${code}）：${stderr.slice(-800)}`))));
  });
  done.catch(() => {});
  return done;
}

const killAll = (...ps: ChildProcessWithoutNullStreams[]): void => {
  for (const p of ps) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
};

const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 从 rgb24 流里按整帧切出，逐帧回调（回调可 await，以此形成背压）；chunk 只在凑够一帧时才合并一次 */
async function forEachFrame(p: ChildProcessWithoutNullStreams, frameBytes: number, onFrame: (frame: Buffer) => Promise<void>): Promise<void> {
  let chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of p.stdout) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    if (length < frameBytes) continue;
    let pending = Buffer.concat(chunks, length);
    while (pending.length >= frameBytes) {
      await onFrame(pending.subarray(0, frameBytes));
      pending = pending.subarray(frameBytes);
    }
    chunks = pending.length > 0 ? [pending] : [];
    length = pending.length;
  }
}

/** 均匀抽 SAMPLE_FRAMES 帧逐帧独立推理，估计人物平均色；抠不出人时返回 null */
async function sampleForeground(rvm: RvmSession, opts: MatteOptions, w: number, h: number, durationSec: number): Promise<Rgb | null> {
  const p = decoder(opts.cfg, opts.input, `fps=${SAMPLE_FRAMES / Math.max(durationSec, 0.1)}`);
  const done = exited(p, '抽帧');
  const means: Rgb[] = [];
  try {
    await forEachFrame(p, w * h * 3, async (frame) => {
      throwIfCancelled(opts.signal);
      rvm.reset();
      const { fgr, pha } = await rvm.infer(frame);
      const m = foregroundMean(fgr, pha, w * h);
      if (m) means.push(m);
    });
    await done;
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`抠像取样失败：${reasonOf(e)}`);
  } finally {
    killAll(p);
  }
  rvm.reset();
  if (means.length === 0) return null;
  return [0, 1, 2].map((c) => means.reduce((s, m) => s + m[c], 0) / means.length) as unknown as Rgb;
}

/** tmp：编码进程写入的临时文件，成功后改名为 output */
interface Encoder { proc: ChildProcessWithoutNullStreams; done: Promise<void>; write: (frame: Buffer) => Promise<void>; broken: () => boolean; tmp: string; output: string }

/** 先写临时文件，成功后再改名：取消或失败时不破坏已有的好文件 */
const tmpOf = (output: string): string => `${output}.${randomUUID().slice(0, 8)}.tmp.mp4`;

/** 换背景成片的编码参数：rgb24 原始帧 + 输入音轨直接拷贝 */
const personArgs = (opts: MatteOptions, tmp: string, w: number, h: number): string[] => ['-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(OUT_FPS), '-i', '-',
  '-i', opts.input, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', tmp];

/** 灰度遮罩的编码参数：alpha 量化到 0–255 的全范围 gray，crf 10 近无损（实测渐变往返误差 0） */
const matteArgs = (tmp: string, w: number, h: number): string[] => ['-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-r', String(OUT_FPS), '-i', '-',
  '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '10', '-pix_fmt', 'gray', tmp];

/** 启动 x264 编码进程；write 带背压，编码进程退出/出错时立即抛错而不会挂起 */
function startEncoder(cfg: AppConfig, args: string[], tmp: string, output: string): Encoder {
  const proc = spawn(cfg.ffmpeg, args);
  const done = exited(proc, '编码');
  let broken: Error | null = null;
  proc.stdin.on('error', (e) => { broken ??= e; });
  const write = async (frame: Buffer): Promise<void> => {
    if (broken) throw broken;
    if (proc.stdin.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve(); };
      const onDead = (): void => { cleanup(); reject(broken ?? new Error('编码进程已提前退出')); };
      const cleanup = (): void => { proc.stdin.off('drain', onDrain); proc.stdin.off('error', onDead); proc.off('close', onDead); };
      proc.stdin.once('drain', onDrain);
      proc.stdin.once('error', onDead);
      proc.once('close', onDead);
    });
  };
  return { proc, done, write, broken: () => broken !== null, tmp, output };
}

const isDead = (enc: Encoder): boolean => enc.broken() || enc.proc.exitCode !== null || enc.proc.signalCode !== null;

/** 失败后取根因：某个编码进程自己先挂掉（写管道出错或已退出）时，用它的 stderr 作为原因 */
async function rootCause(err: unknown, encs: Encoder[]): Promise<string> {
  for (const enc of encs.filter(isDead)) {
    try {
      await enc.done;
    } catch (e) {
      return reasonOf(e);
    }
  }
  return reasonOf(err);
}

/** 整段抠像换背景：解码 → RVM → 合成 → x264 编码（30fps），音轨从输入直接拷贝；给了 matteOutput 时同时输出灰度遮罩视频 */
export async function matteVideo(opts: MatteOptions): Promise<MatteResult> {
  throwIfCancelled(opts.signal);
  const media = await probe(opts.input, opts.cfg);
  const rvm = await RvmSession.create(opts.cfg.modelsDir, media.width, media.height);
  try {
    return await matteWith(rvm, opts, media);
  } finally {
    await rvm.release();
  }
}

/** alpha（0–1 浮点）量化成 gray 字节 */
function alphaBytes(pha: Float32Array, out: Buffer): Buffer {
  for (let i = 0; i < pha.length; i += 1) out[i] = Math.round(Math.min(1, Math.max(0, pha[i])) * 255);
  return Buffer.from(out);
}

/** 打开成片编码器，以及（需要时）遮罩编码器 */
function openEncoders(opts: MatteOptions, w: number, h: number): Encoder[] {
  const person = tmpOf(opts.output);
  const encs = [startEncoder(opts.cfg, personArgs(opts, person, w, h), person, opts.output)];
  if (!opts.matteOutput) return encs;
  const matte = tmpOf(opts.matteOutput);
  return [...encs, startEncoder(opts.cfg, matteArgs(matte, w, h), matte, opts.matteOutput)];
}

/** 全部编码器收尾并改名（全部成功才改名，避免成片与遮罩不配套） */
async function closeEncoders(encs: Encoder[]): Promise<void> {
  for (const enc of encs) enc.proc.stdin.end();
  await Promise.all(encs.map((enc) => enc.done));
  for (const enc of encs) renameSync(enc.tmp, enc.output);
}

async function matteWith(rvm: RvmSession, opts: MatteOptions, media: MediaInfo): Promise<MatteResult> {
  const { width: w, height: h } = media;
  const bg = await loadBackgroundRgb(opts.backgroundPath, w, h, opts.blurSigma ?? DEFAULT_BLUR, opts.cfg);
  const fgMean = opts.colorMatch === false ? null : await sampleForeground(rvm, opts, w, h, media.durationSec);
  const gains: Rgb = fgMean ? colorMatchGains(fgMean, meanRgb(bg)) : [1, 1, 1];
  const total = Math.round(media.durationSec * OUT_FPS);
  const dec = decoder(opts.cfg, opts.input, `fps=${OUT_FPS}`);
  const decDone = exited(dec, '解码');
  const encs = openEncoders(opts, w, h);
  const [person, matte] = encs;
  const out = Buffer.alloc(w * h * 3);
  const alpha = Buffer.alloc(w * h);
  const boxes: SubjectBox[] = [];
  let frames = 0;
  try {
    await forEachFrame(dec, w * h * 3, async (frame) => {
      throwIfCancelled(opts.signal);
      const { fgr, pha } = await rvm.infer(frame);
      compositeFrame(fgr, pha, bg, gains, out);
      await Promise.all([person.write(Buffer.from(out)), ...(matte ? [matte.write(alphaBytes(pha, alpha))] : [])]);
      frames += 1;
      if (frames % BOX_EVERY !== 0) return;
      const box = alphaBox(pha, w, h);
      if (box) boxes.push(box);
      opts.onProgress?.(frames, total);
    });
    await decDone;
    await closeEncoders(encs);
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`抠像换背景失败（已处理 ${frames} 帧）：${await rootCause(e, encs)}`);
  } finally {
    killAll(dec, ...encs.map((enc) => enc.proc));
    for (const enc of encs) rmSync(enc.tmp, { force: true });
  }
  opts.onProgress?.(frames, total);
  return { frames, subject: medianBox(boxes), gains, fps: OUT_FPS, fgMean };
}

/** 单帧抠像裁切时，人物外接框四周留的边距（相对宽高） */
const CUTOUT_MARGIN = 0.03;
/** 外接框只看 alpha 明显不透明的像素，避免发丝外的半透明噪点把框撑大 */
const CUTOUT_THRESHOLD = 0.1;
/** 某一列有这么多比例的行是人物，就认为人物在这一侧被原画面截断 */
const EDGE_TOUCH = 0.05;
/** 被截断的一侧在裁切宽度的这一比例内把 alpha 渐隐，封面上不出现竖直切边 */
const EDGE_FADE = 0.18;

export interface Cutout { rgba: Buffer; width: number; height: number; found: boolean }
/** fadeCutSides：被原画面截断的左右侧是否渐隐（默认是；加描边的风格保留硬切边，否则描边会断在渐隐带里） */
export interface CutoutOptions { fadeCutSides?: boolean }

const touchesColumn = (pha: Float32Array, w: number, h: number, x: number): boolean => {
  let rows = 0;
  for (let y = 0; y < h; y += 1) if (pha[y * w + x] > 0.5) rows += 1;
  return rows >= h * EDGE_TOUCH;
};

/** 裁切框：alpha 外接框加边距并限制在画面内；没有人物时为整帧 */
function cropRect(pha: Float32Array, w: number, h: number, margin: number): { left: number; top: number; cw: number; ch: number; found: boolean } {
  const box = alphaBox(pha, w, h, CUTOUT_THRESHOLD);
  if (!box) return { left: 0, top: 0, cw: w, ch: h, found: false };
  const left = Math.max(0, Math.floor((box.left - margin) * w));
  const top = Math.max(0, Math.floor((box.top - margin) * h));
  const right = Math.min(w, Math.ceil((box.right + margin) * w));
  const bottom = Math.min(h, Math.ceil((box.bottom + margin) * h));
  return { left, top, cw: right - left, ch: bottom - top, found: true };
}

/** 每列的 alpha 系数：人物在左/右被原画面截断时，该侧按 smoothstep 渐隐 */
function sideFade(pha: Float32Array, w: number, h: number, rect: { left: number; cw: number }): Float32Array {
  const fadeLeft = rect.left === 0 && touchesColumn(pha, w, h, 0);
  const fadeRight = rect.left + rect.cw === w && touchesColumn(pha, w, h, w - 1);
  const band = Math.max(1, Math.round(EDGE_FADE * rect.cw));
  const smooth = (t: number): number => (t >= 1 ? 1 : t * t * (3 - 2 * t));
  return Float32Array.from({ length: rect.cw }, (_, x) => Math.min(fadeLeft ? smooth((x + 0.5) / band) : 1, fadeRight ? smooth((rect.cw - x - 0.5) / band) : 1));
}

/** fgr（CHW 平面）+ pha → 交错 RGBA，按 alpha 外接框（含边距，不超出画面）裁切，被截断的左右侧默认渐隐；没有人物时返回整帧 */
export function cutoutRgba(fgr: Float32Array, pha: Float32Array, w: number, h: number, opts: CutoutOptions = {}): Cutout {
  const rect = cropRect(pha, w, h, CUTOUT_MARGIN);
  const fade = rect.found && opts.fadeCutSides !== false ? sideFade(pha, w, h, rect) : new Float32Array(rect.cw).fill(1);
  const plane = w * h;
  const rgba = Buffer.alloc(rect.cw * rect.ch * 4);
  for (let y = 0; y < rect.ch; y += 1) {
    for (let x = 0; x < rect.cw; x += 1) {
      const src = (rect.top + y) * w + rect.left + x;
      const dst = (y * rect.cw + x) * 4;
      rgba[dst] = Math.round(fgr[src] * 255);
      rgba[dst + 1] = Math.round(fgr[plane + src] * 255);
      rgba[dst + 2] = Math.round(fgr[2 * plane + src] * 255);
      rgba[dst + 3] = Math.round(pha[src] * fade[x] * 255);
    }
  }
  return { rgba, width: rect.cw, height: rect.ch, found: rect.found };
}

/** 把 RGBA 原始像素经 ffmpeg 编码成 PNG（保留透明通道） */
async function encodePng(cfg: AppConfig, rgba: Buffer, w: number, h: number, output: string): Promise<void> {
  const p = spawn(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${w}x${h}`, '-i', '-', '-frames:v', '1', '-pix_fmt', 'rgba', output]);
  const done = exited(p, 'PNG 编码');
  p.stdin.on('error', () => {}); // 编码进程提前退出时以 exited 的报错为准
  p.stdin.end(rgba);
  await done;
}

/** 单帧抠像：抽取 sec 处一帧 → RVM 推理（循环状态为零）→ 按人物外接框裁切的 RGBA PNG */
export async function cutoutFrame(input: string, sec: number, output: string, cfg: AppConfig, opts: CutoutOptions = {}): Promise<Omit<Cutout, 'rgba'>> {
  const { width: w, height: h } = await probe(input, cfg);
  const rgb = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-nostdin', '-ss', String(Math.max(0, sec)), '-i', input, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  if (rgb.length !== w * h * 3) throw new Error(`抽帧失败：${sec.toFixed(2)} 秒处没有取到完整画面`);
  const rvm = await RvmSession.create(cfg.modelsDir, w, h);
  try {
    const { fgr, pha } = await rvm.infer(rgb);
    const cut = cutoutRgba(fgr, pha, w, h, opts);
    await encodePng(cfg, cut.rgba, cut.width, cut.height, output);
    return { width: cut.width, height: cut.height, found: cut.found };
  } finally {
    await rvm.release();
  }
}
