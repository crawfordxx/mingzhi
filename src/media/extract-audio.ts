import type { AppConfig } from '../config.js';
import { run } from './exec.js';

/** 抽取 16kHz 单声道 PCM wav，供 VAD 与 SenseVoice 使用 */
export async function extractWav16k(input: string, outWav: string, cfg: AppConfig): Promise<void> {
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', input, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', outWav]);
}
