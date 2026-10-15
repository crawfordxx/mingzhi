import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
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

/** 读 mp4 顶层 box 的类型顺序（size + type，兼容 64 位 largesize） */
function topLevelBoxes(path: string): string[] {
  const buf = readFileSync(path);
  const types: string[] = [];
  let pos = 0;
  while (pos + 8 <= buf.length) {
    let size = buf.readUInt32BE(pos);
    types.push(buf.toString('latin1', pos + 4, pos + 8));
    if (size === 1) size = Number(buf.readBigUInt64BE(pos + 8));
    if (size === 0) break;
    pos += size;
  }
  return types;
}

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
    const { before, after, truePeak, mode } = await normalizeLoudness(input, output, cfg);
    expect(TARGET.I).toBe(-14);
    expect(truePeak).toBeLessThanOrEqual(-1.0);
    expect(['linear', 'dynamic']).toContain(mode);
    const boxes = topLevelBoxes(output);
    expect(boxes.indexOf('moov')).toBeGreaterThanOrEqual(0);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
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
    const boxes = topLevelBoxes(output);
    expect(boxes.indexOf('moov')).toBeLessThan(boxes.indexOf('mdat'));
  }, 60_000);

  it('峰值很高的突发信号：最终响度在 -14±1.5 LU，真峰值 ≤ -1.0 dBTP', async () => {
    const burst = "aevalsrc='0.2*sin(2*PI*1000*t)*lt(mod(t,1),0.05)+0.005*(random(0)*2-1)':s=48000:d=8";
    const input = await makeInput('peaky.mp4', burst);
    const output = join(dir, 'peaky-norm.mp4');
    const { after, truePeak, mode } = await normalizeLoudness(input, output, cfg);
    expect(mode).toBe('dynamic'); // 线性模式会让真峰值到 0 dBTP，必须触发回退
    expect(Math.abs(after - TARGET.I)).toBeLessThanOrEqual(1.5);
    expect(truePeak).toBeLessThanOrEqual(-1.0);
  }, 60_000);

  it('没有音轨时报错', async () => {
    const input = join(dir, 'noaudio.mp4');
    await run(cfg.ffmpeg, ['-y', '-f', 'lavfi', '-i', 'color=c=black:s=160x90:r=25:d=2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    await expect(normalizeLoudness(input, join(dir, 'noaudio-out.mp4'), cfg)).rejects.toThrow('成片没有音轨，无法统一响度');
  });

  it('输入输出同一路径时报错', async () => {
    const input = await makeInput('same.mp4', 'sine=frequency=440:duration=2:sample_rate=48000');
    await expect(normalizeLoudness(input, input, cfg)).rejects.toThrow('不能相同');
  });

  it('第二遍失败时清掉临时文件', async () => {
    const input = await makeInput('fail.mp4', 'sine=frequency=440:duration=2:sample_rate=48000');
    const output = join(dir, 'nodir', 'out.mp4');
    await expect(normalizeLoudness(input, output, cfg)).rejects.toThrow();
    expect(existsSync(`${output}.tmp.mp4`)).toBe(false);
  });

  it('动态模式的第二遍失败：output 不会出现，临时文件也被清掉', async () => {
    const input = await makeInput('atomic.mp4', "aevalsrc='0.2*sin(2*PI*1000*t)*lt(mod(t,1),0.05)+0.005*(random(0)*2-1)':s=48000:d=8");
    // 包一层 ffmpeg：前 3 次调用（测量、线性第二遍、复测）直接转发，第 4 次（动态第二遍）失败
    const counter = join(dir, 'ffmpeg-count');
    const wrapper = join(dir, 'ffmpeg-flaky.sh');
    writeFileSync(wrapper, `#!/bin/sh\nn=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo $n > '${counter}'\nif [ "$n" -ge 4 ]; then echo boom >&2; exit 1; fi\nexec '${cfg.ffmpeg}' "$@"\n`);
    chmodSync(wrapper, 0o755);
    const output = join(dir, 'atomic-norm.mp4');
    await expect(normalizeLoudness(input, output, { ...cfg, ffmpeg: wrapper })).rejects.toThrow('boom');
    expect(readFileSync(counter, 'utf8').trim()).toBe('4');
    expect(existsSync(output)).toBe(false);
    expect(existsSync(`${output}.tmp.mp4`)).toBe(false);
  }, 60_000);
});
