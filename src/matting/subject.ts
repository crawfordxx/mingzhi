import type { AppConfig } from '../config.js';
import { probe } from '../media/probe.js';
import { rethrowIfCancelled, throwIfCancelled } from '../cancel.js';
import { alphaBox, medianBox, type SubjectBox } from './composite.js';
import { decoder, exited, forEachFrame, killAll, reasonOf } from './ffmpeg-io.js';
import { RvmSession } from './rvm.js';

// 不换背景时的人物取景：在剪切后的视频上均匀抽几帧、低分辨率跑 RVM，只取 alpha 求人物框（本地，不花钱）

const MIN_FRAMES = 6;
const MAX_FRAMES = 10;
/** 约每 2 秒抽一帧 */
const SECONDS_PER_FRAME = 2;
/** 取景只要外接框，长边 320 足够；比抠像成片的 512 再小一档 */
const LONG_SIDE = 320;

/** 抽样帧数：约每 2 秒一帧，限制在 6–10 之间 */
export const sampleCount = (durationSec: number): number =>
  Math.min(MAX_FRAMES, Math.max(MIN_FRAMES, Math.round(durationSec / SECONDS_PER_FRAME)));

const even = (v: number): number => Math.max(2, 2 * Math.round(v / 2));

/** 长边缩到 LONG_SIDE，保持比例并取偶数；小视频不放大 */
export function lowResSize(width: number, height: number): { width: number; height: number } {
  const k = Math.min(1, LONG_SIDE / Math.max(width, height));
  return k === 1 ? { width, height } : { width: even(width * k), height: even(height * k) };
}

/** 各帧 alpha 的人物外接框逐边取中位数；没人（所有帧都没有前景）返回 null */
export function subjectFromAlphas(phas: Float32Array[], width: number, height: number): SubjectBox | null {
  const boxes = phas.flatMap((pha) => alphaBox(pha, width, height) ?? []);
  return medianBox(boxes);
}

export interface DetectOptions { signal?: AbortSignal }

/**
 * 在视频上均匀抽 6–10 帧，每帧独立（循环状态清零）低分辨率推理，求人物框。
 * 画面里没人返回 null；模型缺失、解码失败等抛出带原因的错误（调用方决定降级）
 */
export async function detectSubject(input: string, cfg: AppConfig, opts: DetectOptions = {}): Promise<SubjectBox | null> {
  throwIfCancelled(opts.signal);
  const media = await probe(input, cfg);
  const { width: w, height: h } = lowResSize(media.width, media.height);
  const rvm = await RvmSession.create(cfg.modelsDir, w, h);
  const p = decoder(cfg, input, `fps=${sampleCount(media.durationSec) / Math.max(media.durationSec, 0.1)},scale=${w}:${h}`);
  const done = exited(p, '抽帧');
  const phas: Float32Array[] = [];
  try {
    await forEachFrame(p, w * h * 3, async (frame) => {
      throwIfCancelled(opts.signal);
      rvm.reset();
      phas.push(Float32Array.from((await rvm.infer(frame)).pha));
    });
    await done;
  } catch (e) {
    rethrowIfCancelled(e);
    throw new Error(`人物取景失败：${reasonOf(e)}`);
  } finally {
    killAll(p);
    await rvm.release();
  }
  return subjectFromAlphas(phas, w, h);
}
