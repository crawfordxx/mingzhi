import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { fontPath, loadFonts, sfxPath, trackPath, type Track } from '../assets/catalog.js';
import { CAPTION_STYLES, type CaptionStyleId } from '../captions/styles.js';
import type { SfxCue } from '../audio/plan.js';

const BGM_FILE = 'audio/bgm.mp3';

/** 音效落盘路径（相对工作目录）；以音效 id 命名，渲染层据此直接拼出，无需引入素材清单 */
export const sfxStagedPath = (id: SfxCue['sfx']): string => `audio/sfx/${id}.wav`;

/**
 * 把背景乐与实际用到的音效复制进工作目录（Remotion 的 publicDir），返回相对工作目录的路径。
 * 幂等；只复制被触发的音效。
 */
export async function stageAudio(workDir: string, cfg: AppConfig, track: Track | null, cues: SfxCue[]): Promise<{ bgm?: string; sfxFiles: string[] }> {
  const ids = [...new Set(cues.map((c) => c.sfx))];
  await mkdir(join(workDir, 'audio', 'sfx'), { recursive: true });
  const bgm = track ? await stageTrack(workDir, cfg, track) : undefined;
  const sfxFiles = await Promise.all(ids.map(async (id) => {
    const rel = sfxStagedPath(id);
    await copyFile(sfxPath(id), join(workDir, rel));
    return rel;
  }));
  return bgm ? { bgm, sfxFiles } : { sfxFiles };
}

async function stageTrack(workDir: string, cfg: AppConfig, track: Track): Promise<string> {
  try {
    await copyFile(trackPath(cfg, track), join(workDir, BGM_FILE));
  } catch (e) {
    throw new Error(`配乐曲目 ${track.id} 复制失败，请先下载配乐素材：${(e as Error).message}`);
  }
  return BGM_FILE;
}

/**
 * 把所选字幕样式的字体复制到 workDir/fonts/（只复制这一个）。
 * 字体未下载时不报错：返回 fallback=true 与空文件名，渲染层落到系统字体栈，由调用方提示用户先 fetch-assets。
 */
export async function stageCaptionFont(workDir: string, cfg: AppConfig, styleId: CaptionStyleId): Promise<{ file: string; fallback: boolean }> {
  const font = loadFonts().find((f) => f.id === CAPTION_STYLES[styleId].font);
  if (!font) throw new Error(`字幕样式 ${styleId} 的字体 ${CAPTION_STYLES[styleId].font} 不在素材清单里`);
  await mkdir(join(workDir, 'fonts'), { recursive: true });
  try {
    await copyFile(fontPath(cfg, font), join(workDir, 'fonts', font.file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { file: '', fallback: true };
    throw e;
  }
  return { file: font.file, fallback: false };
}
