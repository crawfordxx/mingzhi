import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ort from 'onnxruntime-node';
import type { AppConfig } from '../config.js';
import { loadBackgroundRgb } from '../background/prepare.js';
import { probe, type MediaInfo } from '../media/probe.js';
import { runBuffer } from '../media/exec.js';
import { alphaBox, chooseDownsample, colorMatchGains, compositeFrame, foregroundMean, meanRgb, medianBox, type Rgb, type SubjectBox } from './composite.js';

export const RVM_FILE = 'rvm_mobilenetv3_fp32.onnx';
const OUT_FPS = 30;
/** 估计人物平均色时抽取的帧数 */
const SAMPLE_FRAMES = 8;
/** 每隔多少帧记录一次取景框与进度 */
const BOX_EVERY = 15;
const DEFAULT_BLUR = 6;

export interface MatteOptions { input: string; output: string; backgroundPath: string; cfg: AppConfig; blurSigma?: number; colorMatch?: boolean; onProgress?: (done: number, total: number) => void }
export interface MatteResult { frames: number; subject: SubjectBox | null; gains: Rgb; fps: number }

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
      rvm.reset();
      const { fgr, pha } = await rvm.infer(frame);
      const m = foregroundMean(fgr, pha, w * h);
      if (m) means.push(m);
    });
    await done;
  } catch (e) {
    throw new Error(`抠像取样失败：${reasonOf(e)}`);
  } finally {
    killAll(p);
  }
  rvm.reset();
  if (means.length === 0) return null;
  return [0, 1, 2].map((c) => means.reduce((s, m) => s + m[c], 0) / means.length) as unknown as Rgb;
}

interface Encoder { proc: ChildProcessWithoutNullStreams; done: Promise<void>; write: (frame: Buffer) => Promise<void> }

/** 启动 x264 编码进程；write 带背压，编码进程退出/出错时立即抛错而不会挂起 */
function startEncoder(opts: MatteOptions, w: number, h: number): Encoder {
  const proc = spawn(opts.cfg.ffmpeg, ['-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(OUT_FPS), '-i', '-',
    '-i', opts.input, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', opts.output]);
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
  return { proc, done, write };
}

/** 失败后取根因：编码进程自己先挂掉时，用它的 stderr 作为原因 */
async function rootCause(err: unknown, enc: Encoder): Promise<string> {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (code !== 'EPIPE' && code !== 'ERR_STREAM_DESTROYED' && enc.proc.exitCode === null) return reasonOf(err);
  try {
    await enc.done;
  } catch (e) {
    return reasonOf(e);
  }
  return reasonOf(err);
}

/** 整段抠像换背景：解码 → RVM → 合成 → x264 编码（30fps），音轨从输入直接拷贝 */
export async function matteVideo(opts: MatteOptions): Promise<MatteResult> {
  const media = await probe(opts.input, opts.cfg);
  const rvm = await RvmSession.create(opts.cfg.modelsDir, media.width, media.height);
  try {
    return await matteWith(rvm, opts, media);
  } finally {
    await rvm.release();
  }
}

async function matteWith(rvm: RvmSession, opts: MatteOptions, media: MediaInfo): Promise<MatteResult> {
  const { width: w, height: h } = media;
  const bg = await loadBackgroundRgb(opts.backgroundPath, w, h, opts.blurSigma ?? DEFAULT_BLUR, opts.cfg);
  const fgMean = opts.colorMatch === false ? null : await sampleForeground(rvm, opts, w, h, media.durationSec);
  const gains: Rgb = fgMean ? colorMatchGains(fgMean, meanRgb(bg)) : [1, 1, 1];
  const total = Math.round(media.durationSec * OUT_FPS);

  const dec = decoder(opts.cfg, opts.input, `fps=${OUT_FPS}`);
  const decDone = exited(dec, '解码');
  const enc = startEncoder(opts, w, h);
  const out = Buffer.alloc(w * h * 3);
  const boxes: SubjectBox[] = [];
  let frames = 0;
  try {
    await forEachFrame(dec, w * h * 3, async (frame) => {
      const { fgr, pha } = await rvm.infer(frame);
      compositeFrame(fgr, pha, bg, gains, out);
      await enc.write(Buffer.from(out));
      frames += 1;
      if (frames % BOX_EVERY === 0) {
        const box = alphaBox(pha, w, h);
        if (box) boxes.push(box);
        opts.onProgress?.(frames, total);
      }
    });
    await decDone;
    enc.proc.stdin.end();
    await enc.done;
  } catch (e) {
    const reason = await rootCause(e, enc);
    throw new Error(`抠像换背景失败（已处理 ${frames} 帧）：${reason}`);
  } finally {
    killAll(dec, enc.proc);
  }
  opts.onProgress?.(frames, total);
  return { frames, subject: medianBox(boxes), gains, fps: OUT_FPS };
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
