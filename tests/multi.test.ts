import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Transcript } from '../src/asr/types.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import { KexiangClient, type ChatOptions, type LlmClient } from '../src/llm/kexiang.js';
import { CancelledError } from '../src/cancel.js';
import { buildConcatFilter, canvasFor, concatSources, GAP_FRAMES, layoutClips } from '../src/media/concat.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { decideOrder, mergeTranscripts, ORDER_MODEL, orderSegments } from '../src/pipeline/multi.js';

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

describe('decideOrder', () => {
  it('区分「模型认为不用动」与「降级为上传顺序」', async () => {
    expect(await decideOrder(fakeClient({ order: [0, 1] }).client, ['a', 'b'])).toEqual({ order: [0, 1], failed: false });
    expect(await decideOrder(fakeClient({ order: [0, 0] }).client, ['a', 'b'])).toEqual({ order: [0, 1], failed: true });
    const broken: LlmClient = { chatJson: async () => { throw new Error('网络断了'); } };
    expect(await decideOrder(broken, ['a', 'b'])).toEqual({ order: [0, 1], failed: true });
    expect(await decideOrder(fakeClient({}).client, ['a'])).toEqual({ order: [0], failed: false });
  });
});

describe('canvasFor', () => {
  it('固定 9:16 竖屏：宽取各竖屏段的最大宽度，高按 16/9；没有竖屏段用 1080×1920', () => {
    expect(canvasFor([{ width: 1080, height: 1920 }, { width: 1920, height: 1080 }])).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor([{ width: 1920, height: 1080 }, { width: 720, height: 1280 }, { width: 1080, height: 1440 }])).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor([{ width: 540, height: 960 }])).toEqual({ width: 540, height: 960 });
    expect(canvasFor([{ width: 1920, height: 1080 }, { width: 1280, height: 720 }])).toEqual({ width: 1080, height: 1920 });
    expect(canvasFor([{ width: 721, height: 1281 }])).toEqual({ width: 720, height: 1280 });
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
    expect(f).toContain('scale=540:960:force_original_aspect_ratio=increase,crop=540:960');
    expect(f).not.toContain(',pad=');
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

describe('concatSources 横竖混排与失败（真实 ffmpeg）', () => {
  it('横屏段与竖屏段拼成 9:16 竖屏：居中裁切铺满，画面边缘与四角都不是黑边', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-concat-mix-'));
    const portrait = join(dir, 'p.mp4');
    const landscape = join(dir, 'l.mp4');
    // 用亮色（亮度远高于黑边）；横屏段排在前面，画幅也不能被它带成横屏
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=yellow:s=320x180:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', landscape]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', portrait]);
    const clips = await Promise.all([landscape, portrait].map(async (path) => ({ path, durationSec: (await probe(path, cfg)).durationSec })));
    const canvas = canvasFor([{ width: 320, height: 180 }, { width: 180, height: 320 }]);
    expect(canvas).toEqual({ width: 180, height: 320 });
    const out = join(dir, 'source.mp4');
    await concatSources({ clips, ...canvas, output: out, cfg });
    const info = await probe(out, cfg);
    expect([info.width, info.height]).toEqual([180, 320]);

    const layout = layoutClips(clips.map((c) => c.durationSec));
    for (const at of [0.5, layout.offsets[1] + 0.5]) {
      const gray = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-ss', String(at), '-i', out, '-frames:v', '1', '-vf', 'format=gray', '-f', 'rawvideo', '-']);
      expect(gray.length).toBe(180 * 320);
      expect(Math.min(...gray)).toBeGreaterThan(100); // 黑边亮度约 16
    }
    expect(readdirSync(dir).filter((n) => n.startsWith('.'))).toEqual([]); // 临时文件已清理
  }, 60_000);

  it('ffmpeg 失败时报中文错误并附原因，不留临时文件与半成品', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-concat-fail-'));
    const bad = join(dir, 'bad.mp4');
    writeFileSync(bad, 'not a video');
    const out = join(dir, 'source.mp4');
    const err = await concatSources({ clips: [{ path: bad, durationSec: 1 }], width: 180, height: 320, output: out, cfg }).catch((e: Error) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^拼接多段口播失败/);
    expect((err as Error).message.length).toBeGreaterThan('拼接多段口播失败'.length + 10);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['bad.mp4']);
  });

  it('已取消的信号：抛 CancelledError，不留临时文件与半成品', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-concat-cancel-'));
    const clip = join(dir, 'a.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const controller = new AbortController();
    controller.abort();
    const out = join(dir, 'source.mp4');
    await expect(concatSources({ clips: [{ path: clip, durationSec: 1 }], width: 180, height: 320, output: out, cfg, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['a.mp4']);
  });

  it('编码进行中取消：结束 ffmpeg 并抛 CancelledError，换段时回调进度', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-concat-mid-'));
    const clip = join(dir, 'a.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=20', '-f', 'lavfi', '-i', 'sine=f=440:d=20', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const controller = new AbortController();
    const seen: number[] = [];
    const out = join(dir, 'source.mp4');
    await expect(concatSources({
      clips: [{ path: clip, durationSec: 20 }, { path: clip, durationSec: 20 }], width: 1080, height: 1920, output: out, cfg, signal: controller.signal,
      onSegment: (i) => { seen.push(i); if (i === 1) controller.abort(); }, // 编码到第二段时取消，此时 ffmpeg 还有一半没编完
    })).rejects.toBeInstanceOf(CancelledError);
    expect(seen).toEqual([0, 1]);
    expect(existsSync(out)).toBe(false);
    expect(readdirSync(dir).sort()).toEqual(['a.mp4']);
  }, 60_000);

  it('完整拼接时按段回调进度（0 → 1），每段只报一次', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-concat-prog-'));
    const clip = join(dir, 'a.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=white:s=180x320:r=30:d=1', '-f', 'lavfi', '-i', 'sine=f=440:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', clip]);
    const seen: number[] = [];
    await concatSources({ clips: [{ path: clip, durationSec: 1 }, { path: clip, durationSec: 1 }], width: 180, height: 320, output: join(dir, 'o.mp4'), cfg, onSegment: (i) => seen.push(i) });
    expect(seen).toEqual([0, 1]);
  }, 60_000);
});
