import { existsSync, statSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import type { AppConfig } from '../config.js';
import { BG_PROMPT_YUAN } from '../cost/estimate.js';
import type { CostMeter } from '../cost/meter.js';
import { downloadTo, type TaskClient } from '../llm/kexiang-task.js';
import { RVM_FILE, rvmReady } from '../matting/rvm.js';
import { isPresetId, presetPath, PRESETS } from './presets.js';

export const BG_IMAGE_MODEL = 'GPT-Image-2.5-Flare';
/** 一句话生成背景时追加的固定要求：空场景、无人无字、浅景深、写实 */
const BG_SUFFIX = ', eye-level view as a talking-head video backdrop, empty scene, no people, no text, no logos, shallow depth of field with soft background blur, photorealistic, 35mm photo, natural color grading';

export type BackgroundSpec = { kind: 'preset'; id: string } | { kind: 'file'; path: string } | { kind: 'prompt'; prompt: string };
export interface ResolvedBackground { spec: BackgroundSpec; path: string }
const NEED_KEY_MESSAGE = '一句话生成背景需要可想 AI key，请设置环境变量 MINGZHI_KX_KEY';
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

const isFile = (path: string): boolean => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** 流程开始前的快速校验：背景图、抠像模型、生图 key 缺了就立即报错，不要等到剪切、识别跑完才发现 */
export function validateBackground(spec: BackgroundSpec, cfg: AppConfig, task?: TaskClient): void {
  if (spec.kind === 'file' && !isFile(spec.path)) {
    // parseBackgroundArgs 已把参数解析成绝对路径；没有扩展名的，多半是写错的预设 id
    const hint = extname(spec.path) === '' ? `。若想用预设背景，可选：${PRESETS.map((p) => p.id).join('、')}` : '';
    throw new Error(`背景图片不存在或不是文件：${spec.path}${hint}`);
  }
  if (spec.kind === 'prompt' && !task) throw new Error(NEED_KEY_MESSAGE);
  if (!rvmReady(cfg.modelsDir)) throw new Error(`缺少抠像模型 ${RVM_FILE}，请先运行 pnpm fetch-models`);
}

/** 背景规格 → 本地图片路径；一句话生成的图下载到 workDir/background.jpg */
export async function resolveBackground(spec: BackgroundSpec, workDir: string, task?: TaskClient, download: Download = downloadTo, meter?: CostMeter): Promise<ResolvedBackground> {
  if (spec.kind === 'preset') return { spec, path: presetPath(spec.id) };
  if (spec.kind === 'file') {
    if (!existsSync(spec.path)) throw new Error(`背景图片不存在：${spec.path}`);
    return { spec, path: spec.path };
  }
  if (!task) throw new Error(NEED_KEY_MESSAGE);
  if (meter && !meter.canSpend(BG_PROMPT_YUAN)) throw new Error(`预算不足，无法生成背景（剩余 ¥${meter.remaining().toFixed(2)}，约需 ¥${BG_PROMPT_YUAN.toFixed(2)}）；请调高 --budget，或改用 --bg 预设/图片`);
  const result = await task.run(
    { modelName: BG_IMAGE_MODEL, modelType: 'text2img', prompt: `${spec.prompt}${BG_SUFFIX}`, size: '2:3', resolution: '1k', quality: 'medium', output_format: 'jpeg' },
    { kind: 'image', label: '背景生图' },
  );
  const path = join(workDir, 'background.jpg');
  await download(result.url, path);
  return { spec, path };
}
