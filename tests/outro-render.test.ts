// 片尾真实渲染（约 6 秒样片）：最后一句后留白、品牌片尾画面、片尾 3 秒响度 ≤ -18 LUFS、留白里人像定格不出声。
// 走 composeStage 全程（结尾规划 → 配乐与音效 → 分段渲染 → 响度统一）；人像取 fixtures/talk.mp4 的前 3 秒真人口播，配乐用 ffmpeg 合成的 -14 LUFS 和弦
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { loadTracks, trackPath } from '../src/assets/catalog.js';
import { HOLD_SEC, OUTRO_SEC } from '../src/compose/ending.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import type { Complete } from '../src/pipeline/stages.js';
import { composeStage } from '../src/pipeline/stages.js';
import type { PipelineArgs } from '../src/pipeline/run.js';
import type { Shot } from '../src/storyboard/schema.js';

const SPEECH_SEC = 3;
const LAST_CAPTION_END = 2.8;
const TAIL_SEC = 3;
const MAX_TAIL_LUFS = -18;

const shots: Shot[] = [
  { start: 0, end: 1.5, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '开场钩子', highlight: [] } } },
  { start: 1.5, end: SPEECH_SEC, layout: 'full' },
];
const captions = [{ start: 0, end: LAST_CAPTION_END, text: '一句话' }];

async function lufsOf(ffmpeg: string, file: string, fromSec: number, toSec: number): Promise<number> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `atrim=${fromSec}:${toSec},asetpts=N/SR/TB,ebur128`, '-f', 'null', '-']);
  const text = stderr.slice(stderr.lastIndexOf('Summary:'));
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?inf|-?[\d.]+)\s*LUFS/.exec(text);
  return m && m[1] !== '-inf' ? Number(m[1]) : -Infinity;
}

/** 第 n 帧里一个点的 RGB */
async function pixel(ffmpeg: string, file: string, n: number, x: number, y: number): Promise<[number, number, number]> {
  const buf = await runBuffer(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),format=rgb24,crop=4:4:${x}:${y}`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [buf[0], buf[1], buf[2]];
}

/** 第 n 帧缩成 27×48 的 RGB 像素 */
async function smallFrame(ffmpeg: string, file: string, n: number): Promise<number[]> {
  const buf = await runBuffer(ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=27:48,format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  return [...buf];
}

/** 一段时间内的最大音量（dB） */
async function maxVolume(ffmpeg: string, file: string, fromSec: number, toSec: number): Promise<number> {
  const { stderr } = await run(ffmpeg, ['-hide_banner', '-nostats', '-i', file, '-vn', '-af', `atrim=${fromSec}:${toSec},asetpts=N/SR/TB,volumedetect`, '-f', 'null', '-']);
  return Number(/max_volume: (-?[\d.]+) dB/.exec(stderr)?.[1]);
}

describe('品牌片尾真实渲染', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-outro-data-'));
  const cfg = { ...loadConfig({}), dataDir };
  const track = loadTracks()[0];
  const outroStart = Math.max(SPEECH_SEC, Math.ceil((LAST_CAPTION_END + HOLD_SEC) * 30 - 1e-6) / 30);

  /** 渲染样片：口播 3 秒 + 留白 + 片尾；bgm 为 'none' 或合成配乐 */
  async function renderSample(bgm: 'none' | 'track', opts: { voiceDb?: number; shots?: Shot[] } = {}): Promise<{ output: string; messages: string[] }> {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-outro-'));
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', join(process.cwd(), 'tests/fixtures/talk.mp4'), '-t', String(SPEECH_SEC), '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ...(opts.voiceDb ? ['-af', `volume=${opts.voiceDb}dB`] : []), '-c:a', 'aac', join(workDir, 'person.mp4')]);
    const output = join(workDir, 'final.mp4');
    const messages: string[] = [];
    const complete: Complete = (_step, message) => { messages.push(message); return {} as never; };
    const args = { input: join(workDir, 'in.mp4'), workDir, output, cfg, audio: { bgm: bgm === 'none' ? 'none' : track.id } } as PipelineArgs;
    await composeStage(args, { person: join(workDir, 'person.mp4'), subject: null, captions, storyboard: { shots: opts.shots ?? shots, bgm: 'chill' }, outputDurationSec: SPEECH_SEC, raw: join(workDir, 'final.raw.mp4'), output, cacheDir: join(workDir, 'segments') }, complete);
    return { output, messages };
  }

  beforeAll(async () => {
    mkdirSync(join(dataDir, 'assets', 'music'), { recursive: true });
    // 三个正弦的和弦，归一到 -14 LUFS，相当于一首母带音量的配乐
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=261.6:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=329.6:duration=12', '-f', 'lavfi', '-i', 'sine=frequency=392:duration=12',
      '-filter_complex', '[0][1][2]amix=inputs=3,loudnorm=I=-14', '-c:a', 'libmp3lame', trackPath(cfg, track)]);
  });

  it('留白 ≥ 0.6 秒、片尾 2–3 秒、片尾 3 秒响度 ≤ -18 LUFS，整片响度仍在目标附近，片尾画面是品牌 logo', async () => {
    const { output } = await renderSample('track');
    const info = await probe(output, cfg);
    expect(outroStart - LAST_CAPTION_END).toBeGreaterThanOrEqual(HOLD_SEC - 1e-9);
    expect(info.durationSec - outroStart).toBeGreaterThanOrEqual(OUTRO_SEC - 0.15);
    expect(info.durationSec - outroStart).toBeLessThanOrEqual(3 + 0.15);

    const tail = await lufsOf(cfg.ffmpeg, output, info.durationSec - TAIL_SEC, info.durationSec);
    expect(tail).toBeLessThanOrEqual(MAX_TAIL_LUFS);
    expect(tail).toBeGreaterThan(-45);
    const whole = await lufsOf(cfg.ffmpeg, output, 0, info.durationSec);
    expect(Math.abs(whole - -14)).toBeLessThanOrEqual(1.5);

    // 画面：片尾末帧是品牌米色底 + 蓝色 logo；留白帧还是定格的人像，不是米色底
    const lastFrame = Math.round((outroStart + OUTRO_SEC) * 30) - 3;
    const [bg0, bg1, bg2] = await pixel(cfg.ffmpeg, output, lastFrame, 40, 40);
    expect(Math.abs(bg0 - 0xef) + Math.abs(bg1 - 0xeb) + Math.abs(bg2 - 0xe5)).toBeLessThan(24);
    const [r, , b] = await pixel(cfg.ffmpeg, output, lastFrame, 440, 800);
    expect(b).toBeGreaterThan(r + 80);
    const [h0, h1, h2] = await pixel(cfg.ffmpeg, output, Math.round((SPEECH_SEC + 0.1) * 30), 40, 40);
    expect(Math.abs(h0 - 0xef) + Math.abs(h1 - 0xeb) + Math.abs(h2 - 0xe5)).toBeGreaterThan(40);
  }, 300_000);

  it('留白里人像定格且不出声（无配乐时口播结束后到片尾 logo 音之前一片寂静）', async () => {
    const { output } = await renderSample('none');
    // 口播音轨末尾有约 0.1 秒的 AAC 填充，窗口从口播结束后 0.2 秒起
    expect(await maxVolume(cfg.ffmpeg, output, SPEECH_SEC + 0.2, outroStart)).toBeLessThan(-60);
    // 对照：口播里确实有声音
    expect(await maxVolume(cfg.ffmpeg, output, 0.5, 2.5)).toBeGreaterThan(-30);
  }, 300_000);

  it('安静的人声（约 -28 LUFS，手机录音常见电平）：片尾仍 ≤ -18 LUFS，校正只动片尾（口播不动）并写进度', async () => {
    const quiet = await renderSample('track', { voiceDb: -9 });
    const info = await probe(quiet.output, cfg);
    const tail = await lufsOf(cfg.ffmpeg, quiet.output, info.durationSec - TAIL_SEC, info.durationSec);
    expect(tail).toBeLessThanOrEqual(MAX_TAIL_LUFS);
    // 口播响度仍统一在 -14 附近（校正没有拉低整片）
    const speech = await lufsOf(cfg.ffmpeg, quiet.output, 0.2, SPEECH_SEC - 0.1);
    expect(speech).toBeGreaterThan(-18);
    expect(quiet.messages.some((m) => m.includes('片尾衰减'))).toBe(true);
  }, 300_000);

  it('末镜头带卡片：留白期间卡片与人像整体定格，不瞬间消失（留白帧与口播末帧的上下半屏几乎一致）', async () => {
    const withCard: Shot[] = [{ start: 0, end: 1.5, layout: 'full' }, { start: 1.5, end: SPEECH_SEC, layout: 'split', card: { template: 'title', props: { title: '定格的卡片' } } }];
    const { output } = await renderSample('none', { shots: withCard });
    const lastSpeech = Math.round(SPEECH_SEC * 30) - 2;
    const held = Math.round((SPEECH_SEC + 0.2) * 30);
    const a = await smallFrame(cfg.ffmpeg, output, lastSpeech);
    const b = await smallFrame(cfg.ffmpeg, output, held);
    const diff = a.reduce((sum, v, i) => sum + Math.abs(v - b[i]), 0) / a.length;
    expect(diff).toBeLessThan(6);
  }, 300_000);
});
