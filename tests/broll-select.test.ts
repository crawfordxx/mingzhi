import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuffer, run } from '../src/media/exec.js';
import type { LlmClient, ChatOptions } from '../src/llm/kexiang.js';
import type { Candidate } from '../src/broll/sources/types.js';
import type { Beat } from '../src/broll/plan.js';
import { dhash, hamming } from '../src/broll/dhash.js';
import { contactSheet } from '../src/broll/contact-sheet.js';
import { chooseUnique, EMPTY_PICKED, pickBest, rankPassing, scoreCandidates, SCORE_MODEL, totalOf, type CandidateScore } from '../src/broll/select.js';

const FFMPEG = process.env.MINGZHI_FFMPEG ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'mz-broll-select-'));
const p = (name: string): string => join(dir, name);

const lavfi = (name: string, src: string, extra: string[] = []): Promise<unknown> =>
  run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', ...extra, p(name)]);

const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, source: 'wikimedia', kind: 'photo', thumb: p(`${id}.png`), url: `https://example.com/${id}`, width: 1920, height: 1080,
  page: `https://example.com/p/${id}`, license: 'CC0', attributionRequired: false, aiGenerated: false, ...over,
});

/** 读 PNG 头里的宽高 */
function pngSize(file: string): { w: number; h: number } {
  const b = readFileSync(file);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

/** 取图中一块区域的 rgb24 原始字节 */
const region = (file: string, x: number, y: number, w: number, h: number): Promise<Buffer> =>
  runBuffer(FFMPEG, ['-v', 'error', '-i', file, '-vf', `crop=${w}:${h}:${x}:${y},format=rgb24`, '-frames:v', '1', '-f', 'rawvideo', '-']);
const near = (px: Buffer, rgb: [number, number, number], tol = 8): boolean => rgb.every((v, i) => Math.abs(px[i] - v) <= tol);

beforeAll(async () => {
  await lavfi('red.png', 'color=c=red:s=320x180');
  await lavfi('green.png', 'color=c=green:s=180x320');
  await lavfi('blue.png', 'color=c=blue:s=256x256');
  await lavfi('yellow.png', 'color=c=yellow:s=400x300');
  for (let i = 1; i <= 9; i += 1) await lavfi(`gray${i}.png`, 'color=c=0x336699:s=320x180');
  await lavfi('base.png', 'testsrc2=size=640x480');
  await run(FFMPEG, ['-v', 'error', '-y', '-i', p('base.png'), '-vf', 'scale=320:240', p('base-small.png')]);
  await run(FFMPEG, ['-v', 'error', '-y', '-i', p('base.png'), '-q:v', '25', p('base-lossy.jpg')]);
  await lavfi('other.png', 'mandelbrot=size=640x480');
  await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=2', '-pix_fmt', 'yuv420p', p('clip.mp4')]);
});

describe('dHash', () => {
  it('同图缩放与轻压缩后哈希接近，汉明距离小于 10', async () => {
    const base = await dhash(p('base.png'), FFMPEG);
    expect(hamming(base, await dhash(p('base-small.png'), FFMPEG))).toBeLessThan(10);
    expect(hamming(base, await dhash(p('base-lossy.jpg'), FFMPEG))).toBeLessThan(10);
  });

  it('不同图的汉明距离不小于 10', async () => {
    expect(hamming(await dhash(p('base.png'), FFMPEG), await dhash(p('other.png'), FFMPEG))).toBeGreaterThanOrEqual(10);
  });

  it('hamming 数 64 位里不同的位', () => {
    expect(hamming(0n, 0n)).toBe(0);
    expect(hamming(0b1011n, 0b0001n)).toBe(2);
    expect(hamming(0n, (1n << 64n) - 1n)).toBe(64);
  });

  it('文件读不出来时抛错', async () => {
    await expect(dhash(p('missing.png'), FFMPEG)).rejects.toThrow();
  });
});

describe('contactSheet', () => {
  it('4 个候选拼成 3 列 2 行：1536×1024', async () => {
    const out = p('sheet4.png');
    await contactSheet(['red', 'green', 'blue', 'yellow'].map((id) => cand(id)), out, FFMPEG);
    expect(pngSize(out)).toEqual({ w: 1536, h: 1024 });
  });

  it('9 个以上只取前 9 个：1536×1536，宽度不超过 1536', async () => {
    const out = p('sheet9.png');
    const many = Array.from({ length: 12 }, (_, i) => cand(`gray${(i % 9) + 1}`, { id: `g${i}`, thumb: p(`gray${(i % 9) + 1}.png`) }));
    await contactSheet(many, out, FFMPEG);
    expect(pngSize(out)).toEqual({ w: 1536, h: 1536 });
  });

  it('格内保持原比例：竖图左右是灰底，中心是原色', async () => {
    const out = p('sheet-letterbox.png');
    await contactSheet([cand('green'), cand('red')], out, FFMPEG);
    expect(near(await region(out, 10, 300, 1, 1), [128, 128, 128])).toBe(true);
    expect(near(await region(out, 256, 300, 1, 1), [0, 128, 0])).toBe(true);
    // 横图上下是灰底
    expect(near(await region(out, 512 + 256, 10, 1, 1), [128, 128, 128])).toBe(true);
    expect(near(await region(out, 512 + 256, 256, 1, 1), [255, 0, 0])).toBe(true);
  });

  it('每格右上角有序号角标，9 格的角标互不相同', async () => {
    const out = p('sheet-badges.png');
    await contactSheet(Array.from({ length: 9 }, (_, i) => cand(`gray${i + 1}`)), out, FFMPEG);
    const badges = await Promise.all(Array.from({ length: 9 }, (_, i) => region(out, (i % 3) * 512 + 420, Math.floor(i / 3) * 512 + 8, 84, 116)));
    expect(new Set(badges.map((b) => b.toString('base64'))).size).toBe(9);
    // 角标底色是亮黄，和格内蓝色画面区分开
    expect(near(badges[0].subarray(0, 3), [255, 214, 10])).toBe(true);
  });

  it('视频候选优先用来源给的预览图（远程预览图经 fetch 下载）', async () => {
    const out = p('sheet-remote.png');
    const bytes = readFileSync(p('red.png'));
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => { urls.push(String(url)); return new Response(bytes); }) as unknown as typeof fetch;
    await contactSheet([cand('v1', { kind: 'video', thumb: 'https://cdn.example.com/v1.jpg', url: 'https://cdn.example.com/v1.mp4' })], out, FFMPEG, { fetchImpl, stillsDir: p('stills-remote') });
    expect(urls).toEqual(['https://cdn.example.com/v1.jpg']);
    expect(near(await region(out, 256, 256, 1, 1), [255, 0, 0])).toBe(true);
  });

  it('视频没有预览图时抽中间帧', async () => {
    const out = p('sheet-video.png');
    await contactSheet([cand('v2', { kind: 'video', thumb: '', url: p('clip.mp4'), durationSec: 2 })], out, FFMPEG, { stillsDir: p('stills-video') });
    expect(pngSize(out).w).toBe(512);
    expect(existsSync(join(p('stills-video')))).toBe(true);
  });

  it('某一格的图取不到时留空白格，整张表照常生成', async () => {
    const out = p('sheet-fail.png');
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    await contactSheet([cand('red'), cand('bad', { thumb: 'https://cdn.example.com/404.jpg' })], out, FFMPEG, { fetchImpl, stillsDir: p('stills-fail') });
    expect(pngSize(out)).toEqual({ w: 1024, h: 512 });
  });

  it('没有候选时报错', async () => {
    await expect(contactSheet([], p('empty.png'), FFMPEG)).rejects.toThrow('没有候选');
  });
});

const beat: Beat = {
  start: 10, end: 13, role: 'illustrate', kind: 'footage', subject: '数据中心机房里成排的服务器', mustShow: ['服务器机柜', '走廊'], avoid: ['机器人', '全息'],
  queryEn: ['server room'], queryZh: ['机房'], present: 'broll-full', shotSize: 'WS', motion: 'push-in',
};
const row = (index: unknown, over: Record<string, unknown> = {}) => ({
  index, relevance: 8, aesthetic: 7, brand: 7, clean: 9, tech: 8, focal: { x: 0.4, y: 0.6 }, note: '不错', ...over,
});
function fakeClient(reply: unknown): { client: LlmClient; calls: ChatOptions[] } {
  const calls: ChatOptions[] = [];
  return { client: { chatJson: async (o) => { calls.push(o); return reply; } }, calls };
}

describe('scoreCandidates', () => {
  it('一次调用：提示词带 beat 的 subject、mustShow、avoid 和扣分规则，图片是联系表', async () => {
    const { client, calls } = fakeClient({ scores: [row(1), row(2)] });
    const result = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call.model).toBe(SCORE_MODEL);
    expect(call.images).toHaveLength(1);
    expect(call.images?.[0]).toMatch(/^data:image\/png;base64,/);
    const prompt = `${call.system}\n${call.user}`;
    for (const text of ['数据中心机房里成排的服务器', '服务器机柜', '走廊', '机器人', '全息']) expect(prompt).toContain(text);
    for (const text of ['水印', '文字', 'Logo', '可识别人脸', '地域']) expect(call.system).toContain(text);
    expect(result).toEqual([
      { index: 1, relevance: 8, aesthetic: 7, brand: 7, clean: 9, tech: 8, focal: { x: 0.4, y: 0.6 }, note: '不错' },
      { index: 2, relevance: 8, aesthetic: 7, brand: 7, clean: 9, tech: 8, focal: { x: 0.4, y: 0.6 }, note: '不错' },
    ]);
  });

  it('分数夹在 0-10、focal 夹在 0-1，数字字符串转成数字', async () => {
    const { client } = fakeClient({ scores: [row(1, { relevance: 12, aesthetic: -3, brand: '6.5', focal: { x: 1.8, y: -0.2 } })] });
    const [s] = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect([s.relevance, s.aesthetic, s.brand]).toEqual([10, 0, 6.5]);
    expect(s.focal).toEqual({ x: 1, y: 0 });
  });

  it('缺字段、不是数字、序号越界或重复的条目丢弃，结果按序号排列', async () => {
    const { client } = fakeClient({ scores: [
      row(3), row(1), row(2, { tech: undefined }), row(4, { clean: 'abc' }), row(0), row(5), row('x'), row(3, { relevance: 1 }),
    ] });
    const result = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect(result.map((s) => s.index)).toEqual([1, 3]);
    expect(result[1].relevance).toBe(8);
  });

  it('缺 focal 时取画面中心，缺 note 时为空串', async () => {
    const { client } = fakeClient({ scores: [row(1, { focal: undefined, note: undefined })] });
    const [s] = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect(s.focal).toEqual({ x: 0.5, y: 0.5 });
    expect(s.note).toBe('');
  });

  it('返回里没有 scores 数组时抛错', async () => {
    const { client } = fakeClient({ foo: 1 });
    await expect(scoreCandidates(client, beat, p('sheet4.png'), 4)).rejects.toThrow('scores');
  });
});

const sc = (index: number, over: Partial<CandidateScore> = {}): CandidateScore => ({
  index, relevance: 8, aesthetic: 7, brand: 7, clean: 8, tech: 8, focal: { x: 0.5, y: 0.5 }, note: '', ...over,
});

describe('pickBest', () => {
  it('取总分最高且过线的序号', () => {
    expect(pickBest([sc(1), sc(2, { aesthetic: 10 }), sc(3, { aesthetic: 9 })])).toBe(2);
  });

  it('相关度低于 7 的不选，即使总分最高', () => {
    expect(pickBest([sc(1, { relevance: 6, aesthetic: 10, brand: 10, clean: 10, tech: 10 }), sc(2)])).toBe(2);
  });

  it('总分低于 32 的不选，恰好 32 通过', () => {
    expect(totalOf(sc(1))).toBe(38);
    expect(pickBest([sc(1, { aesthetic: 2, brand: 2, clean: 8, tech: 8 })])).toBeNull(); // 28
    expect(pickBest([sc(1, { relevance: 7, aesthetic: 6, brand: 6, clean: 6, tech: 7 })])).toBe(1); // 32
  });

  it('阈值可传参，全部不过线返回 null', () => {
    expect(pickBest([sc(1)], 9)).toBeNull();
    expect(pickBest([sc(1)], 7, 40)).toBeNull();
    expect(pickBest([])).toBeNull();
  });

  it('总分相同取相关度高的，再相同取序号小的', () => {
    expect(pickBest([sc(1, { relevance: 7, aesthetic: 8 }), sc(2, { relevance: 8, aesthetic: 7 })])).toBe(2);
    expect(pickBest([sc(2), sc(1)])).toBe(1);
  });

  it('rankPassing 按好坏排出所有过线序号', () => {
    expect(rankPassing([sc(1), sc(2, { aesthetic: 10 }), sc(3, { relevance: 3 })])).toEqual([2, 1]);
  });
});

describe('chooseUnique', () => {
  const candidates = [cand('a'), cand('b'), cand('c')];
  const hashes: Record<string, bigint> = { a: 0n, b: 0b111n, c: (1n << 40n) - 1n }; // a-b 距离 3，a-c 距离 40
  const hashOf = async (c: Candidate): Promise<bigint> => hashes[c.id];
  const scores = [sc(1, { aesthetic: 10 }), sc(2, { aesthetic: 9 }), sc(3)];

  it('选出最高分的候选并记入状态', async () => {
    const r = await chooseUnique({ candidates, scores, state: EMPTY_PICKED, hashOf });
    expect(r.pick?.candidate.id).toBe('a');
    expect(r.state).toEqual({ usedIds: ['a'], hashes: [0n] });
    expect(EMPTY_PICKED).toEqual({ usedIds: [], hashes: [] }); // 不改入参
  });

  it('同一 Candidate.id 全片只用一次，选下一名', async () => {
    const state = { usedIds: ['a'], hashes: [((1n << 14n) - 1n) << 50n] };
    const r = await chooseUnique({ candidates, scores, state, hashOf });
    expect(r.pick?.candidate.id).toBe('b');
    expect(r.skipped).toEqual([{ id: 'a', reason: 'used' }]);
  });

  it('与已选素材汉明距离小于 10 视为重复，选下一名', async () => {
    const state = { usedIds: ['x'], hashes: [0n] };
    const r = await chooseUnique({ candidates, scores, state, hashOf });
    expect(r.pick?.candidate.id).toBe('c');
    expect(r.skipped.map((s) => s.reason)).toEqual(['duplicate', 'duplicate']);
  });

  it('距离恰好 10 不算重复', async () => {
    const r = await chooseUnique({ candidates: [cand('a')], scores: [sc(1)], state: { usedIds: [], hashes: [(1n << 10n) - 1n] }, hashOf: async () => 0n });
    expect(r.pick?.candidate.id).toBe('a');
  });

  it('没有可选时 pick 为 null、状态不变', async () => {
    const state = { usedIds: ['a', 'b', 'c'], hashes: [] };
    const r = await chooseUnique({ candidates, scores, state, hashOf });
    expect(r.pick).toBeNull();
    expect(r.state).toBe(state);
  });

  it('取不到哈希的候选跳过并标注原因', async () => {
    const r = await chooseUnique({ candidates, scores, state: EMPTY_PICKED, hashOf: async (c) => { if (c.id === 'a') throw new Error('下载失败'); return hashes[c.id]; } });
    expect(r.pick?.candidate.id).toBe('b');
    expect(r.skipped).toEqual([{ id: 'a', reason: 'unhashable' }]);
  });

  it('序号对不上候选的分数忽略', async () => {
    const r = await chooseUnique({ candidates: [cand('a')], scores: [sc(2, { aesthetic: 10 }), sc(1)], state: EMPTY_PICKED, hashOf });
    expect(r.pick?.candidate.id).toBe('a');
  });
});
