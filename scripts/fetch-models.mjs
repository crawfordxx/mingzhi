// 下载 SenseVoice（int8）与 Silero VAD 到 ~/.mingzhi/models（可用 MINGZHI_DATA_DIR 覆盖）
import { existsSync, mkdirSync, createWriteStream, renameSync, rmSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { execFileSync } from 'node:child_process';

const BASE = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models';
const SV = 'sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17';
const dir = join(process.env.MINGZHI_DATA_DIR || join(homedir(), '.mingzhi'), 'models');
mkdirSync(dir, { recursive: true });

/** 先下载到 <dest>.part，完整下载后再改名，避免中断留下半截文件被当成已就绪 */
async function download(url, dest) {
  console.log(`下载 ${url}`);
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status}: ${url}`);
  const part = `${dest}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(part));
  renameSync(part, dest);
}

if (!existsSync(join(dir, 'silero_vad.onnx'))) await download(`${BASE}/silero_vad.onnx`, join(dir, 'silero_vad.onnx'));
if (!existsSync(join(dir, SV, 'model.int8.onnx'))) {
  const tar = join(dir, `${SV}.tar.bz2`);
  await download(`${BASE}/${SV}.tar.bz2`, tar);
  execFileSync('tar', ['xjf', tar, '-C', dir]);
  rmSync(tar, { force: true });
  rmSync(join(dir, SV, 'model.onnx'), { force: true }); // 只保留 int8 版，省 700MB
}
// RobustVideoMatting（抠像），GitHub release v1.0.0；下载后校验 sha256
const RVM = 'rvm_mobilenetv3_fp32.onnx';
const RVM_SHA256 = '88d4531297118f595bf2fd60f6f566aec2e559393802d1f436c380f0cbbd2828';
if (!existsSync(join(dir, RVM))) {
  await download(`https://github.com/PeterL1n/RobustVideoMatting/releases/download/v1.0.0/${RVM}`, join(dir, RVM));
  const sha = createHash('sha256').update(readFileSync(join(dir, RVM))).digest('hex');
  if (sha !== RVM_SHA256) { rmSync(join(dir, RVM), { force: true }); throw new Error(`${RVM} 校验失败：${sha}`); }
}
console.log(`模型就绪：${dir}`);
