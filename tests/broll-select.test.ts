import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runBuffer, run } from '../src/media/exec.js';
import type { LlmClient, ChatOptions } from '../src/llm/kexiang.js';
import type { Candidate } from '../src/broll/sources/types.js';
import type { Beat } from '../src/broll/plan.js';
import { dedupHash, dhash, hamming } from '../src/broll/dhash.js';
import { buildContactSheet, contactSheet } from '../src/broll/contact-sheet.js';
import { downloadImage, THUMB_MAX_BYTES } from '../src/broll/still-fetch.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import { CancelledError } from '../src/cancel.js';
import { chooseUnique, EMPTY_PICKED, locateFocal, MIN_QUALITY, MIN_RELEVANCE, pickBest, rankPassing, scoreCandidates, SCORE_MODEL, totalOf, type CandidateScore } from '../src/broll/select.js';

const FFMPEG = process.env.MINGZHI_FFMPEG ?? 'ffmpeg';
const dir = mkdtempSync(join(tmpdir(), 'mz-broll-select-'));
const p = (name: string): string => join(dir, name);

const lavfi = (name: string, src: string, extra: string[] = []): Promise<unknown> =>
  run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', src, '-frames:v', '1', ...extra, p(name)]);

// 预览图是本机文件：只有本地候选（截图、生成图）允许，图库候选的预览图必须是公网 http(s)
const cand = (id: string, over: Partial<Candidate> = {}): Candidate => ({
  id, source: 'generated', kind: 'photo', thumb: p(`${id}.png`), url: `https://example.com/${id}`, width: 1920, height: 1080,
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

  it('确定图的精确哈希位：左亮右暗得 0x1818…，反过来得 0，渐变方向决定全 1 或全 0', async () => {
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x480,format=gray,geq=lum=if(lt(X\\,320)\\,255\\,0)', '-frames:v', '1', p('half-lr.png')]);
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x480,format=gray,geq=lum=if(lt(X\\,320)\\,0\\,255)', '-frames:v', '1', p('half-rl.png')]);
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x480,format=gray,geq=lum=255*(1-X/W)', '-frames:v', '1', p('grad-dec.png')]);
    await run(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=black:s=640x480,format=gray,geq=lum=255*X/W', '-frames:v', '1', p('grad-inc.png')]);
    expect(await dhash(p('half-lr.png'), FFMPEG)).toBe(0x1818181818181818n);
    expect(await dhash(p('half-rl.png'), FFMPEG)).toBe(0n);
    expect(await dhash(p('grad-dec.png'), FFMPEG)).toBe((1n << 64n) - 1n);
    expect(await dhash(p('grad-inc.png'), FFMPEG)).toBe(0n);
  });

  it('水平翻转后哈希明显不同', async () => {
    await run(FFMPEG, ['-v', 'error', '-y', '-i', p('base.png'), '-vf', 'hflip', p('base-flip.png')]);
    expect(hamming(await dhash(p('base.png'), FFMPEG), await dhash(p('base-flip.png'), FFMPEG))).toBeGreaterThan(20);
  });

  it('纯色与低方差画面的去重哈希为 null，有细节的画面不是', async () => {
    expect(await dedupHash(p('red.png'), FFMPEG)).toBeNull();
    await lavfi('black.png', 'color=c=black:s=320x180');
    expect(await dedupHash(p('black.png'), FFMPEG)).toBeNull();
    expect(await dedupHash(p('base.png'), FFMPEG)).not.toBeNull();
    expect(await dedupHash(p('grad-dec.png'), FFMPEG)).toBe((1n << 64n) - 1n);
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
    const fetchImpl = (async (url: string) => { urls.push(String(url)); return new Response(bytes, { headers: { 'content-type': 'image/png' } }); }) as unknown as typeof fetch;
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

  it('某一格的图取不到时标成深红底的「空」格，blanks 给出序号与原因，其他格不受影响', async () => {
    const out = p('sheet-fail.png');
    const fetchImpl = (async () => new Response('', { status: 404 })) as unknown as typeof fetch;
    const result = await buildContactSheet([cand('red'), cand('bad', { thumb: 'https://cdn.example.com/404.jpg' })], out, FFMPEG, { fetchImpl, stillsDir: p('stills-fail') });
    expect(pngSize(out)).toEqual({ w: 1024, h: 512 });
    expect(result.count).toBe(2);
    expect(result.blanks).toHaveLength(1);
    expect(result.blanks[0]).toMatchObject({ index: 2, id: 'bad' });
    expect(result.blanks[0].reason).toContain('404');
    expect(near(await region(out, 512 + 20, 500, 1, 1), [0x5a, 0x1e, 0x1e])).toBe(true); // 空格底色
    expect(near(await region(out, 512 + 256, 200, 1, 1), [255, 255, 255])).toBe(true); // 「空」字笔画
    expect(near(await region(out, 256, 256, 1, 1), [255, 0, 0])).toBe(true); // 第 1 格正常
  });

  it('所有候选都取不到画面时报错', async () => {
    const fetchImpl = (async () => new Response('', { status: 500 })) as unknown as typeof fetch;
    await expect(contactSheet([cand('b1', { thumb: 'https://cdn.example.com/1.jpg' })], p('all-bad.png'), FFMPEG, { fetchImpl, stillsDir: p('stills-all-bad') })).rejects.toThrow('取不到');
  });

  it('没有候选时报错', async () => {
    await expect(contactSheet([], p('empty.png'), FFMPEG)).rejects.toThrow('没有候选');
  });
});

describe('downloadImage', () => {
  const png = (): Buffer => readFileSync(p('red.png'));
  const reply = (body: BodyInit | null, headers: Record<string, string>): typeof fetch => (async () => new Response(body, { headers })) as unknown as typeof fetch;

  it('图片类型且不超限时落盘', async () => {
    const dest = p('dl-ok.jpg');
    await downloadImage('https://x/ok.png', dest, reply(png(), { 'content-type': 'image/png' }), THUMB_MAX_BYTES);
    expect(readFileSync(dest).equals(png())).toBe(true);
  });

  it('响应体累计超过上限时中止，不落盘', async () => {
    const dest = p('dl-big.jpg');
    const big = Buffer.alloc(2048);
    await expect(downloadImage('https://x/big.png', dest, reply(big, { 'content-type': 'image/jpeg' }), 1024)).rejects.toThrow('上限');
    expect(existsSync(dest)).toBe(false);
  });

  it('Content-Length 声明超限时不读响应体就拒绝', async () => {
    await expect(downloadImage('https://x/big.png', p('dl-big2.jpg'), reply(png(), { 'content-type': 'image/png', 'content-length': String(THUMB_MAX_BYTES + 1) }), THUMB_MAX_BYTES)).rejects.toThrow('上限');
  });

  it('Content-Type 不是 image/* 的错误页被拒，不留缓存，下次重试能成功', async () => {
    const dir2 = p('stills-html');
    const html = reply('<html>blocked</html>', { 'content-type': 'text/html' });
    const c = cand('html', { thumb: 'https://cdn.example.com/html.jpg' });
    await expect(contactSheet([c, cand('red')], p('sheet-html.png'), FFMPEG, { fetchImpl: html, stillsDir: dir2 })).resolves.toBeTruthy();
    const ok = reply(png(), { 'content-type': 'image/jpeg' });
    const r = await buildContactSheet([c, cand('red')], p('sheet-html2.png'), FFMPEG, { fetchImpl: ok, stillsDir: dir2 });
    expect(r.blanks).toEqual([]);
  });

  it('缺 Content-Type 同样拒绝，非 2xx 拒绝', async () => {
    await expect(downloadImage('https://x/a', p('dl-a.jpg'), reply(png(), {}), THUMB_MAX_BYTES)).rejects.toThrow('不是图片');
    await expect(downloadImage('https://x/a', p('dl-b.jpg'), (async () => new Response('', { status: 403 })) as unknown as typeof fetch, THUMB_MAX_BYTES)).rejects.toThrow('403');
  });

  it('Wikimedia 候选的下载带 User-Agent', async () => {
    const seen: (string | undefined)[] = [];
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers as Record<string, string> | undefined)?.['User-Agent']);
      return new Response(png(), { headers: { 'content-type': 'image/png' } });
    }) as unknown as typeof fetch;
    await buildContactSheet([cand('w1', { source: 'wikimedia', thumb: 'https://upload.wikimedia.org/a.jpg' })], p('sheet-ua.png'), FFMPEG, { fetchImpl, stillsDir: p('stills-ua') });
    expect(seen[0]).toMatch(/^mingzhi\//);
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
    for (const text of ['水印', '文字', 'Logo', '可识别人脸', '地域', '空']) expect(call.system).toContain(text);
    expect(call.system).not.toContain('"focal"'); // 打分不再询问主体位置
    expect(result).toEqual([
      { index: 1, relevance: 8, aesthetic: 7, brand: 7, clean: 9, tech: 8, focal: { x: 0.5, y: 0.5 }, note: '不错' },
      { index: 2, relevance: 8, aesthetic: 7, brand: 7, clean: 9, tech: 8, focal: { x: 0.5, y: 0.5 }, note: '不错' },
    ]);
  });

  it('分数夹在 0-10，数字字符串转成数字', async () => {
    const { client } = fakeClient({ scores: [row(1, { relevance: 12, aesthetic: -3, brand: '6.5' })] });
    const [s] = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect([s.relevance, s.aesthetic, s.brand]).toEqual([10, 0, 6.5]);
  });

  it('缺字段、不是数字、序号越界或重复的条目丢弃，结果按序号排列', async () => {
    const { client } = fakeClient({ scores: [
      row(3), row(1), row(2, { tech: undefined }), row(4, { clean: 'abc' }), row(0), row(5), row('x'), row(3, { relevance: 1 }),
    ] });
    const result = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect(result.map((s) => s.index)).toEqual([1, 3]);
    expect(result[1].relevance).toBe(8);
  });

  it('缺 note 时为空串', async () => {
    const { client } = fakeClient({ scores: [row(1, { note: undefined })] });
    const [s] = await scoreCandidates(client, beat, p('sheet4.png'), 4);
    expect(s.note).toBe('');
  });

  it('整批打分全部无效（缺字段、序号全越界）或为空时抛明确错误，不当成低分', async () => {
    await expect(scoreCandidates(fakeClient({ scores: [row(7), row(2, { tech: undefined })] }).client, beat, p('sheet4.png'), 4)).rejects.toThrow('全部无效');
    await expect(scoreCandidates(fakeClient({ scores: [] }).client, beat, p('sheet4.png'), 4)).rejects.toThrow('全部无效');
  });

  it('联系表上取图失败的空格，模型给的分不采纳', async () => {
    const { client } = fakeClient({ scores: [row(1), row(2), row(3)] });
    const result = await scoreCandidates(client, beat, p('sheet4.png'), 4, [2]);
    expect(result.map((s) => s.index)).toEqual([1, 3]);
  });

  it('n 超过 9 时按 9 处理，序号 10 以上丢弃', async () => {
    const { client, calls } = fakeClient({ scores: [row(9), row(10), row(12)] });
    const result = await scoreCandidates(client, beat, p('sheet4.png'), 12);
    expect(result.map((s) => s.index)).toEqual([9]);
    expect(calls[0].user).toContain('共 9 格');
  });

  it('返回里没有 scores 数组时抛错', async () => {
    const { client } = fakeClient({ foo: 1 });
    await expect(scoreCandidates(client, beat, p('sheet4.png'), 4)).rejects.toThrow('scores');
  });
});

const sc = (index: number, over: Partial<CandidateScore> = {}): CandidateScore => ({
  index, relevance: 8, aesthetic: 9, brand: 7, clean: 8, tech: 8, focal: { x: 0.5, y: 0.5 }, note: '', ...over,
});

describe('pickBest', () => {
  it('默认阈值：相关度 7（生成图视为 9 分，差 ≤ 2 分优先真实），美感、干净、技术不低于 5；不再按总分一刀切', () => {
    expect(MIN_RELEVANCE).toBe(7);
    expect(MIN_QUALITY).toBe(5);
    expect(totalOf(sc(1))).toBe(40);
  });

  it('取总分最高且过线的序号', () => {
    expect(pickBest([sc(1), sc(2, { aesthetic: 10 }), sc(3, { aesthetic: 9 })])).toBe(2);
  });

  it('相关度低于 7 的不选，即使总分最高', () => {
    expect(pickBest([sc(1, { relevance: 6, aesthetic: 10, brand: 10, clean: 10, tech: 10 }), sc(2)])).toBe(2);
  });

  it('总分不设下限，硬伤（美感、干净、技术 < 5）才不选；影调不设下限', () => {
    expect(pickBest([sc(1, { relevance: 7, aesthetic: 5, brand: 0, clean: 5, tech: 5 })])).toBe(1); // 总分 22
    expect(pickBest([sc(1, { clean: 4.9 })])).toBeNull();
  });

  it('阈值可传参，全部不过线返回 null', () => {
    expect(pickBest([sc(1)], 9)).toBeNull();
    expect(pickBest([])).toBeNull();
  });

  it('总分相同取相关度高的，再相同取序号小的', () => {
    expect(pickBest([sc(1, { relevance: 7, aesthetic: 10 }), sc(2, { relevance: 8, aesthetic: 9 })])).toBe(2);
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
    expect(r.skipped).toEqual([{ id: 'a', reason: 'unhashable', detail: '下载失败' }]);
  });

  it('低方差画面（哈希为 null）不判重复，也不记入已选哈希', async () => {
    const state = { usedIds: ['x'], hashes: [0n] };
    const r = await chooseUnique({ candidates: [cand('a')], scores: [sc(1)], state, hashOf: async () => null });
    expect(r.pick?.candidate.id).toBe('a');
    expect(r.state).toEqual({ usedIds: ['x', 'a'], hashes: [0n] });
  });

  it('序号对不上候选的分数忽略', async () => {
    const r = await chooseUnique({ candidates: [cand('a')], scores: [sc(2, { aesthetic: 10 }), sc(1)], state: EMPTY_PICKED, hashOf });
    expect(r.pick?.candidate.id).toBe('a');
  });
});

describe('locateFocal', () => {
  it('对单张图再调一次：返回主体中心与包围框，提示词要求 0-1 坐标', async () => {
    const { client, calls } = fakeClient({ focal: { x: 0.3, y: 0.6 }, box: { x: 0.1, y: 0.4, w: 0.4, h: 0.5 } });
    const r = await locateFocal(client, p('red.png'));
    expect(r).toEqual({ focal: { x: 0.3, y: 0.6 }, box: { x: 0.1, y: 0.4, w: 0.4, h: 0.5 } });
    expect(calls).toHaveLength(1);
    expect(calls[0].images?.[0]).toMatch(/^data:image\/png;base64,/);
    expect(calls[0].system).toContain('0-1');
  });

  it('坐标夹在 0-1，包围框不超出画面', async () => {
    const { client } = fakeClient({ focal: { x: 1.4, y: -1 }, box: { x: 0.7, y: 0.2, w: 0.9, h: 0.3 } });
    expect(await locateFocal(client, p('red.png'))).toEqual({ focal: { x: 1, y: 0 }, box: { x: 0.7, y: 0.2, w: expect.closeTo(0.3, 6), h: 0.3 } });
  });

  it('只给包围框时中心取框中心；框没有面积则丢弃', async () => {
    const a = await locateFocal(fakeClient({ box: { x: 0.2, y: 0.2, w: 0.4, h: 0.4 } }).client, p('red.png'));
    expect(a.focal.x).toBeCloseTo(0.4, 6);
    expect(a.focal.y).toBeCloseTo(0.4, 6);
    const b = await locateFocal(fakeClient({ focal: { x: 0.2, y: 0.8 }, box: { x: 1, y: 0.2, w: 0.3, h: 0.3 } }).client, p('red.png'));
    expect(b).toEqual({ focal: { x: 0.2, y: 0.8 } });
  });

  it('返回格式不对、模型报错、图读不出时回退画面中心', async () => {
    const center = { focal: { x: 0.5, y: 0.5 } };
    expect(await locateFocal(fakeClient({ foo: 1 }).client, p('red.png'))).toEqual(center);
    expect(await locateFocal(fakeClient('乱码').client, p('red.png'))).toEqual(center);
    const boom: LlmClient = { chatJson: async () => { throw new Error('网络错误'); } };
    expect(await locateFocal(boom, p('red.png'))).toEqual(center);
    expect(await locateFocal(fakeClient({}).client, p('missing.png'))).toEqual(center);
  });

  it('余额不足照常抛出，不当成普通失败吞掉', async () => {
    const broke: LlmClient = { chatJson: async () => { throw new InsufficientBalanceError(); } };
    await expect(locateFocal(broke, p('red.png'))).rejects.toBeInstanceOf(InsufficientBalanceError);
  });

  it('取消照常抛出，不回退画面中心', async () => {
    const stopped: LlmClient = { chatJson: async () => { throw new CancelledError(); } };
    await expect(locateFocal(stopped, p('red.png'))).rejects.toBeInstanceOf(CancelledError);
  });
});
