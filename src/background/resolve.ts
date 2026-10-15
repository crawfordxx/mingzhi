import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import { isPresetId, presetPath } from './presets.js';

export const BG_IMAGE_MODEL = 'GPT-Image-2.5-Flare';
/** 一句话生成背景时追加的固定要求：空场景、无人无字、浅景深、写实 */
const BG_SUFFIX = ', eye-level view as a talking-head video backdrop, empty scene, no people, no text, no logos, shallow depth of field with soft background blur, photorealistic, 35mm photo, natural color grading';

export type BackgroundSpec = { kind: 'preset'; id: string } | { kind: 'file'; path: string } | { kind: 'prompt'; prompt: string };
export interface ResolvedBackground { spec: BackgroundSpec; path: string }
type Download = (url: string, dest: string) => Promise<void>;

/** 命令行参数 → 背景规格：--bg 是预设 id 或图片路径（相对 baseDir），--bg-prompt 是一句话描述；两者只能给一个 */
export function parseBackgroundArgs(bg: string | undefined, bgPrompt: string | undefined, baseDir: string): BackgroundSpec | undefined {
  if (bg !== undefined && bgPrompt !== undefined) throw new Error('--bg 与 --bg-prompt 只能二选一');
  if (bgPrompt !== undefined) {
    if (!bgPrompt.trim()) throw new Error('--bg-prompt 不能为空');
    return { kind: 'prompt', prompt: bgPrompt.trim() };
  }
  if (bg === undefined) return undefined;
  return isPresetId(bg) ? { kind: 'preset', id: bg } : { kind: 'file', path: resolve(baseDir, bg) };
}

/** 背景规格 → 本地图片路径；一句话生成的图下载到 workDir/background.jpg */
export async function resolveBackground(spec: BackgroundSpec, workDir: string, task?: TaskClient, download: Download = downloadTo): Promise<ResolvedBackground> {
  if (spec.kind === 'preset') return { spec, path: presetPath(spec.id) };
  if (spec.kind === 'file') {
    if (!existsSync(spec.path)) throw new Error(`背景图片不存在：${spec.path}`);
    return { spec, path: spec.path };
  }
  if (!task) throw new Error('一句话生成背景需要可想 AI key，请设置环境变量 MINGZHI_KX_KEY');
  const result = await task.run(
    { modelName: BG_IMAGE_MODEL, modelType: 'text2img', prompt: `${spec.prompt}${BG_SUFFIX}`, size: '2:3', resolution: '1k', quality: 'medium', output_format: 'jpeg' },
    { kind: 'image' },
  );
  const path = join(workDir, 'background.jpg');
  await download(result.url, path);
  return { spec, path };
}
