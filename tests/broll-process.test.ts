import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { planCrop, thirdsCrop } from '../src/broll/crop.js';
import { CUT_SCORE, MIN_USABLE_SEC, parseFrameStats, pickSegment, speedFor, type FrameStat, type Segment } from '../src/broll/segment.js';
import { WB_MAX, WB_MIN, wbGains } from '../src/broll/grade.js';
import { PROJECT_LUT, UnusableAssetError, processAsset } from '../src/broll/process.js';
import { verifyOutput } from '../src/broll/verify.js';

const cfg = loadConfig();
const ctx = { ffmpeg: cfg.ffmpeg, ffprobe: cfg.ffprobe, lut: PROJECT_LUT };
let dir = '';
beforeAll(() => { dir = mkdtempSync(join(tmpdir(), 'mz-bproc-')); });
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Probed { width: number; height: number; fps: number; codec: string; hasAudio: boolean; duration: number }
async function probeOut(file: string): Promise<Probed> {
  const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_streams', '-show_format', file]);
  const j = JSON.parse(stdout) as { streams: { codec_type: string; codec_name: string; width?: number; height?: number; r_frame_rate?: string }[]; format: { duration?: string } };
  const v = j.streams.find((s) => s.codec_type === 'video')!;
  const [n, d] = (v.r_frame_rate ?? '0/1').split('/').map(Number);
  return { width: v.width!, height: v.height!, fps: n / d, codec: v.codec_name, hasAudio: j.streams.some((s) => s.codec_type === 'audio'), duration: Number(j.format.duration) };
}

/** 读整张图（或视频第一帧）的 rgb24 像素 */
const pixels = (file: string, w: number, h: number): Promise<Buffer> =>
  runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);

describe('智能裁切', () => {
  it('主体在角落：裁框贴住边界不越界，主体仍在框内', () => {
    const rect = thirdsCrop({ width: 4000, height: 3000 }, { x: 0.05, y: 0.05 }, 1080 / 1920);
    expect(rect.x).toBe(0);
    expect(rect.y).toBe(0);
    expect(rect.height).toBe(3000);
    expect(rect.width).toBeCloseTo(3000 * (1080 / 1920), -1);
    expect(0.05 * 4000).toBeLessThan(rect.width);
  });
  it('主体偏右：落在裁框右三分线附近', () => {
    const rect = thirdsCrop({ width: 4000, height: 3000 }, { x: 0.62, y: 0.5 }, 1080 / 1920);
    const fx = (0.62 * 4000 - rect.x) / rect.width;
    expect(fx).toBeCloseTo(2 / 3, 1);
  });
  it('竖图做横框：主体偏上落在上三分线附近', () => {
    const rect = thirdsCrop({ width: 2000, height: 4000 }, { x: 0.5, y: 0.3 }, 16 / 9);
    const fy = (0.3 * 4000 - rect.y) / rect.height;
    expect(rect.width).toBe(2000);
    expect(fy).toBeCloseTo(1 / 3, 1);
  });
  it('分辨率足够（放大不超过 1/0.8）：不降级，输出目标尺寸', () => {
    const plan = planCrop({ width: 1920, height: 1080 }, { x: 0.5, y: 0.5 }, { width: 540, height: 960 });
    expect(plan.downgrade).toBeUndefined();
    expect(plan.output).toEqual({ width: 540, height: 960 });
  });
  it('生产尺寸：横屏 1080p 做全屏竖屏 1080×1920 降级为 split（裁框宽 606 < 864），不硬放大', () => {
    const plan = planCrop({ width: 1920, height: 1080 }, { x: 0.5, y: 0.5 }, { width: 1080, height: 1920 });
    expect(plan.downgrade).toBe('split');
    expect(plan.output).toEqual({ width: 1080, height: 960 });
    expect(plan.crop.width / plan.crop.height).toBeCloseTo(1080 / 960, 2);
  });
  it('生产尺寸：4K 横屏、1080p 竖屏都能铺满 1080×1920，不降级', () => {
    expect(planCrop({ width: 3840, height: 2160 }, { x: 0.3, y: 0.5 }, { width: 1080, height: 1920 })).toMatchObject({ output: { width: 1080, height: 1920 } });
    expect(planCrop({ width: 3840, height: 2160 }, { x: 0.3, y: 0.5 }, { width: 1080, height: 1920 }).downgrade).toBeUndefined();
    expect(planCrop({ width: 1080, height: 1920 }, { x: 0.5, y: 0.5 }, { width: 1080, height: 1920 }).downgrade).toBeUndefined();
  });
  it('超宽全景：竖屏盖不住但上半屏盖得住，降级为 split', () => {
    const plan = planCrop({ width: 3840, height: 1080 }, { x: 0.5, y: 0.5 }, { width: 1080, height: 1920 });
    expect(plan.downgrade).toBe('split');
    expect(plan.crop.width / plan.crop.height).toBeCloseTo(1080 / 960, 2);
  });
  it('focal 不是有限数：明确报错', () => {
    expect(() => planCrop({ width: 1920, height: 1080 }, { x: Number.NaN, y: 0.5 }, { width: 1080, height: 1920 })).toThrow(/focal/);
  });
  it('小图连半屏都盖不住：降级为 pip，保持原比例且不放大', () => {
    const plan = planCrop({ width: 640, height: 480 }, { x: 0.5, y: 0.5 }, { width: 1080, height: 1920 });
    expect(plan.downgrade).toBe('pip');
    expect(plan.output.width).toBeLessThanOrEqual(640);
    expect(plan.output.height).toBeLessThanOrEqual(480);
    expect(plan.output.width / plan.output.height).toBeCloseTo(640 / 480, 1);
  });
});

const flat = (from: number, to: number, fps: number, diff = 1): FrameStat[] =>
  Array.from({ length: Math.round((to - from) * fps) }, (_, i) => ({ t: from + i / fps, diff, score: 0 }));

describe('视频选段', () => {
  it('解析 ffmpeg metadata 打印：时间、帧差、剪辑点分数', () => {
    const text = 'frame:0    pts:0       pts_time:0\nlavfi.signalstats.YDIF=0.000000\nlavfi.scd.mafd=0.000\nlavfi.scd.score=0.000\nframe:1    pts:512     pts_time:0.0333\nlavfi.signalstats.YDIF=3.5\nlavfi.scd.mafd=12.1\nlavfi.scd.score=42.000\nlavfi.scd.time=0.0333\n';
    expect(parseFrameStats(text)).toEqual([{ t: 0, diff: 0, score: 0 }, { t: 0.0333, diff: 3.5, score: 42 }]);
  });
  it('60fps 放 0.5× 升格，其他帧率原速', () => {
    expect(speedFor(59.94)).toBe(0.5);
    expect(speedFor(60)).toBe(0.5);
    expect(speedFor(30)).toBe(1);
    expect(speedFor(25)).toBe(1);
  });
  it('避开素材内部剪辑点，选运动平稳的一段', () => {
    const fps = 30;
    const shaky = flat(4, 6, fps).map((s, i) => ({ ...s, diff: i % 2 ? 9 : 0.5 }));
    const stats = [...flat(0, 2, fps), ...flat(2, 4, fps, 2), ...shaky, ...flat(6, 10, fps, 1.5)];
    const cutAt = Math.round(2 * fps);
    stats[cutAt] = { ...stats[cutAt], score: CUT_SCORE + 20 };
    const seg = pickSegment(stats, { fps, durationSec: 10 }) as Segment;
    expect(seg.outSec).toBe(3);
    expect(seg.speed).toBe(1);
    const end = seg.start + seg.sourceSec;
    expect(seg.start >= 2 || end <= 2).toBe(true);
    expect(seg.start >= 6 || end <= 4).toBe(true);
  });
  it('60fps：源片段取输出时长的一半；期望时长夹在 2–4 秒', () => {
    const stats = flat(0, 8, 60);
    expect(pickSegment(stats, { fps: 60, durationSec: 8, wantSec: 3 })).toMatchObject({ speed: 0.5, sourceSec: 1.5, outSec: 3 });
    expect(pickSegment(stats, { fps: 60, durationSec: 8, wantSec: 9 })).toMatchObject({ outSec: 4 });
    expect(pickSegment(stats, { fps: 60, durationSec: 8, wantSec: 1 })).toMatchObject({ outSec: 2 });
  });
  it('素材比期望短：整段可用部分全取，输出相应变短', () => {
    const seg = pickSegment(flat(0, 1.6, 30), { fps: 30, durationSec: 1.6 }) as Segment;
    expect(seg.start).toBe(0);
    expect(seg.sourceSec).toBeCloseTo(1.6, 1);
    expect(seg.outSec).toBeCloseTo(1.6, 1);
  });
  const choppy = (every: number): FrameStat[] => flat(0, 10, 30).map((f, i) => ({ ...f, score: i > 0 && i % Math.round(every * 30) === 0 ? CUT_SCORE + 30 : 0 }));
  it('每 0.5 秒一个剪辑点：没有可用平稳段，返回 unusable，不产出碎片', () => {
    const seg = pickSegment(choppy(0.5), { fps: 30, durationSec: 10 });
    expect(seg).toEqual({ unusable: expect.stringMatching(/剪辑点过密/) });
  });
  it('每 0.2 秒一个剪辑点：返回 unusable，不把剪辑点放回输出', () => {
    expect(pickSegment(choppy(0.2), { fps: 30, durationSec: 10 })).toEqual({ unusable: expect.stringMatching(/剪辑点过密/) });
  });
  it(`镜头最长不足 ${MIN_USABLE_SEC} 秒输出时长：unusable；刚好够则可用`, () => {
    expect('unusable' in pickSegment(flat(0, 1.2, 30), { fps: 30, durationSec: 1.2 })).toBe(true);
    const ok = pickSegment(flat(0, 1.6, 30), { fps: 30, durationSec: 1.6 }) as Segment;
    expect(ok.outSec).toBeGreaterThanOrEqual(MIN_USABLE_SEC);
  });
  it('分析结果为空：不会把整条素材当成一段', () => {
    expect(pickSegment([], { fps: 30, durationSec: 40 })).toMatchObject({ start: 0, sourceSec: 3, outSec: 3 });
  });
});

describe('白平衡增益', () => {
  it('素材与参考色一致：增益全为 1', () => {
    const g = wbGains([0.5, 0.45, 0.4], [0.5, 0.45, 0.4]);
    g.forEach((v) => expect(v).toBeCloseTo(1, 5));
  });
  it('参考偏蓝：蓝通道增益 > 红通道，且都夹在 0.9–1.1', () => {
    const g = wbGains([0.6, 0.5, 0.35], [0.3, 0.45, 0.8]);
    expect(g[2]).toBeGreaterThan(g[0]);
    g.forEach((v) => { expect(v).toBeGreaterThanOrEqual(WB_MIN); expect(v).toBeLessThanOrEqual(WB_MAX); });
  });
});

describe('项目 LUT', () => {
  it('33³ 的 .cube：头部与条目数正确', () => {
    const lines = readFileSync(PROJECT_LUT, 'utf8').trim().split('\n');
    expect(lines).toContain('LUT_3D_SIZE 33');
    expect(lines.filter((l) => /^[\d.]+ [\d.]+ [\d.]+$/.test(l))).toHaveLength(33 ** 3);
  });
  it('色彩统计变化方向：降饱和、柔高光、黑位微抬、阴影偏青绿、高光偏暖、中灰不脏、肤色干净', async () => {
    const patches = [[255, 0, 0], [0, 200, 0], [0, 0, 255], [255, 255, 255], [0, 0, 0], [40, 40, 40], [220, 220, 220], [128, 128, 128], [217, 166, 140]];
    const input = join(dir, 'patches.rgb');
    writeFileSync(input, Buffer.from(patches.flat()));
    const out = await runBuffer(cfg.ffmpeg, ['-v', 'error', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', `${patches.length}x1`, '-i', input, '-vf', `lut3d=file=${basename(PROJECT_LUT)}:interp=tetrahedral`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { cwd: dirname(PROJECT_LUT) });
    const px = (i: number): number[] => [out[i * 3], out[i * 3 + 1], out[i * 3 + 2]];
    const spread = (c: number[]): number => Math.max(...c) - Math.min(...c);
    for (let i = 0; i < 3; i += 1) expect(spread(px(i))).toBeLessThan(spread(patches[i]) * 0.75);
    const [white, black, shadow, light, mid, skin] = [px(3), px(4), px(5), px(6), px(7), px(8)];
    white.forEach((v) => { expect(v).toBeLessThan(250); expect(v).toBeGreaterThan(228); });
    black.forEach((v) => { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(12); });
    expect(shadow[2]).toBeGreaterThan(shadow[0]);
    expect(shadow[1]).toBeGreaterThan(shadow[0]);
    expect(light[0]).toBeGreaterThan(light[2]);
    expect(Math.abs(mid[0] - mid[2])).toBeLessThanOrEqual(8);
    expect(skin[0]).toBeGreaterThan(skin[1]);
    expect(skin[1]).toBeGreaterThan(skin[2]);
  });
});

describe('processAsset：真实 ffmpeg 处理小样', () => {
  it('60fps 带剪辑点和音轨的视频：避开剪辑点、0.5× 升格、30fps、去音轨、H.264、目标尺寸', async () => {
    const src = join(dir, 'cut60.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptehdbars=s=1920x1080:r=60:d=1.2', '-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=60:d=4',
      '-f', 'lavfi', '-i', 'sine=d=5.2', '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-map', '2', '-c:v', 'libx264', '-preset', 'ultrafast', '-c:a', 'aac', '-shortest', src]);
    const out = join(dir, 'cut60-out.mp4');
    const res = await processAsset({ file: src, kind: 'video', focal: { x: 0.5, y: 0.5 }, target: { width: 540, height: 960 } }, out, ctx);
    expect(res.file).toBe(out);
    expect(res.downgrade).toBeUndefined();
    expect(res.durationSec).toBeCloseTo(3, 1);
    expect(res.modified).toEqual(expect.arrayContaining(['crop', 'trim', 'speed0.5', 'mute', 'lut']));
    const p = await probeOut(out);
    expect(p).toMatchObject({ width: 540, height: 960, codec: 'h264', hasAudio: false });
    expect(p.fps).toBeCloseTo(30, 1);
    expect(p.duration).toBeGreaterThan(2.8);
    expect(p.duration).toBeLessThan(3.2);
    const { stdout } = await run(cfg.ffmpeg, ['-v', 'error', '-i', out, '-vf', 'scdet,metadata=mode=print:file=-', '-f', 'null', '-']);
    expect(Math.max(...parseFrameStats(stdout).map((s) => s.score))).toBeLessThan(CUT_SCORE);
  }, 120_000);
  it('25fps 视频：原速、统一转 30fps', async () => {
    const src = join(dir, 'v25.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1280x720:r=25:d=5', '-c:v', 'libx264', '-preset', 'ultrafast', src]);
    const out = join(dir, 'v25-out.mp4');
    const res = await processAsset({ file: src, kind: 'video', focal: { x: 0.3, y: 0.5 }, target: { width: 480, height: 270 }, wantSec: 2.5 }, out, ctx);
    expect(res.modified).not.toContain('speed0.5');
    expect(res.modified).toContain('fps30');
    expect(res.durationSec).toBeCloseTo(2.5, 1);
    const p = await probeOut(out);
    expect(p.fps).toBeCloseTo(30, 1);
    expect(p).toMatchObject({ width: 480, height: 270, hasAudio: false });
  }, 120_000);
  it('大图：按 focal 裁到目标尺寸并套 LUT', async () => {
    const src = join(dir, 'big.jpg');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3000x2000', '-frames:v', '1', src]);
    const out = join(dir, 'big-out.jpg');
    const res = await processAsset({ file: src, kind: 'photo', focal: { x: 0.85, y: 0.4 }, target: { width: 1080, height: 1920 } }, out, ctx);
    expect(res.downgrade).toBeUndefined();
    expect(res.durationSec).toBeUndefined();
    expect(res.modified).toEqual(expect.arrayContaining(['crop', 'lut']));
    expect(await probeOut(out)).toMatchObject({ width: 1080, height: 1920 });
  });
  it('生产尺寸：4K 横屏视频裁成 1080×1920 全屏，不降级', async () => {
    const src = join(dir, 'uhd.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=3840x2160:r=30:d=3', '-c:v', 'libx264', '-preset', 'ultrafast', src]);
    const out = join(dir, 'uhd-out.mp4');
    const res = await processAsset({ file: src, kind: 'video', focal: { x: 0.6, y: 0.5 }, target: { width: 1080, height: 1920 }, wantSec: 2 }, out, ctx);
    expect(res.downgrade).toBeUndefined();
    expect(await probeOut(out)).toMatchObject({ width: 1080, height: 1920, codec: 'h264' });
  }, 120_000);
  it('剪辑点过密的视频：抛 UnusableAssetError，不留输出文件', async () => {
    const src = join(dir, 'choppy.mp4');
    const colors = ['red', 'blue', 'green', 'white', 'black', 'yellow', 'purple', 'orange'];
    const inputs = colors.flatMap((c) => ['-f', 'lavfi', '-i', `color=c=${c}:s=320x240:r=30:d=0.5`]);
    await run(cfg.ffmpeg, ['-v', 'error', '-y', ...inputs, '-filter_complex', `${colors.map((_, i) => `[${i}]`).join('')}concat=n=${colors.length}:v=1:a=0[v]`, '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', src]);
    const out = join(dir, 'choppy-out.mp4');
    await expect(processAsset({ file: src, kind: 'video', focal: { x: 0.5, y: 0.5 }, target: { width: 240, height: 240 } }, out, ctx)).rejects.toBeInstanceOf(UnusableAssetError);
    expect(existsSync(out)).toBe(false);
  });
  it('单关键帧 mpegts（起始时间 6.4 秒，输入端跳转会读空）：仍产出完整视频', async () => {
    const src = join(dir, 'onekey.ts');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'smptehdbars=s=640x360:r=30:d=1.2', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4',
      '-filter_complex', '[0][1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1000', '-output_ts_offset', '5', '-f', 'mpegts', src]);
    const out = join(dir, 'onekey-out.mp4');
    const res = await processAsset({ file: src, kind: 'video', focal: { x: 0.5, y: 0.5 }, target: { width: 320, height: 180 }, wantSec: 2 }, out, ctx);
    const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-count_packets', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_packets', '-of', 'csv=p=0', out]);
    expect(Number(stdout.trim())).toBe(60);
    expect(res.durationSec).toBe(2);
  }, 120_000);
  it('产物校验：输出为空、帧数不足、尺寸不符都报错', async () => {
    const src = join(dir, 'onekey2.ts');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x360:r=30:d=4', '-c:v', 'libx264', '-preset', 'ultrafast', '-g', '1000', '-output_ts_offset', '5', '-f', 'mpegts', src]);
    const empty = join(dir, 'empty.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-ss', '1', '-t', '2', '-i', src, '-frames:v', '60', '-c:v', 'libx264', empty]);
    await expect(verifyOutput(cfg.ffprobe, empty, { outSec: 2 })).rejects.toThrow(/输出为空|没有视频/);
    const short = join(dir, 'short.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-i', src, '-frames:v', '30', '-c:v', 'libx264', short]);
    await expect(verifyOutput(cfg.ffprobe, short, { outSec: 2 })).rejects.toThrow(/帧数/);
    await expect(verifyOutput(cfg.ffprobe, short, { outSec: 1 })).resolves.toBeUndefined();
    await expect(verifyOutput(cfg.ffprobe, short, { size: { width: 320, height: 180 } })).rejects.toThrow(/尺寸/);
  }, 120_000);
  it('坏文件：报错带上素材文件名', async () => {
    const bad = join(dir, 'broken.mp4');
    writeFileSync(bad, 'not a video');
    await expect(processAsset({ file: bad, kind: 'video', focal: { x: 0.5, y: 0.5 }, target: { width: 540, height: 960 } }, join(dir, 'broken-out.mp4'), ctx)).rejects.toThrow(/素材加工失败（broken\.mp4）/);
  });
  it('小图：返回 pip 降级，不硬放大', async () => {
    const src = join(dir, 'small.jpg');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=640x480', '-frames:v', '1', src]);
    const out = join(dir, 'small-out.jpg');
    const res = await processAsset({ file: src, kind: 'photo', focal: { x: 0.5, y: 0.5 }, target: { width: 1080, height: 1920 } }, out, ctx);
    expect(res.downgrade).toBe('pip');
    const p = await probeOut(out);
    expect(p.width).toBeLessThanOrEqual(640);
    expect(p.height).toBeLessThanOrEqual(480);
  });
  it('白平衡：参考色偏蓝时输出更偏蓝（相对不做白平衡）', async () => {
    const src = join(dir, 'warm.jpg');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xb09070:s=800x800', '-frames:v', '1', src]);
    const input = { file: src, kind: 'photo' as const, focal: { x: 0.5, y: 0.5 }, target: { width: 400, height: 400 } };
    const plain = await processAsset(input, join(dir, 'wb-off.png'), ctx);
    const wb = await processAsset(input, join(dir, 'wb-on.png'), { ...ctx, whiteBalance: { r: 0.45, g: 0.5, b: 0.62 } });
    expect(plain.modified).not.toContain('wb');
    expect(wb.modified).toContain('wb');
    const a = await pixels(plain.file, 1, 1);
    const b = await pixels(wb.file, 1, 1);
    expect(b[2] / b[0]).toBeGreaterThan(a[2] / a[0]);
    expect(b[2] / b[0]).toBeLessThan((a[2] / a[0]) * 1.25);
  });
});
