import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CancelledError } from '../src/cancel.js';
import { loadConfig } from '../src/config.js';
import { run, runBuffer } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import { renderTalk } from '../src/compose/render.js';
import { codeFiles, createStamper, renderSegmented, segmentBounds, segmentSalt, shotHash } from '../src/compose/segments.js';
import type { Shot, TalkProps } from '../src/storyboard/schema.js';

const title = (t: string): Shot['card'] => ({ template: 'title', props: { title: t } });
const SHOTS: Shot[] = [
  { start: 0, end: 1, layout: 'split', card: title('甲') },
  { start: 1, end: 2, layout: 'split', card: title('乙') },
  { start: 2, end: 3, layout: 'full' },
];
const BASE: TalkProps = {
  person: 'person.mp4', personWidth: 360, personHeight: 640, subject: null, durationSec: 3, shots: SHOTS,
  captions: [{ start: 0, end: 1.5, text: '第一行' }, { start: 1.5, end: 3, text: '第二行' }],
};
const { shots: _shots, ...REST } = BASE;
const RANGE = { start: 0, end: 30 };
const hashAll = (p: TalkProps): string[] => {
  const { shots, ...rest } = p;
  return segmentBounds(shots, p.durationSec).map((range, i) => shotHash(shots[i], rest, i, { shots, range }));
};

describe('segmentBounds', () => {
  it('首段从 0 起、末段到总帧数止，相邻段首尾相接（镜头起点非整帧时四舍五入）', () => {
    const shots: Shot[] = [{ start: 0.02, end: 1.01, layout: 'full' }, { start: 1.01, end: 2.5, layout: 'full' }, { start: 2.5, end: 3, layout: 'full' }];
    expect(segmentBounds(shots, 3)).toEqual([{ start: 0, end: 30 }, { start: 30, end: 75 }, { start: 75, end: 90 }]);
  });
});

describe('shotHash', () => {
  it('同样输入哈希稳定；sfx、bgm 不影响画面所以不进哈希', () => {
    const base = hashAll(BASE);
    expect(hashAll({ ...BASE })).toEqual(base);
    expect(hashAll({ ...BASE, sfx: [{ sec: 1, sfx: 'click', volume: 1 }], bgm: { file: 'a.mp3', keys: [], durationSec: 1 } })).toEqual(base);
  });
  it('改卡片内容只影响该镜头', () => {
    const base = hashAll(BASE);
    const next = hashAll({ ...BASE, shots: [SHOTS[0], { ...SHOTS[1], card: title('乙改') }, SHOTS[2]] });
    expect(next.map((h, i) => h === base[i])).toEqual([true, false, true]);
  });
  it('字幕：只影响文字落在本段帧范围内的镜头；跨镜头边界的字幕两段都变', () => {
    const base = hashAll(BASE);
    const inside = hashAll({ ...BASE, captions: [BASE.captions[0], { start: 1.5, end: 3, text: '第二行改' }] });
    expect(inside.map((h, i) => h === base[i])).toEqual([true, false, false]);
    const cross = hashAll({ ...BASE, captions: [{ start: 0, end: 1.5, text: '跨边界改' }, BASE.captions[1]] });
    expect(cross.map((h, i) => h === base[i])).toEqual([false, false, true]);
  });
  it('字幕起止时间微调到帧内变化也算（影响显示的帧）', () => {
    const base = hashAll(BASE);
    const moved = hashAll({ ...BASE, captions: [{ start: 0, end: 1.5, text: '第一行' }, { start: 1.6, end: 3, text: '第二行' }] });
    expect(moved.map((h, i) => h === base[i])).toEqual([true, false, true]);
  });
  it('版式过渡：改前一个镜头的版式会影响后一个镜头开头的人像位置', () => {
    const base = hashAll(BASE);
    const next = hashAll({ ...BASE, shots: [{ ...SHOTS[0], layout: 'full' }, SHOTS[1], SHOTS[2]] });
    expect(next.map((h, i) => h === base[i])).toEqual([false, false, true]);
  });
  it('全片最后一个镜头不淡出：cta 镜头后面追加镜头，它的出场动画会变，哈希随之变化', () => {
    const cta: Shot = { start: 2, end: 3, layout: 'full', card: { template: 'cta', props: { actions: ['关注'] } } };
    const before = hashAll({ ...BASE, shots: [...SHOTS.slice(0, 2), cta] });
    const after = hashAll({ ...BASE, durationSec: 4, shots: [...SHOTS.slice(0, 2), cta, { start: 3, end: 4, layout: 'full' }] });
    expect(after[2]).not.toBe(before[2]);
    expect(after[0]).toBe(before[0]);
  });
  it('人像文件、字幕样式、取景框、人像尺寸、盐值都会让所有镜头变化', () => {
    const base = hashAll(BASE);
    for (const patch of [{ person: 'other.mp4' }, { captionStyle: 'song' as const }, { subject: { top: 0.3 } as TalkProps['subject'] }, { personHeight: 700 }]) {
      hashAll({ ...BASE, ...patch }).forEach((h, i) => expect(h, JSON.stringify(patch)).not.toBe(base[i]));
    }
    expect(shotHash(SHOTS[0], REST, 0, { shots: SHOTS, range: RANGE, salt: 'x' })).not.toBe(shotHash(SHOTS[0], REST, 0, { shots: SHOTS, range: RANGE }));
  });
});

describe('盐值（素材与渲染代码指纹）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'mz-salt-'));
  mkdirSync(join(dir, 'broll'));
  mkdirSync(join(dir, 'fonts'));
  const write = (name: string, content: string, mtime = 1_700_000_000): void => {
    writeFileSync(join(dir, name), content);
    utimesSync(join(dir, name), mtime, mtime);
  };
  const photo = (image: string): Shot['card'] => ({ template: 'photo', props: { image } });
  const SHOTS4: Shot[] = [0, 1, 2, 3].map((i) => ({ start: i, end: i + 1, layout: 'split' as const, card: i === 1 ? photo('broll/a.png') : title(`镜${i}`) }));
  const props: TalkProps = { ...BASE, durationSec: 4, shots: SHOTS4, captionFontFile: 'f.ttf' };
  const salts = async (p: TalkProps = props, code?: string): Promise<string[]> => {
    const stamper = createStamper(dir, code);
    return Promise.all(p.shots.map((_, i) => segmentSalt(stamper, p, i)));
  };
  /** 与 renderSegmented 同样的算法：盐值进镜头哈希 */
  const hashes = async (p: TalkProps = props, code?: string): Promise<string[]> => {
    const sl = await salts(p, code);
    const { shots, ...rest } = p;
    return segmentBounds(shots, p.durationSec).map((range, i) => shotHash(shots[i], rest, i, { shots, range, salt: sl[i] }));
  };
  const changed = (a: string[], b: string[]): boolean[] => a.map((h, i) => h !== b[i]);

  beforeAll(() => {
    write('person.mp4', 'person-v1');
    write('broll/a.png', 'img-v1');
    write('fonts/f.ttf', 'font-v1');
  });

  it('B-roll 图片内容变：只有画面里出现这张图的镜头变（相邻镜头不显示它，不变）；mtime 变而内容不变则不变', async () => {
    const base = await hashes();
    write('broll/a.png', 'img-v1', 1_800_000_000);
    expect(changed(await hashes(), base)).toEqual([false, false, false, false]);
    write('broll/a.png', 'img-v2');
    expect(changed(await hashes(), base)).toEqual([false, true, false, false]);
    write('broll/a.png', 'img-v1');
  });
  it('图片同名同大小同 mtime 但内容不同也能识别', async () => {
    const base = await hashes();
    write('broll/a.png', 'img-XX');
    expect(changed(await hashes(), base)).toEqual([false, true, false, false]);
    write('broll/a.png', 'img-v1');
  });
  it('镜头边界不在整帧上、段首的帧还属于前一个镜头时，前一个镜头的素材也进本段指纹', async () => {
    // 第 2 镜从 2.01 秒开始：第 2 段从第 60 帧（2.0 秒）起，这一帧仍是第 1 镜（带图）
    const odd: TalkProps = { ...props, shots: SHOTS4.map((s, i) => (i === 1 ? { ...s, end: 2.01 } : i === 2 ? { ...s, start: 2.01 } : s)) };
    expect(segmentBounds(odd.shots, odd.durationSec)[2]).toEqual({ start: 60, end: 90 });
    const sl = await salts(odd, 'c');
    expect(sl.map((x) => x.includes('broll/a.png'))).toEqual([false, true, true, false]);
  });
  it('换掉一个镜头的卡片（新卡片带图）：前后镜头的哈希不变（v1→v2 差异标记误报）', async () => {
    const base = await hashes();
    const next: TalkProps = { ...props, shots: SHOTS4.map((s, i) => (i === 2 ? { ...s, card: photo('broll/a.png') } : s)) };
    expect(changed(await hashes(next), base)).toEqual([false, false, true, false]);
  });
  it('人像文件内容变：所有镜头变', async () => {
    const base = await hashes();
    write('person.mp4', 'person-v2');
    expect(changed(await hashes(), base)).toEqual([true, true, true, true]);
    write('person.mp4', 'person-v1');
  });
  it('字体文件内容变：所有镜头变', async () => {
    const base = await hashes();
    write('fonts/f.ttf', 'font-v2');
    expect(changed(await hashes(), base)).toEqual([true, true, true, true]);
    write('fonts/f.ttf', 'font-v1');
  });
  it('渲染代码指纹变：所有镜头变；素材文件缺失与存在不同', async () => {
    const base = await hashes();
    expect(changed(await hashes(props, 'code-v2'), base)).toEqual([true, true, true, true]);
    expect(changed(await hashes({ ...props, person: 'nope.mp4' }), base)).toEqual([true, true, true, true]);
  });
  it('同一指纹器内同一文件只读一次（改文件后同一次调用内仍是旧值）', async () => {
    const stamper = createStamper(dir, 'c');
    const before = await stamper.file('person.mp4');
    write('person.mp4', 'person-v3');
    expect(await stamper.file('person.mp4')).toBe(before);
    write('person.mp4', 'person-v1');
  });
  it('代码指纹文件清单包含渲染包的 src 依赖（对比度、画布常量）与 render 模板', () => {
    const files = codeFiles().map((f) => f.replace(/\\/g, '/'));
    for (const tail of ['src/qa/contrast.ts', 'src/storyboard/schema.ts', 'src/captions/styles.ts', 'render/Talk.tsx', 'render/templates/Cta.tsx']) expect(files.some((f) => f.endsWith(tail)), tail).toBe(true);
  });
  it('默认代码指纹：40 位十六进制、重复计算稳定', () => {
    expect(createStamper(dir).code).toMatch(/^[0-9a-f]{40}$/);
    expect(createStamper(dir).code).toBe(createStamper(dir).code);
  });
});

describe('renderSegmented 边界', () => {
  it('分镜为空：抛中文错误', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-seg-empty-'));
    await expect(renderSegmented({ workDir, cacheDir: join(workDir, 'c'), output: join(workDir, 'o.mp4'), props: { ...BASE, shots: [] } })).rejects.toThrow('分镜为空');
  });
});

describe('renderSegmented 取消（真实 Remotion 渲染）', () => {
  const cfg = loadConfig({});
  const makeDir = async (): Promise<string> => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-seg-cancel-'));
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workDir, 'person.mp4')]);
    return workDir;
  };

  it('开始前已取消：抛 CancelledError，什么都不渲染也不产出', async () => {
    const workDir = await makeDir();
    const controller = new AbortController();
    controller.abort();
    await expect(renderSegmented({ workDir, cacheDir: join(workDir, 'cache'), props: BASE, output: join(workDir, 'final.mp4'), ffmpeg: cfg.ffmpeg, signal: controller.signal })).rejects.toBeInstanceOf(CancelledError);
    expect(existsSync(join(workDir, 'final.mp4'))).toBe(false);
  }, 60_000);

  it('第一段渲完后取消：抛 CancelledError；已渲完的段留作缓存，不留临时文件，也不产出成片', async () => {
    const workDir = await makeDir();
    const cacheDir = join(workDir, 'cache');
    const controller = new AbortController();
    await expect(renderSegmented({
      workDir, cacheDir, props: BASE, output: join(workDir, 'final.mp4'), ffmpeg: cfg.ffmpeg, signal: controller.signal,
      onProgress: () => controller.abort(),
    })).rejects.toBeInstanceOf(CancelledError);
    const files = readdirSync(cacheDir);
    expect(files.filter((f) => f.includes('.tmp.'))).toEqual([]);
    expect(files.filter((f) => f.endsWith('.mp4'))).toHaveLength(1);
    expect(existsSync(join(workDir, 'final.mp4'))).toBe(false);
  }, 120_000);
});

describe('renderSegmented（真实 Remotion 渲染）', () => {
  const cfg = loadConfig({});
  const workDir = mkdtempSync(join(tmpdir(), 'mz-seg-'));
  const cacheDir = join(workDir, 'cache');
  const output = join(workDir, 'final.mp4');
  const progress: [number, number, number][] = [];
  const frames = async (file: string): Promise<number> => {
    const { stdout } = await run(cfg.ffprobe, ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'csv=p=0', file]);
    return Number.parseInt(stdout.trim(), 10);
  };
  /** 取第 n 帧缩成 54×96 的 RGB */
  const frameRgb = (file: string, n: number): Promise<Buffer> => runBuffer(cfg.ffmpeg, ['-v', 'error', '-i', file, '-vf', `select=eq(n\\,${n}),scale=54:96`, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  const meanDiff = (a: Buffer, b: Buffer): number => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) / a.length;

  let firstHashes: string[] = [];

  beforeAll(async () => {
    mkdirSync(cacheDir, { recursive: true });
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=360x640:r=30:d=3', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(workDir, 'person.mp4')]);
  }, 60_000);

  it('首次：3 个镜头全部渲染；总帧数 = 时长×30、有音轨、1080×1920', async () => {
    const r = await renderSegmented({ workDir, cacheDir, props: BASE, output, ffmpeg: cfg.ffmpeg, onProgress: (d, t, u) => progress.push([d, t, u]) });
    expect(r).toMatchObject({ rendered: [0, 1, 2], reused: [] });
    expect(r.hashes).toHaveLength(3);
    firstHashes = r.hashes;
    expect(progress[progress.length - 1]).toEqual([3, 3, 0]);
    const info = await probe(output, cfg);
    expect([info.width, info.height, info.fps, info.hasAudio]).toEqual([1080, 1920, 30, true]);
    expect(await frames(output)).toBe(90);
    expect(Math.abs(info.durationSec - 3)).toBeLessThan(0.03);
    expect(readdirSync(cacheDir).filter((f) => f.endsWith('.mp4'))).toHaveLength(3);
  }, 300_000);

  it('拼接处不重复不丢帧：边界两侧的帧与整条一次渲染的结果一致', async () => {
    const full = join(workDir, 'full.mp4');
    await renderTalk({ workDir, output: full, props: BASE });
    for (const n of [0, 29, 30, 31, 59, 60, 89]) {
      expect(meanDiff(await frameRgb(output, n), await frameRgb(full, n)), `第 ${n} 帧`).toBeLessThan(0.3);
    }
  }, 300_000);

  it('改第 2 个镜头的卡片标题：只重渲 1，复用 0 与 2', async () => {
    const props = { ...BASE, shots: [SHOTS[0], { ...SHOTS[1], card: title('乙改') }, SHOTS[2]] };
    const r = await renderSegmented({ workDir, cacheDir, props, output, ffmpeg: cfg.ffmpeg });
    expect(r).toMatchObject({ rendered: [1], reused: [0, 2] });
    // 内容哈希：只有第 2 个镜头和上一次不同
    expect(r.hashes.map((h, i) => h === firstHashes[i])).toEqual([true, false, true]);
    expect(await frames(output)).toBe(90);
    expect((await probe(output, cfg)).hasAudio).toBe(true);
    expect(existsSync(join(workDir, 'audio.m4a'))).toBe(true);
  }, 300_000);

  it('原样再渲一次：全部复用', async () => {
    const props = { ...BASE, shots: [SHOTS[0], { ...SHOTS[1], card: title('乙改') }, SHOTS[2]] };
    const seen: [number, number, number][] = [];
    const r = await renderSegmented({ workDir, cacheDir, props, output, ffmpeg: cfg.ffmpeg, onProgress: (d, t, u) => seen.push([d, t, u]) });
    expect(r).toMatchObject({ rendered: [], reused: [0, 1, 2] });
    expect(seen[seen.length - 1]).toEqual([3, 3, 3]);
  }, 300_000);
});
