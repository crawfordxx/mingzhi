import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 运行配置：全部来自环境变量，便于启动器（P6）注入打包好的二进制路径 */
export interface AppConfig {
  dataDir: string;
  modelsDir: string;
  ffmpeg: string;
  ffprobe: string;
  kexiangKey?: string;
  /** Pexels 图库 key（可选，B-roll 生图失败时的备选） */
  pexelsKey?: string;
  /** Pixabay 图库 key（可选，B-roll 素材检索；注册 https://pixabay.com/api/docs/） */
  pixabayKey?: string;
}

const EXE = process.platform === 'win32' ? '.exe' : '';

/** 优先用数据目录 bin 下自带的二进制（需要 libass 烧录字幕；Homebrew 的 ffmpeg 不带），没有再用系统 PATH */
function bundled(dataDir: string, name: string): string {
  const path = join(dataDir, 'bin', `${name}${EXE}`);
  return existsSync(path) ? path : name;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = env.MINGZHI_DATA_DIR || join(homedir(), '.mingzhi');
  return {
    dataDir,
    modelsDir: join(dataDir, 'models'),
    ffmpeg: env.MINGZHI_FFMPEG ?? bundled(dataDir, 'ffmpeg'),
    ffprobe: env.MINGZHI_FFPROBE ?? bundled(dataDir, 'ffprobe'),
    kexiangKey: env.MINGZHI_KX_KEY || undefined,
    pexelsKey: env.MINGZHI_PEXELS_KEY || undefined,
    pixabayKey: env.MINGZHI_PIXABAY_KEY || undefined,
  };
}
