import { describe, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pexelsSource } from '../src/broll/sources/pexels.js';
import { pixabaySource } from '../src/broll/sources/pixabay.js';
import { wikimediaFetch, wikimediaSource, WIKIMEDIA_USER_AGENT } from '../src/broll/sources/wikimedia.js';
import type { SourceQuery } from '../src/broll/sources/types.js';

interface Call { url: URL; init?: RequestInit }
const jsonFetch = (body: unknown, calls: Call[]): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

const noSleep = async () => undefined;
const routed = (routes: Record<string, () => Response>, calls: Call[] = []): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.pathname.startsWith(k));
    return routes[key ?? '']();
  }) as typeof fetch;
const ok = (body: unknown) => () => new Response(JSON.stringify(body), { status: 200 });

const q = (over: Partial<SourceQuery> = {}): SourceQuery => ({ text: 'server room', orientation: 'portrait', kind: 'video', perPage: 5, ...over });

describe('pexelsSource', () => {
  const videoBody = {
    videos: [{
      id: 99, url: 'https://www.pexels.com/video/x-99/', duration: 12, image: 'https://img/p.jpg',
      user: { name: 'Ann', url: 'https://www.pexels.com/@ann' },
      video_files: [
        { quality: 'sd', file_type: 'video/mp4', width: 540, height: 960, fps: 25, link: 'https://v/sd.mp4' },
        { quality: 'hd', file_type: 'video/mp4', width: 1080, height: 1920, fps: 29.97, link: 'https://v/hd.mp4' },
        { quality: 'uhd', file_type: 'video/mp4', width: 2160, height: 3840, fps: 29.97, link: 'https://v/uhd.mp4' },
        { quality: 'hd', file_type: 'video/webm', width: 1080, height: 1920, fps: 30, link: 'https://v/hd.webm' },
      ],
      video_pictures: [{ picture: 'https://img/t1.jpg' }, { picture: 'https://img/t2.jpg' }],
    }],
  };

  it('视频：请求参数、Authorization 头；选 ≥1080 短边里最接近的 mp4，记录 fps、时长、缩略图与授权', async () => {
    const calls: Call[] = [];
    const out = await pexelsSource('KEY', { fetchImpl: jsonFetch(videoBody, calls) })(q());
    expect(calls).toHaveLength(1);
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://api.pexels.com/videos/search');
    expect(calls[0].url.searchParams.get('query')).toBe('server room');
    expect(calls[0].url.searchParams.get('orientation')).toBe('portrait');
    expect(calls[0].url.searchParams.get('per_page')).toBe('5');
    expect((calls[0].init?.headers as Record<string, string>).Authorization).toBe('KEY');
    expect(out).toEqual([{
      id: 'pexels:99', source: 'pexels', kind: 'video', thumb: 'https://img/t1.jpg', url: 'https://v/hd.mp4',
      width: 1080, height: 1920, durationSec: 12, fps: 29.97, page: 'https://www.pexels.com/video/x-99/', author: 'Ann', authorUrl: 'https://www.pexels.com/@ann',
      license: 'Pexels License', licenseUrl: 'https://www.pexels.com/license/', attributionRequired: false, aiGenerated: false,
    }]);
  });

  it('视频：没有 ≥1080 的文件时取最大的 mp4；没有 mp4 的条目丢弃', async () => {
    const calls: Call[] = [];
    const body = { videos: [
      { id: 1, url: 'p1', duration: 5, image: 'i', user: { name: 'A' }, video_files: [{ file_type: 'video/mp4', width: 360, height: 640, fps: 30, link: 'small' }, { file_type: 'video/mp4', width: 720, height: 1280, fps: 30, link: 'mid' }] },
      { id: 2, url: 'p2', duration: 5, image: 'i', user: { name: 'B' }, video_files: [{ file_type: 'video/webm', width: 1080, height: 1920, fps: 30, link: 'w' }] },
    ] };
    const out = await pexelsSource('K', { fetchImpl: jsonFetch(body, calls) })(q());
    expect(out.map((c) => [c.id, c.url])).toEqual([['pexels:1', 'mid']]);
  });

  it('图片：走 /v1/search，url 用 original 原图（宽高即原图真实尺寸），缩略图 medium，署名摄影师', async () => {
    const calls: Call[] = [];
    const body = { photos: [{ id: 7, width: 4000, height: 6000, url: 'https://www.pexels.com/photo/7/', photographer: 'Bob', photographer_url: 'https://www.pexels.com/@bob', src: { original: 'https://p/o.jpg', large2x: 'https://p/l.jpg', medium: 'https://p/m.jpg' } }] };
    const out = await pexelsSource('K', { fetchImpl: jsonFetch(body, calls) })(q({ kind: 'photo', orientation: 'square' }));
    expect(calls[0].url.pathname).toBe('/v1/search');
    expect(calls[0].url.searchParams.get('orientation')).toBe('square');
    expect(out[0]).toMatchObject({ id: 'pexels:7', kind: 'photo', thumb: 'https://p/m.jpg', url: 'https://p/o.jpg', width: 4000, height: 6000, author: 'Bob', authorUrl: 'https://www.pexels.com/@bob', license: 'Pexels License', aiGenerated: false });
  });

  it('kind=any 同时查视频和图片', async () => {
    const calls: Call[] = [];
    await pexelsSource('K', { fetchImpl: jsonFetch({ videos: [], photos: [] }, calls) })(q({ kind: 'any' }));
    expect(calls.map((c) => c.url.pathname).sort()).toEqual(['/v1/search', '/videos/search']);
  });

  it('HTTP 失败抛出带来源名和状态码的中文错误', async () => {
    const f = (async () => new Response('nope', { status: 500 })) as typeof fetch;
    await expect(pexelsSource('K', { fetchImpl: f })(q())).rejects.toThrow(/Pexels.*500/);
  });

  it('kind=any 一个接口失败时保留另一个的结果；全部失败才抛错', async () => {
    const bad = () => new Response('x', { status: 500 });
    const half = routed({ '/videos/search': ok(videoBody), '/v1/search': bad });
    const out = await pexelsSource('K', { fetchImpl: half })(q({ kind: 'any' }));
    expect(out.map((c) => c.id)).toEqual(['pexels:99']);
    const all = routed({ '/videos/search': bad, '/v1/search': bad });
    await expect(pexelsSource('K', { fetchImpl: all })(q({ kind: 'any' }))).rejects.toThrow(/Pexels/);
  });

  it('429 读 Retry-After 等待后重试 1 次；等待超过 10 秒不重试，提示限流', async () => {
    const sleeps: number[] = [];
    let n = 0;
    const flaky = (async () => (n++ === 0 ? new Response('slow', { status: 429, headers: { 'Retry-After': '2' } }) : new Response(JSON.stringify(videoBody)))) as typeof fetch;
    const out = await pexelsSource('K', { fetchImpl: flaky, sleep: async (ms) => { sleeps.push(ms); } })(q());
    expect(out).toHaveLength(1);
    expect(sleeps).toEqual([2000]);
    expect(n).toBe(2);

    let m = 0;
    const limited = (async () => { m++; return new Response('slow', { status: 429, headers: { 'Retry-After': '3600' } }); }) as typeof fetch;
    await expect(pexelsSource('K', { fetchImpl: limited, sleep: noSleep })(q())).rejects.toThrow(/Pexels.*限流.*3600/);
    expect(m).toBe(1);

    let k = 0;
    const always = (async () => { k++; return new Response('slow', { status: 429 }); }) as typeof fetch;
    await expect(pexelsSource('K', { fetchImpl: always, sleep: noSleep })(q())).rejects.toThrow(/Pexels.*限流/);
    expect(k).toBe(2);
  });

  it('网络失败、超时抛中文错误；外部取消原样透传', async () => {
    const netFail = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    await expect(pexelsSource('K', { fetchImpl: netFail })(q())).rejects.toThrow(/Pexels.*网络/);
    const timeout = (async () => { throw new DOMException('t', 'TimeoutError'); }) as typeof fetch;
    await expect(pexelsSource('K', { fetchImpl: timeout })(q())).rejects.toThrow(/Pexels.*超时/);
    const ctl = new AbortController();
    ctl.abort();
    const aborted = (async () => { throw new DOMException('aborted', 'AbortError'); }) as typeof fetch;
    await expect(pexelsSource('K', { fetchImpl: aborted })(q(), ctl.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('拿不到缩略图的视频丢弃，图片缩略图回退到原图', async () => {
    const body = { videos: [{ ...videoBody.videos[0], id: 5, image: undefined, video_pictures: [] }] };
    expect(await pexelsSource('K', { fetchImpl: jsonFetch(body, []) })(q())).toEqual([]);
    const photos = { photos: [{ id: 7, width: 4000, height: 6000, url: 'p', photographer: 'B', src: { original: 'https://p/o.jpg' } }] };
    const out = await pexelsSource('K', { fetchImpl: jsonFetch(photos, []) })(q({ kind: 'photo' }));
    expect(out[0].thumb).toBe('https://p/o.jpg');
  });
});

describe('pixabaySource', () => {
  const videoBody = { hits: [{
    id: 5, pageURL: 'https://pixabay.com/videos/x-5/', user: 'Cy', user_id: 77, duration: 9,
    videos: {
      large: { url: 'https://cdn/l.mp4', width: 1920, height: 1080, size: 5_000_000, thumbnail: 'https://cdn/lt.jpg' },
      medium: { url: 'https://cdn/m.mp4', width: 1280, height: 720, thumbnail: 'https://cdn/mt.jpg' },
      small: { url: '', width: 960, height: 540, thumbnail: '' },
    },
  }] };

  it('视频：请求参数、解析、授权', async () => {
    const calls: Call[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'mz-px-'));
    const out = await pixabaySource('PK', { dataDir: dir, fetchImpl: jsonFetch(videoBody, calls) })(q({ orientation: 'landscape' }));
    expect(calls[0].url.origin + calls[0].url.pathname).toBe('https://pixabay.com/api/videos/');
    expect(calls[0].url.searchParams.get('key')).toBe('PK');
    expect(calls[0].url.searchParams.get('q')).toBe('server room');
    expect(calls[0].url.searchParams.get('video_type')).toBe('film');
    expect(calls[0].url.searchParams.get('min_width')).toBe('1080');
    expect(calls[0].url.searchParams.get('per_page')).toBe('5');
    expect(out).toEqual([{
      id: 'pixabay:5', source: 'pixabay', kind: 'video', thumb: 'https://cdn/lt.jpg', url: 'https://cdn/l.mp4', width: 1920, height: 1080,
      durationSec: 9, sizeBytes: 5_000_000, page: 'https://pixabay.com/videos/x-5/', author: 'Cy', authorUrl: 'https://pixabay.com/users/Cy-77/', license: 'Pixabay Content License',
      licenseUrl: 'https://pixabay.com/service/license-summary/', attributionRequired: false, aiGenerated: false,
    }]);
  });

  it('视频：竖构图查询丢弃横向视频', async () => {
    const out = await pixabaySource('PK', { dataDir: mkdtempSync(join(tmpdir(), 'mz-px-')), fetchImpl: jsonFetch(videoBody, []) })(q({ orientation: 'portrait' }));
    expect(out).toEqual([]);
  });

  const photoHit = { id: 8, pageURL: 'https://pixabay.com/photos/8/', user: 'Di', user_id: 3, imageWidth: 3000, imageHeight: 4500, imageSize: 4_000_000, largeImageURL: 'https://cdn/L.jpg', webformatURL: 'https://cdn/w.jpg', previewURL: 'https://cdn/p.jpg' };
  const photoFrom = async (hit: object, calls: Call[] = []) =>
    pixabaySource('PK', { dataDir: mkdtempSync(join(tmpdir(), 'mz-px-')), fetchImpl: jsonFetch({ hits: [hit] }, calls) })(q({ kind: 'photo' }));

  it('图片：vertical 方向；只有 largeImageURL 时宽高按最长边 1280 缩放后的真实尺寸上报', async () => {
    const calls: Call[] = [];
    const out = await photoFrom(photoHit, calls);
    expect(calls[0].url.pathname).toBe('/api/');
    expect(calls[0].url.searchParams.get('image_type')).toBe('photo');
    expect(calls[0].url.searchParams.get('orientation')).toBe('vertical');
    expect(out[0]).toMatchObject({ id: 'pixabay:8', kind: 'photo', thumb: 'https://cdn/w.jpg', url: 'https://cdn/L.jpg', width: 853, height: 1280, author: 'Di', authorUrl: 'https://pixabay.com/users/Di-3/' });
    expect(out[0].sizeBytes).toBeUndefined();
  });

  it('图片：有 fullHDURL 按 1920 最长边，有 imageURL（原图权限）用原图真实尺寸与体积', async () => {
    const fullHd = await photoFrom({ ...photoHit, fullHDURL: 'https://cdn/fhd.jpg' });
    expect(fullHd[0]).toMatchObject({ url: 'https://cdn/fhd.jpg', width: 1280, height: 1920 });
    const original = await photoFrom({ ...photoHit, fullHDURL: 'https://cdn/fhd.jpg', imageURL: 'https://cdn/orig.jpg' });
    expect(original[0]).toMatchObject({ url: 'https://cdn/orig.jpg', width: 3000, height: 4500, sizeBytes: 4_000_000 });
  });

  it('图片：原图本身比 1280 小时不放大', async () => {
    const out = await photoFrom({ ...photoHit, imageWidth: 800, imageHeight: 600 });
    expect(out[0]).toMatchObject({ width: 800, height: 600 });
  });

  it('竖版视频查询多取几倍再本地过滤，结果截到 perPage', async () => {
    const calls: Call[] = [];
    const hit = (id: number, w: number, h: number) => ({ id, pageURL: `p${id}`, user: 'U', duration: 5, videos: { large: { url: `u${id}`, width: w, height: h, thumbnail: `t${id}` } } });
    const body = { hits: [hit(1, 1920, 1080), hit(2, 1080, 1920), hit(3, 1080, 1920), hit(4, 1080, 1920)] };
    const out = await pixabaySource('PK', { dataDir: mkdtempSync(join(tmpdir(), 'mz-px-')), fetchImpl: jsonFetch(body, calls) })(q({ perPage: 2 }));
    expect(calls[0].url.searchParams.get('per_page')).toBe('8');
    expect(out.map((c) => c.id)).toEqual(['pixabay:2', 'pixabay:3']);
  });

  it('缓存写盘失败不影响搜索结果；过期缓存文件被清理', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mz-px-'));
    const blocker = join(root, 'blocker');
    writeFileSync(blocker, 'x');
    const out = await pixabaySource('PK', { dataDir: blocker, fetchImpl: jsonFetch(videoBody, []) })(q({ orientation: 'landscape' }));
    expect(out).toHaveLength(1);

    const dir = mkdtempSync(join(tmpdir(), 'mz-px-'));
    const cacheDir = join(dir, 'cache', 'pixabay');
    await pixabaySource('PK', { dataDir: dir, fetchImpl: jsonFetch(videoBody, []) })(q({ orientation: 'landscape' }));
    const stale = join(cacheDir, 'stale.json');
    writeFileSync(stale, '{}');
    const old = new Date(Date.now() - 3 * 24 * 3600_000);
    utimesSync(stale, old, old);
    await pixabaySource('PK', { dataDir: dir, fetchImpl: jsonFetch(videoBody, []) })(q({ orientation: 'landscape', text: 'other' }));
    expect(existsSync(stale)).toBe(false);
  });

  it('结果缓存 24 小时：命中不再请求，缓存文件不含 key，过期后重新请求', async () => {
    const calls: Call[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'mz-px-'));
    let now = 1_000_000;
    const src = pixabaySource('SECRET-KEY', { dataDir: dir, fetchImpl: jsonFetch(videoBody, calls), now: () => now });
    const a = await src(q({ orientation: 'landscape' }));
    now += 23 * 3600_000;
    const b = await src(q({ orientation: 'landscape' }));
    expect(calls).toHaveLength(1);
    expect(b).toEqual(a);
    const cacheDir = join(dir, 'cache', 'pixabay');
    expect(existsSync(cacheDir)).toBe(true);
    const files = readdirSync(cacheDir);
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain('SECRET');
    now += 2 * 3600_000;
    await src(q({ orientation: 'landscape' }));
    expect(calls).toHaveLength(2);
  });

  it('HTTP 失败抛出带状态码的中文错误，且不写缓存', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-px-'));
    const f = (async () => new Response('bad', { status: 400 })) as typeof fetch;
    await expect(pixabaySource('PK', { dataDir: dir, fetchImpl: f })(q())).rejects.toThrow(/Pixabay.*400/);
    expect(existsSync(join(dir, 'cache', 'pixabay')) ? readdirSync(join(dir, 'cache', 'pixabay')) : []).toHaveLength(0);
  });
});

describe('wikimediaSource', () => {
  const page = (index: number, title: string, license: string, extra: Record<string, unknown> = {}, meta: Record<string, string> = {}) => ({
    pageid: index, index, title,
    imageinfo: [{
      size: 1234,
      url: `https://upload/${title}`, descriptionurl: `https://commons.wikimedia.org/wiki/${title}`, thumburl: `https://thumb/${title}`,
      width: 3000, height: 2000, mime: 'image/jpeg',
      extmetadata: { LicenseShortName: { value: license }, Artist: { value: '<a href="//x">Eve <b>Z</b></a>' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0' }, ...Object.fromEntries(Object.entries(meta).map(([k, v]) => [k, { value: v }])) },
      ...extra,
    }],
  });

  it('请求参数与 User-Agent；按许可过滤（排除 NC/ND/BY-SA/未知），CC BY 置 attributionRequired', async () => {
    const calls: Call[] = [];
    const body = { query: { pages: {
      1: page(1, 'File:A.jpg', 'CC BY 4.0'),
      2: page(2, 'File:B.jpg', 'CC0'),
      3: page(3, 'File:C.jpg', 'Public domain'),
      4: page(4, 'File:D.jpg', 'CC BY-SA 4.0'),
      5: page(5, 'File:E.jpg', 'CC BY-NC 2.0'),
      6: page(6, 'File:F.jpg', 'CC BY-ND 2.0'),
      7: page(7, 'File:G.jpg', 'GFDL'),
      9: page(9, 'File:I.jpg', ''),
      10: { pageid: 10, index: 10, title: 'File:J.jpg', imageinfo: [{ url: 'u', descriptionurl: 'd', width: 1, height: 1, mime: 'image/jpeg' }] },
      8: page(8, 'File:H.pdf', 'CC0', { mime: 'application/pdf' }),
    } } };
    const out = await wikimediaSource({ fetchImpl: jsonFetch(body, calls) })(q({ kind: 'photo', perPage: 8 }));
    const u = calls[0].url;
    expect(u.origin + u.pathname).toBe('https://commons.wikimedia.org/w/api.php');
    expect(u.searchParams.get('action')).toBe('query');
    expect(u.searchParams.get('generator')).toBe('search');
    expect(u.searchParams.get('gsrnamespace')).toBe('6');
    expect(u.searchParams.get('gsrsearch')).toBe('server room filetype:bitmap');
    expect(u.searchParams.get('gsrlimit')).toBe('8');
    expect(u.searchParams.get('prop')).toBe('imageinfo');
    expect(u.searchParams.get('iiprop')).toContain('extmetadata');
    expect(u.searchParams.get('iiprop')).toContain('url');
    expect((calls[0].init?.headers as Record<string, string>)['User-Agent']).toBe(WIKIMEDIA_USER_AGENT);
    expect(WIKIMEDIA_USER_AGENT).toContain('mingzhi');
    expect(WIKIMEDIA_USER_AGENT).toContain('https://github.com/crawfordxx/mingzhi');
    expect(out.map((c) => [c.id, c.license, c.attributionRequired])).toEqual([
      ['wikimedia:1', 'CC BY 4.0', true],
      ['wikimedia:2', 'CC0', false],
      ['wikimedia:3', 'Public domain', false],
    ]);
    expect(out[0]).toMatchObject({
      source: 'wikimedia', kind: 'photo', sizeBytes: 1234, thumb: 'https://thumb/File:A.jpg', url: 'https://upload/File:A.jpg', width: 3000, height: 2000,
      page: 'https://commons.wikimedia.org/wiki/File:A.jpg', author: 'Eve Z', licenseUrl: 'https://creativecommons.org/licenses/by/4.0', aiGenerated: false,
    });
  });

  it('视频：搜 filetype:video，记录时长，只收 video/* 文件', async () => {
    const calls: Call[] = [];
    const body = { query: { pages: {
      1: page(1, 'File:V.webm', 'CC BY 3.0', { mime: 'video/webm', duration: 14.5 }),
      2: page(2, 'File:I.jpg', 'CC0'),
    } } };
    const out = await wikimediaSource({ fetchImpl: jsonFetch(body, calls) })(q({ kind: 'video' }));
    expect(calls[0].url.searchParams.get('gsrsearch')).toBe('server room filetype:video');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'video', durationSec: 14.5 });
  });

  it('没有结果（无 query 字段）返回空数组；AttributionRequired 元数据为 true 时也置位', async () => {
    expect(await wikimediaSource({ fetchImpl: jsonFetch({ batchcomplete: '' }, []) })(q())).toEqual([]);
    const body = { query: { pages: { 1: page(1, 'File:P.jpg', 'Public domain', {}, { AttributionRequired: 'true' }) } } };
    const out = await wikimediaSource({ fetchImpl: jsonFetch(body, []) })(q({ kind: 'photo' }));
    expect(out[0].attributionRequired).toBe(true);
  });

  it('CC BY 缺作者（空或 Unknown）无法合规署名，排除；PD 缺作者照常保留；作者名解 HTML 实体', async () => {
    const body = { query: { pages: {
      1: page(1, 'File:A.jpg', 'CC BY 4.0', {}, { Artist: '' }),
      2: page(2, 'File:B.jpg', 'CC BY 4.0', {}, { Artist: '<span>Unknown</span>' }),
      3: page(3, 'File:C.jpg', 'CC0', {}, { Artist: '' }),
      4: page(4, 'File:D.jpg', 'CC BY 2.0', {}, { Artist: 'A&nbsp;&amp;&nbsp;B &#x4e2d;&lt;x&gt;' }),
    } } };
    const out = await wikimediaSource({ fetchImpl: jsonFetch(body, []) })(q({ kind: 'photo' }));
    expect(out.map((c) => [c.id, c.author])).toEqual([['wikimedia:3', undefined], ['wikimedia:4', 'A & B 中<x>']]);
  });

  it('wikimediaFetch 给下载请求加 User-Agent 并保留原有头', async () => {
    const calls: Call[] = [];
    await wikimediaFetch(jsonFetch({}, calls))('https://upload.wikimedia.org/x.jpg', { headers: { Range: 'bytes=0-9' } });
    expect(calls[0].init?.headers).toEqual({ Range: 'bytes=0-9', 'User-Agent': WIKIMEDIA_USER_AGENT });
  });

  it('HTTP 失败抛出中文错误；kind=any 一个种类失败时保留另一个', async () => {
    const f = (async () => new Response('x', { status: 503 })) as typeof fetch;
    await expect(wikimediaSource({ fetchImpl: f })(q())).rejects.toThrow(/Wikimedia.*503/);
    let n = 0;
    const half = (async () => (n++ === 0 ? new Response('x', { status: 503 }) : new Response(JSON.stringify({ query: { pages: { 1: page(1, 'File:I.jpg', 'CC0') } } })))) as typeof fetch;
    const out = await wikimediaSource({ fetchImpl: half })(q({ kind: 'any' }));
    expect(out).toHaveLength(1);
  });
});
