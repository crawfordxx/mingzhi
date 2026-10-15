import { randomUUID } from 'node:crypto';
import { renameSync, rmSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { loadBackgroundRgb } from '../background/prepare.js';
import { throwIfCancelled } from '../cancel.js';
import { run } from '../media/exec.js';
import { probe } from '../media/probe.js';
import { colorMatchGains, meanRgb, type Rgb } from './composite.js';

const OUT_FPS = 30;
const DEFAULT_BLUR = 6;

export interface CompositeMatteOptions {
  /** 剪切后的原画面（带音轨） */
  input: string;
  /** matteVideo 输出的灰度遮罩视频，与 input 同尺寸、同帧数 */
  matte: string;
  backgroundPath: string;
  output: string;
  /** 抠像时记下的人物平均色；null 时不调色 */
  fgMean: Rgb | null;
  cfg: AppConfig;
  blurSigma?: number;
  signal?: AbortSignal;
}

const fmt = (n: number): string => n.toFixed(4);

/**
 * 滤镜：背景图铺满裁切并虚化（与 loadBackgroundRgb 相同）→ 原画面按增益调色 → 用灰度遮罩作 alpha → 叠到背景上。
 * 在 RGB 平面里混合，公式与 compositeFrame 一致（out = a·fg·增益 + (1−a)·bg），只是前景用原画面而不是 RVM 的去溢色前景。
 */
export function compositeFilter(w: number, h: number, blurSigma: number, gains: Rgb): string {
  const blur = blurSigma > 0 ? `,gblur=sigma=${blurSigma}` : '';
  return [
    `[2:v]scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h}${blur},format=gbrp[bg]`,
    `[0:v]fps=${OUT_FPS},format=gbrp,colorchannelmixer=rr=${fmt(gains[0])}:gg=${fmt(gains[1])}:bb=${fmt(gains[2])}[fg]`,
    `[1:v]fps=${OUT_FPS},format=gray[al]`,
    '[fg][al]alphamerge[fga]',
    '[bg][fga]overlay=shortest=1:format=gbrp,format=yuv420p[out]',
  ].join(';');
}

/** 只用遮罩 + 背景合成换背景视频（纯 ffmpeg，不跑抠像推理）；先写临时文件再改名 */
export async function compositeMatte(opts: CompositeMatteOptions): Promise<void> {
  throwIfCancelled(opts.signal);
  const { width: w, height: h } = await probe(opts.input, opts.cfg);
  const blur = opts.blurSigma ?? DEFAULT_BLUR;
  const bgMean = meanRgb(await loadBackgroundRgb(opts.backgroundPath, w, h, blur, opts.cfg));
  const gains: Rgb = opts.fgMean ? colorMatchGains(opts.fgMean, bgMean) : [1, 1, 1];
  const tmp = `${opts.output}.${randomUUID().slice(0, 8)}.tmp.mp4`;
  try {
    await run(opts.cfg.ffmpeg, [
      '-v', 'error', '-nostdin', '-y', '-i', opts.input, '-i', opts.matte, '-loop', '1', '-framerate', String(OUT_FPS), '-i', opts.backgroundPath,
      '-filter_complex', compositeFilter(w, h, blur, gains), '-map', '[out]', '-map', '0:a?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', '-shortest', tmp,
    ], { signal: opts.signal }).catch((err: unknown) => {
      throwIfCancelled(opts.signal);
      throw new Error(`换背景合成失败：${err instanceof Error ? err.message : String(err)}`);
    });
    renameSync(tmp, opts.output);
  } finally {
    rmSync(tmp, { force: true });
  }
}
