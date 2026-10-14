// 下载 SenseVoice（int8）与 Silero VAD 到 ~/.mingzhi/models（可用 MINGZHI_DATA_DIR 覆盖）
import { existsSync, mkdirSync, createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const SV = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const dir = join(process.env.MINGZHI_DATA_DIR ?? join(homedir(), '.mingzhi'), 'models');
mkdirSync(dir, { recursive: true });

async function download(url, dest) {
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

if (!existsSync(join(dir, 'silero_vad.onnx'))) await download(`${BASE}/silero_vad.onnx`, join(dir, 'silero_vad.onnx'));
if (!existsSync(join(dir, SV, 'model.int8.onnx'))) {
  const tar = join(dir, `${SV}.tar.bz2`);
  await download(`${BASE}/${SV}.tar.bz2`, tar);
  execFileSync('tar', ['xjf', tar, '-C', dir]);
  execFileSync('rm', ['-f', tar, join(dir, SV, 'model.onnx')]); // 只保留 int8 版，省 700MB
}
console.log(`模型就绪：${dir}`);
