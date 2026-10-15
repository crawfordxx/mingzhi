import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { presetPath } from '../background/presets.js';
import { CAPTION_STYLES, type CaptionStyleId } from '../captions/styles.js';
import { stageCaptionFont } from '../compose/stage-assets.js';
import { renderCaptionStill } from '../compose/render.js';
import type { AppConfig } from '../config.js';
import { run } from '../media/exec.js';
import { HttpError } from './http.js';

export const PREVIEW_TEXT = '省下80%的钱，效果反而更好';
const PREVIEW_BG = 'preview-bg.jpg';
const PREVIEW_BG_PRESET = 'studio';

/** 渲染一个字幕样式的预览 PNG（1080×600）；字体没下载时不渲染（回退字体的预览会误导用户，也不该被缓存） */
export async function renderCaptionPreview(cfg: AppConfig, id: CaptionStyleId, dest: string): Promise<void> {
  const workDir = join(cfg.dataDir, 'previews', 'work');
  mkdirSync(workDir, { recursive: true });
  const { file, fallback } = await stageCaptionFont(workDir, cfg, id);
  if (fallback) throw new HttpError(503, `字幕字体「${CAPTION_STYLES[id].name}」还没有下载，请先运行 pnpm fetch-assets`);
  const bg = join(workDir, PREVIEW_BG);
  if (!existsSync(bg)) {
    const vf = 'scale=1080:600:force_original_aspect_ratio=increase,crop=1080:600';
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', presetPath(PREVIEW_BG_PRESET), '-vf', vf, '-frames:v', '1', bg]);
  }
  mkdirSync(dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp.png`;
  try {
    await renderCaptionStill({ workDir, captionStyle: id, captionFontFile: file, text: PREVIEW_TEXT, bg: PREVIEW_BG, output: tmp });
    renameSync(tmp, dest);
  } finally {
    rmSync(tmp, { force: true });
  }
}
