import sherpa from 'sherpa-onnx-node';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { buildTokens } from './tokens.js';
import type { SpeechSegment, Token, Transcript } from './types.js';

export const SENSEVOICE_DIR = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const SR = 16000;
const WINDOW = 512;
const round = (n: number): number => Math.round(n * 1000) / 1000;

export function modelsReady(modelsDir: string): boolean {
  return existsSync(join(modelsDir, 'silero_vad.onnx')) && existsSync(join(modelsDir, SENSEVOICE_DIR, 'model.int8.onnx'));
}

function createVad(modelsDir: string) {
  return new sherpa.Vad({
    sileroVad: { model: join(modelsDir, 'silero_vad.onnx'), threshold: 0.5, minSilenceDuration: 0.25, minSpeechDuration: 0.1, maxSpeechDuration: 20, windowSize: WINDOW },
    sampleRate: SR, debug: 0, numThreads: 1,
  }, 60);
}

function createRecognizer(modelsDir: string) {
  const dir = join(modelsDir, SENSEVOICE_DIR);
  return new sherpa.OfflineRecognizer({
    featConfig: { sampleRate: SR, featureDim: 80 },
    // 关闭 ITN：保留口语原样（如「五毛一」），口误检测更准；数字格式交给字幕校对
    modelConfig: { senseVoice: { model: join(dir, 'model.int8.onnx'), language: 'zh', useInverseTextNormalization: 0 }, tokens: join(dir, 'tokens.txt'), numThreads: 4, provider: 'cpu', debug: 0 },
  });
}

/** VAD 切出语音段（每段 ≤20 秒），逐段识别，返回绝对时间的 token 与语音段 */
export function transcribeWav(wavPath: string, modelsDir: string): Transcript {
  if (!modelsReady(modelsDir)) throw new Error(`缺少语音识别模型（${modelsDir}），请先运行 pnpm fetch-models`);
  const wave = sherpa.readWave(wavPath);
  if (wave.sampleRate !== SR) throw new Error(`需要 16kHz 音频，实际为 ${wave.sampleRate}Hz`);
  const vad = createVad(modelsDir);
  const rec = createRecognizer(modelsDir);
  const raw: { start: number; samples: Float32Array }[] = [];
  const drain = (): void => { while (!vad.isEmpty()) { raw.push(vad.front()); vad.pop(); } };
  for (let i = 0; i + WINDOW <= wave.samples.length; i += WINDOW) { vad.acceptWaveform(wave.samples.subarray(i, i + WINDOW)); drain(); }
  vad.flush();
  drain();
  const segments: SpeechSegment[] = [];
  const tokens: Token[] = [];
  for (const seg of raw) {
    const start = seg.start / SR;
    const end = start + seg.samples.length / SR;
    const stream = rec.createStream();
    stream.acceptWaveform({ sampleRate: SR, samples: seg.samples });
    rec.decode(stream);
    segments.push({ start: round(start), end: round(end) });
    tokens.push(...buildTokens(rec.getResult(stream), start, end));
  }
  return { durationSec: wave.samples.length / SR, segments, tokens };
}
