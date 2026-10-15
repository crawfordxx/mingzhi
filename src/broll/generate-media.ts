import { rmSync } from 'node:fs';
import type { AppConfig } from '../config.js';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import { run } from '../media/exec.js';

export const IMAGE_MODEL = 'GPT-Image-2.5-Flare';
export const VIDEO_MODEL = 'KVideo2.0-Mini';

/** Seedance 约 139 秒出片，排队时可能更久，给 25 分钟 */
const VIDEO_TIMEOUT_MS = 25 * 60_000;
const NO_TEXT_SUFFIX = ', no text, no watermark, no logos';

export type Download = (url: string, dest: string) => Promise<void>;

/** 文生图：1:1 / 1k / medium / jpeg，约 ¥0.2 一张 */
export async function generateImage(task: TaskClient, prompt: string, dest: string, download: Download = downloadTo): Promise<{ cost?: number }> {
  const { url, cost } = await task.run(
    { modelName: IMAGE_MODEL, modelType: 'text2img', prompt: `${prompt}${NO_TEXT_SUFFIX}`, size: '1:1', resolution: '1k', quality: 'medium', output_format: 'jpeg' },
    { kind: 'image', label: 'B-roll 生图' },
  );
  await download(url, dest);
  return cost !== undefined ? { cost } : {};
}

/** Seedance 文生视频：1:1 / 4 秒 / 720p，约 ¥2.4 一条；原片是 24fps，下载后统一转成 30fps 无音轨 */
export async function generateVideo(task: TaskClient, prompt: string, dest: string, cfg: AppConfig, download: Download = downloadTo, onStatus?: (status: string) => void): Promise<{ cost?: number }> {
  const { url, cost } = await task.run(
    { modelName: VIDEO_MODEL, modelType: 'text2video', content: [{ type: 'text', text: prompt }], ratio: '1:1', duration: 4, resolution: '720p', watermark: false, generate_audio: false },
    { kind: 'video', timeoutMs: VIDEO_TIMEOUT_MS, onStatus, label: 'B-roll 视频' },
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

interface PexelsResponse { photos?: { src?: { large2x?: string } }[] }

/** Pexels 图库（用户自备 key，可选）：搜一张方图下载；没有结果返回 false */
export async function searchPexels(apiKey: string, query: string, dest: string, opts: { fetchImpl?: typeof fetch } = {}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const res = await fetchImpl(`https://api.pexels.com/v1/search?query=${encodeURIComponent(query)}&per_page=1&orientation=square`, {
    headers: { Authorization: apiKey },
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) throw new Error(`Pexels 搜索失败 ${res.status}：${(await res.text()).slice(0, 200)}`);
  const json = (await res.json()) as PexelsResponse;
  const photoUrl = json.photos?.[0]?.src?.large2x;
  if (!photoUrl) return false;
  await downloadTo(photoUrl, dest, fetchImpl);
  return true;
}
