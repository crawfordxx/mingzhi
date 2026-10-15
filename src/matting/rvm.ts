import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ort from 'onnxruntime-node';
import type { AppConfig } from '../config.js';
import { loadBackgroundRgb } from '../background/prepare.js';
import { probe } from '../media/probe.js';
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
}

/** 启动 ffmpeg 解码为 rgb24 原始帧流 */
function decoder(cfg: AppConfig, input: string, vf: string): ChildProcessWithoutNullStreams {
  return spawn(cfg.ffmpeg, ['-v', 'error', '-i', input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
}

/** 进程结束；非 0 退出时带 stderr 报错 */
function exited(p: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  return new Promise((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} 失败（退出码 ${code}）：${stderr.slice(-800)}`))));
  });
}

/** 从 rgb24 流里按整帧切出，逐帧回调（回调可 await，以此形成背压） */
async function forEachFrame(p: ChildProcessWithoutNullStreams, frameBytes: number, onFrame: (frame: Buffer) => Promise<void>): Promise<void> {
  let pending = Buffer.alloc(0);
  for await (const chunk of p.stdout) {
    pending = Buffer.concat([pending, chunk as Buffer]);
    while (pending.length >= frameBytes) {
      await onFrame(Buffer.from(pending.subarray(0, frameBytes)));
      pending = pending.subarray(frameBytes);
    }
  }
}

/** 均匀抽 SAMPLE_FRAMES 帧逐帧独立推理，估计人物平均色；抠不出人时返回 null */
async function sampleForeground(rvm: RvmSession, opts: MatteOptions, w: number, h: number, durationSec: number): Promise<Rgb | null> {
  const p = decoder(opts.cfg, opts.input, `fps=${SAMPLE_FRAMES / Math.max(durationSec, 0.1)}`);
  const done = exited(p, '抽帧');
  const means: Rgb[] = [];
  await forEachFrame(p, w * h * 3, async (frame) => {
    rvm.reset();
    const { fgr, pha } = await rvm.infer(frame);
    const m = foregroundMean(fgr, pha, w * h);
    if (m) means.push(m);
  });
  await done;
  rvm.reset();
  if (means.length === 0) return null;
  return [0, 1, 2].map((c) => means.reduce((s, m) => s + m[c], 0) / means.length) as unknown as Rgb;
}

/** 整段抠像换背景：解码 → RVM → 合成 → x264 编码（30fps），音轨从输入直接拷贝 */
export async function matteVideo(opts: MatteOptions): Promise<MatteResult> {
  const media = await probe(opts.input, opts.cfg);
  const { width: w, height: h } = media;
  const rvm = await RvmSession.create(opts.cfg.modelsDir, w, h);
  const bg = await loadBackgroundRgb(opts.backgroundPath, w, h, opts.blurSigma ?? DEFAULT_BLUR, opts.cfg);
  const fgMean = opts.colorMatch === false ? null : await sampleForeground(rvm, opts, w, h, media.durationSec);
  const gains: Rgb = fgMean ? colorMatchGains(fgMean, meanRgb(bg)) : [1, 1, 1];
  const total = Math.round(media.durationSec * OUT_FPS);

  const dec = decoder(opts.cfg, opts.input, `fps=${OUT_FPS}`);
  const enc = spawn(opts.cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${w}x${h}`, '-r', String(OUT_FPS), '-i', '-',
    '-i', opts.input, '-map', '0:v', '-map', '1:a?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-c:a', 'copy', '-shortest', opts.output]);
  const decDone = exited(dec, '解码');
  const encDone = exited(enc, '编码');
  const out = Buffer.alloc(w * h * 3);
  const boxes: SubjectBox[] = [];
  let frames = 0;
  await forEachFrame(dec, w * h * 3, async (frame) => {
    const { fgr, pha } = await rvm.infer(frame);
    compositeFrame(fgr, pha, bg, gains, out);
    if (!enc.stdin.write(Buffer.from(out))) await new Promise((r) => enc.stdin.once('drain', r));
    frames += 1;
    if (frames % BOX_EVERY === 0) {
      const box = alphaBox(pha, w, h);
      if (box) boxes.push(box);
      opts.onProgress?.(frames, total);
    }
  });
  await decDone;
  enc.stdin.end();
  await encDone;
  opts.onProgress?.(frames, total);
  return { frames, subject: medianBox(boxes), gains, fps: OUT_FPS };
}
