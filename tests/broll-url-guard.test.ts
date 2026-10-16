// 外部来源返回的网址只收公网 http(s)：候选、预览图、下载、ffmpeg 输入、Pexels 卡片兜底与任务下载都校验
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { gatherCandidates } from '../src/broll/gather.js';
import { BeatSchema } from '../src/broll/plan.js';
import { searchPexels } from '../src/broll/generate-media.js';
import { downloadImage, stillOf, THUMB_MAX_BYTES } from '../src/broll/still-fetch.js';
import { guardCandidate } from '../src/broll/sources/url-guard.js';
import { downloadTo } from '../src/llm/kexiang-task.js';
import { cand, wiki } from './helpers/broll-fakes.js';

const dir = (): string => mkdtempSync(join(tmpdir(), 'mz-url-'));
const neverFetch = (async () => { throw new Error('不应发请求'); }) as unknown as typeof fetch;
const BAD = ['file:///etc/passwd', 'javascript:alert(1)', 'data:image/png;base64,AAAA', '/Users/me/secret.jpg', 'http://127.0.0.1:8080/x.jpg', 'http://localhost/x.jpg', 'ftp://example.com/x.jpg'];

describe('guardCandidate', () => {
  it('原文件、作品页、预览图任一不是公网 http(s)：整个候选丢掉', () => {
    for (const bad of BAD) {
      expect(guardCandidate(cand('a', { url: bad })), bad).toBeUndefined();
      expect(guardCandidate(cand('a', { page: bad })), bad).toBeUndefined();
      expect(guardCandidate(cand('a', { thumb: bad })), bad).toBeUndefined();
    }
  });
  it('作者主页、许可链接不合格只去掉该字段；合格的候选原样保留', () => {
    const c = guardCandidate(cand('a', { authorUrl: 'javascript:alert(1)', licenseUrl: 'data:text/html,x' }));
    expect(c).toBeDefined();
    expect(c?.authorUrl).toBeUndefined();
    expect(c?.licenseUrl).toBeUndefined();
    const good = cand('b', { authorUrl: 'https://example.com/@b', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' });
    expect(guardCandidate(good)).toEqual(good);
    // 没有预览图（视频抽帧）不算不合格
    expect(guardCandidate(cand('c', { thumb: '' }))).toBeDefined();
  });
  it('截图、生成图是本机产物：本地路径放行', () => {
    const local = cand('s', { source: 'screenshot', url: '/tmp/work/broll/s.png', thumb: '/tmp/work/broll/s.png', page: 'https://news.example.com/a' });
    expect(guardCandidate(local)).toEqual(local);
  });
});

describe('检索结果过一遍网址校验', () => {
  it('来源给出的坏候选被丢掉，计数只算合格的', async () => {
    const beat = BeatSchema.parse({ start: 10, end: 13, role: 'illustrate', kind: 'photo', subject: '城市夜景', mustShow: [], avoid: [], queryEn: ['city night'], queryZh: ['城市 夜景'], present: 'split', shotSize: 'WS', motion: 'static' });
    const items = () => [cand('ok', { width: 3840, height: 2160 }), cand('bad', { thumb: 'file:///etc/passwd', width: 3840, height: 2160 })];
    const g = await gatherCandidates(beat, [wiki(items)], []);
    expect(g.candidates.map((c) => c.id)).toEqual(['wikimedia:ok']);
  });
});

describe('预览图、下载与 ffmpeg 输入', () => {
  it('图库候选的预览图是本机路径：拒绝，不读这个文件', async () => {
    const d = dir();
    const secret = join(d, 'secret.jpg');
    writeFileSync(secret, 'x');
    await expect(stillOf(cand('a', { thumb: secret }), join(d, 'stills'), 'ffmpeg', neverFetch)).rejects.toThrow(/公网 http\(s\)/);
  });
  it('视频候选的地址是 file: 或本机路径：拒绝，不交给 ffmpeg', async () => {
    const d = dir();
    for (const url of ['file:///etc/passwd', '/etc/passwd', 'concat:/etc/passwd']) {
      await expect(stillOf(cand('v', { kind: 'video', thumb: '', url, durationSec: 4 }), join(d, 'stills'), '/nonexistent/ffmpeg', neverFetch)).rejects.toThrow(/公网 http\(s\)/);
    }
  });
  it('downloadImage 与 downloadTo 只收 http(s)', async () => {
    const d = dir();
    for (const bad of ['file:///etc/passwd', 'data:image/png;base64,AAAA', 'javascript:1']) {
      await expect(downloadImage(bad, join(d, 'a.jpg'), neverFetch, THUMB_MAX_BYTES)).rejects.toThrow(/已拒绝/);
      await expect(downloadTo(bad, join(d, 'b.jpg'), neverFetch)).rejects.toThrow(/已拒绝/);
    }
    expect(existsSync(join(d, 'a.jpg'))).toBe(false);
  });
  it('Pexels 卡片兜底：图片地址不合格当没有结果；作品页、主页不合格不记', async () => {
    const reply = (photo: Record<string, unknown>): typeof fetch => (async (url: string) => {
      if (String(url).startsWith('https://api.pexels.com/')) return new Response(JSON.stringify({ photos: [photo] }), { headers: { 'content-type': 'application/json' } });
      return new Response('jpg', { headers: { 'content-type': 'image/jpeg' } });
    }) as unknown as typeof fetch;
    const d = dir();
    expect(await searchPexels('k', 'q', join(d, 'a.jpg'), { fetchImpl: reply({ src: { large2x: 'file:///etc/passwd' } }) })).toBe(false);
    const hit = await searchPexels('k', 'q', join(d, 'b.jpg'), { fetchImpl: reply({ src: { large2x: 'https://images.pexels.com/1.jpg' }, url: 'javascript:1', photographer: 'Ann', photographer_url: 'data:text/html,x' }) });
    expect(hit).toEqual({ page: 'https://www.pexels.com', author: 'Ann' });
  });
});
