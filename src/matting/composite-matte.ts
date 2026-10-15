import { randomUUID } from 'node:crypto';
import { renameSync, rmSync, writeFileSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { loadBackgroundRgb } from '../background/prepare.js';
import { throwIfCancelled } from '../cancel.js';
import { FPS, type TimeRange } from '../cut/plan.js';
import { run } from '../media/exec.js';
import { probe } from '../media/probe.js';
import { colorMatchGains, meanRgb, type Rgb } from './composite.js';

const DEFAULT_BLUR = 6;

export interface CompositeCutOptions {
  /** 本版本的剪切结果（renderCut 产物）：取它的音轨与画面尺寸 */
  cut: string;
  /**
   * 整条原片的 RVM 去溢色前景与灰度遮罩（matteVideo 的 fgrOutput / matteOutput）。抠像解码按恒定 30fps 从文件起点（0 秒）输出，
   * 视频流比音轨晚开始时开头会补上首帧，所以第 k 帧就是原片 k/30 秒处，与剪切用的时间轴相同，不需要平移（tests/composite-matte.test.ts 覆盖了晚开始的原片）。
   */
  fgr: string;
  matte: string;
  /** 与剪切 cut 时相同的保留区间（原片时间） */
  keep: TimeRange[];
  backgroundPath: string;
  output: string;
  /** 抠像时记下的人物平均色；null 时不调色 */
  fgMean: Rgb | null;
  cfg: AppConfig;
  blurSigma?: number;
  signal?: AbortSignal;
}

/** 与 renderCut 一致：保留 6 位小数 */
const fmt = (n: number): string => String(Math.round(n * 1e6) / 1e6);
const gain = (n: number): string => n.toFixed(4);

/** 按保留区间从整条前景/遮罩里取帧并拼接：取帧链与 buildCutFilter 的画面部分逐项相同（fps=30 → 宽高取偶 → trim → 重置时间戳），帧的选择与剪切完全一致 */
export function trimChain(input: string, keep: TimeRange[], out: string): string {
  if (keep.length === 0) throw new Error('没有可保留的片段，无法合成');
  const parts = keep.map((r, i) => `[${input}]fps=${FPS},scale=trunc(iw/2)*2:trunc(ih/2)*2,trim=start=${fmt(r.start)}:end=${fmt(r.end)},setpts=PTS-STARTPTS[${out}${i}]`);
  // 拼接后按帧序号重排时间戳：拼接处的时间戳可能有零头，叠到恒定帧率的背景上时会被并掉一帧
  return `${parts.join(';')};${keep.map((_, i) => `[${out}${i}]`).join('')}concat=n=${keep.length}:v=1:a=0,setpts=N/(${FPS}*TB)[${out}]`;
}

/**
 * 合成滤镜：背景图铺满裁切并虚化（与 loadBackgroundRgb 相同）→ 前景按增益调色 → 以遮罩为权重在 RGB 平面混合（maskedmerge）。
 * 公式与 compositeFrame 一致：out = a·(fgr·增益) + (1−a)·bg。
 */
export function compositeFilter(o: { w: number; h: number; blurSigma: number; gains: Rgb; keep: TimeRange[] }): string {
  const blur = o.blurSigma > 0 ? `,gblur=sigma=${o.blurSigma}` : '';
  return [
    trimChain('1:v', o.keep, 'fg'),
    trimChain('2:v', o.keep, 'al'),
    `[fg]format=gbrp,colorchannelmixer=rr=${gain(o.gains[0])}:gg=${gain(o.gains[1])}:bb=${gain(o.gains[2])},split[fgc][canvas]`,
    `[3:v]scale=${o.w}:${o.h}:force_original_aspect_ratio=increase,crop=${o.w}:${o.h}${blur},format=gbrp[bgimg]`,
    // 背景帧由前景帧驱动（单张背景图盖满画布并一直沿用），三路帧数与时间戳完全相同，不会在结尾或拼接处丢帧
    '[canvas][bgimg]overlay=eof_action=repeat:format=gbrp[bg]',
    '[al]format=gray,format=gbrp[mask]',
    '[bg][fgc][mask]maskedmerge,format=yuv420p[out]',
  ].join(';');
}

/**
 * 只用整条前景 + 遮罩 + 新背景合成某个剪辑方案的人像（纯 ffmpeg，不跑抠像推理）：
 * 前景与遮罩按 keep 取帧（与剪切逐帧对齐），音轨取自 cut；滤镜写文件再读（长剪辑方案的滤镜串会超命令行长度），先写临时文件再改名。
 */
export async function compositeCut(o: CompositeCutOptions): Promise<void> {
  throwIfCancelled(o.signal);
  const { width: w, height: h } = await probe(o.cut, o.cfg);
  const blurSigma = o.blurSigma ?? DEFAULT_BLUR;
  const bgMean = meanRgb(await loadBackgroundRgb(o.backgroundPath, w, h, blurSigma, o.cfg));
  const gains: Rgb = o.fgMean ? colorMatchGains(o.fgMean, bgMean) : [1, 1, 1];
  const tag = randomUUID().slice(0, 8);
  const tmp = `${o.output}.${tag}.tmp.mp4`;
  const filterFile = `${o.output}.${tag}.filter.txt`;
  writeFileSync(filterFile, compositeFilter({ w, h, blurSigma, gains, keep: o.keep }));
  try {
    await run(o.cfg.ffmpeg, [
      '-v', 'error', '-nostdin', '-y', '-i', o.cut, '-i', o.fgr, '-i', o.matte, '-i', o.backgroundPath,
      '-/filter_complex', filterFile, '-map', '[out]', '-map', '0:a?', '-r', String(FPS),
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-c:a', 'copy', tmp,
    ], { signal: o.signal }).catch((err: unknown) => {
      throwIfCancelled(o.signal);
      throw new Error(`换背景合成失败：${err instanceof Error ? err.message : String(err)}`);
    });
    renameSync(tmp, o.output);
  } finally {
    rmSync(tmp, { force: true });
    rmSync(filterFile, { force: true });
  }
}
