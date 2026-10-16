import { copyFile, link, mkdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { AppConfig } from '../config.js';
import { brandLogoPath, fontPath, loadFonts, sfxPath, trackPath, type Track } from '../assets/catalog.js';
import { CAPTION_STYLES, type CaptionStyleId } from '../captions/styles.js';
import type { SfxCue } from '../audio/plan.js';

const BGM_FILE = 'audio/bgm.mp3';

/**
 * 把素材放进工作目录：优先硬链接（每个版本目录不再各复制一份约 20MB 的字体与配乐），跨磁盘等不支持时复制。
 * 素材是只读的，渲染只读不写，所以共用同一份内容是安全的；dest 已存在时先删掉这个目录项再链接。
 */
async function placeAsset(src: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true });
  await rm(dest, { force: true });
  try {
    await link(src, dest);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw err;
    await copyFile(src, dest);
  }
}

/** 音效落盘路径（相对工作目录）；以音效 id 命名，渲染层据此直接拼出，无需引入素材清单 */
export const sfxStagedPath = (id: SfxCue['sfx']): string => `audio/sfx/${id}.wav`;

/**
 * 把背景乐与实际用到的音效放进工作目录（硬链接）（Remotion 的 publicDir），返回相对工作目录的路径。
 * 幂等；只复制被触发的音效。
 */
export async function stageAudio(workDir: string, cfg: AppConfig, track: Track | null, cues: SfxCue[]): Promise<{ bgm?: string; sfxFiles: string[] }> {
  const ids = [...new Set(cues.map((c) => c.sfx))];
  await mkdir(join(workDir, 'audio', 'sfx'), { recursive: true });
  const bgm = track ? await stageTrack(workDir, cfg, track) : undefined;
  const sfxFiles = await Promise.all(ids.map(async (id) => {
    const rel = sfxStagedPath(id);
    await placeAsset(sfxPath(id), join(workDir, rel));
    return rel;
  }));
  return bgm ? { bgm, sfxFiles } : { sfxFiles };
}

const OUTRO_LOGO_FILE = 'brand/logo.png';

/** 把片尾用的产品 logo 放进工作目录，返回相对工作目录的路径 */
export async function stageOutroLogo(workDir: string): Promise<string> {
  await placeAsset(brandLogoPath(), join(workDir, OUTRO_LOGO_FILE));
  return OUTRO_LOGO_FILE;
}

async function stageTrack(workDir: string, cfg: AppConfig, track: Track): Promise<string> {
  try {
    await placeAsset(trackPath(cfg, track), join(workDir, BGM_FILE));
  } catch (e) {
    throw new Error(`配乐曲目 ${track.id} 复制失败，请先下载配乐素材：${(e as Error).message}`);
  }
  return BGM_FILE;
}

/**
 * 把所选字幕样式的字体放进 workDir/fonts/（硬链接，只放这一个）。
 * 字体未下载时不报错：返回 fallback=true 与空文件名，渲染层落到系统字体栈，由调用方提示用户先 fetch-assets。
 */
export async function stageCaptionFont(workDir: string, cfg: AppConfig, styleId: CaptionStyleId): Promise<{ file: string; fallback: boolean }> {
  const font = loadFonts().find((f) => f.id === CAPTION_STYLES[styleId].font);
  if (!font) throw new Error(`字幕样式 ${styleId} 的字体 ${CAPTION_STYLES[styleId].font} 不在素材清单里`);
  // 与 fontsReady 一致：不存在或 0 字节都按未下载处理，避免渲染时才因坏字体失败
  const size = await stat(fontPath(cfg, font)).then((s) => s.size, () => 0);
  if (size === 0) return { file: '', fallback: true };
  await placeAsset(fontPath(cfg, font), join(workDir, 'fonts', font.file));
  return { file: font.file, fallback: false };
}
