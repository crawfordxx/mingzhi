import { describe, expect, it } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transcript } from '../src/asr/types.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import { KexiangClient, type ChatOptions, type LlmClient } from '../src/llm/kexiang.js';
import { buildConcatFilter, concatSources, GAP_FRAMES, layoutClips } from '../src/media/concat.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { mergeTranscripts, ORDER_MODEL, orderSegments } from '../src/pipeline/multi.js';

const fakeClient = (reply: unknown | (() => unknown)): { client: LlmClient; calls: ChatOptions[] } => {
  const calls: ChatOptions[] = [];
  return { calls, client: { chatJson: async (o) => { calls.push(o); return typeof reply === 'function' ? (reply as () => unknown)() : reply; } } };
};

describe('orderSegments', () => {
  it('合法排列原样采用，并把每段文字交给模型（低推理强度、记账用途说明）', async () => {
    const { client, calls } = fakeClient({ order: [2, 0, 1] });
    expect(await orderSegments(client, ['先讲结论', '再讲案例', '最后收尾'])).toEqual([2, 0, 1]);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ model: ORDER_MODEL, reasoningEffort: 'low', label: '段落排序' });
    for (const t of ['先讲结论', '再讲案例', '最后收尾']) expect(calls[0].user).toContain(t);
  });

  it.each([
    ['有重复', { order: [0, 0, 1] }],
    ['越界', { order: [0, 1, 3] }],
    ['长度不够', { order: [1, 0] }],
    ['长度过长', { order: [0, 1, 2, 0] }],
    ['含小数', { order: [0, 1.5, 2] }],
    ['含字符串', { order: ['0', '1', '2'] }],
    ['不是数组', { order: 'abc' }],
    ['缺 order', { result: [0, 1, 2] }],
    ['不是对象', 'hello'],
  ])('非法输出（%s）回退为原顺序', async (_name, reply) => {
    expect(await orderSegments(fakeClient(reply).client, ['a', 'b', 'c'])).toEqual([0, 1, 2]);
  });

  it('单段不调模型，零段返回空', async () => {
    const { client, calls } = fakeClient({ order: [0] });
    expect(await orderSegments(client, ['只有一段'])).toEqual([0]);
    expect(await orderSegments(client, [])).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('请求失败按原顺序出片；余额不足与取消照常外抛', async () => {
    const broken: LlmClient = { chatJson: async () => { throw new Error('网络断了'); } };
    expect(await orderSegments(broken, ['a', 'b'])).toEqual([0, 1]);
    const broke: LlmClient = { chatJson: async () => { throw new InsufficientBalanceError('余额不足'); } };
    await expect(orderSegments(broke, ['a', 'b'])).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('某段没有识别出文字时仍可排序；每段文字过长只保留头尾', async () => {
    const { client, calls } = fakeClient({ order: [1, 0] });
    const long = `开头${'中'.repeat(3000)}结尾`;
    expect(await orderSegments(client, ['', long])).toEqual([1, 0]);
    expect(calls[0].user).toContain('开头');
    expect(calls[0].user).toContain('结尾');
    expect(calls[0].user.length).toBeLessThan(2000);
  });

  it('花费记进计费器', async () => {
    const meter = new CostMeter({ [ORDER_MODEL]: { input: 0.01, output: 0.06 } }, 10);
    const fetchImpl = (async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"order":[1,0]}' } }], usage: { prompt_tokens: 1000, completion_tokens: 100 } }), { status: 200 })) as typeof fetch;
    const client = new KexiangClient('sk-test', fetchImpl, async () => undefined, meter);
    expect(await orderSegments(client, ['b在后', 'a在前'])).toEqual([1, 0]);
    expect(meter.entries).toHaveLength(1);
    expect(meter.total).toBeGreaterThan(0);
  });
});

describe('layoutClips / mergeTranscripts', () => {
  it('每段按 30 帧取整，非末段后接 0.3 秒缓冲，偏移落在帧网格上', () => {
    const l = layoutClips([2, 1.5, 3]);
    expect(GAP_FRAMES).toBe(9);
    expect(l.frames).toEqual([60 + 9, 45 + 9, 90]);
    expect(l.offsets).toEqual([0, 69 / 30, (69 + 54) / 30]);
    expect(l.totalSec).toBeCloseTo((69 + 54 + 90) / 30, 6);
  });

  it('识别结果按段偏移合并：字和语音段的时间都平移，总时长为拼接后时长', () => {
    const a: Transcript = { durationSec: 2, segments: [{ start: 0.5, end: 1.5 }], tokens: [{ text: '你', start: 0.5, end: 0.7 }, { text: '好', start: 0.8, end: 1 }] };
    const b: Transcript = { durationSec: 1.5, segments: [{ start: 0.2, end: 1 }], tokens: [{ text: '再', start: 0.2, end: 0.4 }] };
    const l = layoutClips([2, 1.5]);
    const m = mergeTranscripts([a, b], l);
    expect(m.durationSec).toBeCloseTo(l.totalSec, 6);
    expect(m.tokens.map((t) => t.text).join('')).toBe('你好再');
    expect(m.tokens[0]).toEqual({ text: '你', start: 0.5, end: 0.7 }); // 第一段偏移 0
    expect(m.tokens[2].start).toBeCloseTo(2.3 + 0.2, 3);
    expect(m.segments[1].start).toBeCloseTo(2.3 + 0.2, 3);
    expect(m.segments[1].end).toBeCloseTo(2.3 + 1, 3);
  });
});

describe('buildConcatFilter', () => {
  it('每段统一 30fps、统一画幅、48k 立体声，按帧数精确裁齐，最后 concat', () => {
    const f = buildConcatFilter([69, 90], { width: 540, height: 960 });
    expect(f).toContain('[0:v]fps=30:start_time=0');
    expect(f).toContain('scale=540:960:force_original_aspect_ratio=decrease,pad=540:960');
    expect(f).toContain('trim=end_frame=69');
    expect(f).toContain('trim=end_frame=90');
    expect(f).toContain('aresample=48000');
    expect(f).toContain(`atrim=end_sample=${69 * 1600}`);
    expect(f).toContain('concat=n=2:v=1:a=1[outv][outa]');
  });
});

const cfg = loadConfig({});

/** 生成一段测试片：色块 + 正弦音（前 toneSec 秒有声，之后静音补满） */
async function makeClip(path: string, o: { size: string; fps: number; sec: number; rate: number; layout: 'mono' | 'stereo'; hz: number }): Promise<void> {
  await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', `color=c=blue:s=${o.size}:r=${o.fps}:d=${o.sec}`,
    '-f', 'lavfi', '-i', `sine=f=${o.hz}:r=${o.rate}:d=${o.sec}`, '-ac', o.layout === 'mono' ? '1' : '2',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', path]);
}

/** 某个时间窗内的最大音量（dB）；纯静音为 -inf */
async function maxVolume(path: string, from: number, len: number): Promise<number> {
  const { stderr } = await run(cfg.ffmpeg, ['-v', 'info', '-ss', String(from), '-t', String(len), '-i', path, '-vn', '-af', 'volumedetect', '-f', 'null', '-']);
  const m = /max_volume: (-?[\d.]+|-inf) dB/.exec(stderr);
  return m ? Number(m[1]) : Number.NEGATIVE_INFINITY;
}

describe('concatSources（真实 ffmpeg）', () => {
  it('不同分辨率、帧率、采样率、声道的两段拼成一条：画幅取第一段、30fps、48k 立体声，时长为两段加缓冲，段间静音', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-concat-'));
    const a = join(dir, 'a.mp4');
    const b = join(dir, 'b.mp4');
    await makeClip(a, { size: '320x240', fps: 25, sec: 1.5, rate: 44100, layout: 'mono', hz: 440 });
    await makeClip(b, { size: '160x120', fps: 24, sec: 1, rate: 48000, layout: 'stereo', hz: 880 });
    const clips = await Promise.all([a, b].map(async (path) => ({ path, durationSec: (await probe(path, cfg)).durationSec })));
    const out = join(dir, 'source.mp4');
    await concatSources({ clips, width: 320, height: 240, output: out, cfg });

    const info = await probe(out, cfg);
    const layout = layoutClips(clips.map((c) => c.durationSec));
    expect(info.width).toBe(320);
    expect(info.height).toBe(240);
    expect(info.fps).toBe(30);
    expect(info.hasAudio).toBe(true);
    expect(Math.abs(info.durationSec - layout.totalSec)).toBeLessThan(0.1);

    const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=sample_rate,channels', '-of', 'csv=p=0', out]);
    expect(stdout.trim()).toBe('48000,2');

    // 第一段有声；缓冲区（第一段结束后 0.3 秒）静音；第二段从偏移处开始有声
    const gapStart = layout.offsets[1] - GAP_FRAMES / 30;
    expect(await maxVolume(out, 0.2, 0.5)).toBeGreaterThan(-30);
    expect(await maxVolume(out, gapStart + 0.03, 0.24)).toBeLessThan(-60);
    expect(await maxVolume(out, layout.offsets[1] + 0.1, 0.5)).toBeGreaterThan(-30);
  }, 60_000);
});
