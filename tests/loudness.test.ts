import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { parseLoudnormJson, normalizeLoudness, TARGET } from '../src/audio/loudness.js';

const cfg = loadConfig({});

const SAMPLE_STDERR = `Input #0, lavfi, from 'x':
  Duration: 00:00:04.00
{ not json }
[Parsed_loudnorm_0 @ 0x7f8]
{
	"input_i" : "-30.12",
	"input_tp" : "-26.50",
	"input_lra" : "0.10",
	"input_thresh" : "-40.60",
	"output_i" : "-21.70",
	"output_tp" : "-18.10",
	"output_lra" : "0.00",
	"output_thresh" : "-32.00",
	"normalization_type" : "dynamic",
	"target_offset" : "7.70"
}
`;

describe('parseLoudnormJson', () => {
  it('取 stderr 最后一个 JSON 块并把字符串字段转成数字', () => {
    expect(parseLoudnormJson(SAMPLE_STDERR)).toEqual({
      input_i: -30.12,
      input_tp: -26.5,
      input_lra: 0.1,
      input_thresh: -40.6,
      target_offset: 7.7,
    });
  });

  it('静音输入的 -inf 解析为 -Infinity', () => {
    const out = parseLoudnormJson('{"input_i":"-inf","input_tp":"-inf","input_lra":"0.00","input_thresh":"-inf","target_offset":"inf"}');
    expect(out.input_i).toBe(-Infinity);
  });

  it('没有 JSON 块时报中文错误', () => {
    expect(() => parseLoudnormJson('no json here')).toThrow('响度测量');
  });
});

describe('normalizeLoudness', () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'mz-loud-'));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  async function makeInput(name: string, audioSrc: string): Promise<string> {
    const path = join(dir, name);
    await run(cfg.ffmpeg, [
      '-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=4',
      '-f', 'lavfi', '-i', audioSrc,
      '-t', '4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path,
    ]);
    return path;
  }

  it('-30 dBFS 正弦统一到 -14 LUFS 左右，时长与视频流保持', async () => {
    const input = await makeInput('quiet.mp4', 'sine=frequency=440:duration=4:sample_rate=48000,volume=-30dB');
    const output = join(dir, 'quiet-norm.mp4');
    const { before, after } = await normalizeLoudness(input, output, cfg);
    expect(TARGET.I).toBe(-14);
    expect(before).toBeLessThan(-25);
    expect(after).toBeGreaterThan(-15);
    expect(after).toBeLessThan(-13);
    const [a, b] = await Promise.all([probe(input, cfg), probe(output, cfg)]);
    expect(Math.abs(b.durationSec - a.durationSec)).toBeLessThan(0.05);
    expect(b.hasAudio).toBe(true);
    expect([b.width, b.height]).toEqual([a.width, a.height]);
    expect(existsSync(`${output}.tmp.mp4`)).toBe(false);
  }, 60_000);

  it('静音音轨原样拷贝，返回 before === after === -Infinity', async () => {
    const input = await makeInput('silent.mp4', 'anullsrc=r=48000:cl=mono');
    const output = join(dir, 'silent-norm.mp4');
    const { before, after } = await normalizeLoudness(input, output, cfg);
    expect(before).toBe(-Infinity);
    expect(after).toBe(before);
    expect(existsSync(output)).toBe(true);
  }, 60_000);
});
