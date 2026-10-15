import { copyFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppConfig } from '../config.js';
import { sfxPath, trackPath, type Track } from '../assets/catalog.js';
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
