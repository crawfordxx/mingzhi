import { rmSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import { run } from '../media/exec.js';

export const IMAGE_MODEL = 'GPT-Image-2.5-Flare';
export const VIDEO_MODEL = 'KVideo2.0-Mini';

/** Seedance 约 139 秒出片，排队时可能更久，给 25 分钟 */
const VIDEO_TIMEOUT_MS = 25 * 60_000;
/** 统一影调模板：让所有生成画面像同一个摄影师拍的 */
export const STYLE_TEMPLATE = ', editorial photography, soft window light, warm neutral palette, 50mm, shallow depth of field, matte film look, subtle grain, no text';
/** 禁用词：全息、机器人、霓虹、发光这类「AI 科技感」套路 */
export const AVOID_TERMS = ', avoid hologram, robot, neon, glowing (避免全息、机器人、霓虹、发光)';
const STYLE_SUFFIX = `${STYLE_TEMPLATE}${AVOID_TERMS}, no watermark, no logos`;

export type Download = (url: string, dest: string) => Promise<void>;

/** 生图分辨率：1:1 用 1k（约 ¥0.2）；竖屏、横屏等非方图用 2k，短边才够铺 1080 宽的画面 */
const resolutionOf = (size: string): string => (size === '1:1' ? '1k' : '2k');

/** 文生图：缺省 1:1 / 1k / medium / jpeg，约 ¥0.2 一张；返回生成图的公网地址（图生视频以它为首帧） */
export async function generateImage(task: TaskClient, prompt: string, dest: string, download: Download = downloadTo, size = '1:1'): Promise<{ cost?: number; url: string }> {
  const { url, cost } = await task.run(
    { modelName: IMAGE_MODEL, modelType: 'text2img', prompt: `${prompt}${STYLE_SUFFIX}`, size, resolution: resolutionOf(size), quality: 'medium', output_format: 'jpeg' },
    { kind: 'image', label: 'B-roll 生图' },
  );
  await download(url, dest);
  return cost !== undefined ? { cost, url } : { url };
}

/** Seedance 图生视频（首帧为 imageUrl，不做文生视频）：9:16 / 4 秒 / 720p，约 ¥2.4 一条；原片 24fps，下载后统一转成 30fps 无音轨 */
export async function generateVideoFromImage(task: TaskClient, prompt: string, imageUrl: string, dest: string, cfg: AppConfig, download: Download = downloadTo, onStatus?: (status: string) => void, ratio = '9:16'): Promise<{ cost?: number }> {
  const content = [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl }, role: 'first_frame' }];
  const { url, cost } = await task.run(
    { modelName: VIDEO_MODEL, modelType: 'img2video', content, ratio, duration: 4, resolution: '720p', watermark: false, generate_audio: false },
    { kind: 'video', timeoutMs: VIDEO_TIMEOUT_MS, onStatus, label: 'B-roll 图生视频' },
  );
  const raw = `${dest}.raw.mp4`;
  try {
    await download(url, raw);
    await convertTo30fps(cfg, raw, dest);
  } finally {
    rmSync(raw, { force: true });
  }
  return cost !== undefined ? { cost } : {};
}

async function convertTo30fps(cfg: AppConfig, input: string, output: string): Promise<void> {
  try {
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', input, '-vf', 'fps=30', '-an', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', output]);
  } catch (err) {
    rmSync(output, { force: true });
    throw new Error(`生成的视频转换为 30fps 失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

interface PexelsResponse { photos?: { src?: { large2x?: string }; url?: string; photographer?: string; photographer_url?: string }[] }
/** Pexels 命中的署名信息：作品页、摄影师与主页（Pexels License 不强制署名，但记录下来随 credits 导出） */
export interface PexelsHit { page: string; author?: string; authorUrl?: string }

/** Pexels 图库（用户自备 key，可选）：搜一张方图下载，返回作品页与摄影师；没有结果返回 false */
export async function searchPexels(apiKey: string, query: string, dest: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<PexelsHit | false> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Pexels 搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as PexelsResponse;
  const photo = json.photos?.[0];
  const photoUrl = photo?.src?.large2x;
  if (!photo || !photoUrl) return false;
  await downloadTo(photoUrl, dest, fetchImpl);
  return { page: photo.url ?? 'https://www.pexels.com', ...(photo.photographer ? { author: photo.photographer } : {}), ...(photo.photographer_url ? { authorUrl: photo.photographer_url } : {}) };
}
