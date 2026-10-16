import { describe, expect, it } from 'vitest';
import { freeSources } from '../src/broll/deps.js';
import { openverseSource } from '../src/broll/sources/openverse.js';
import { WIKIMEDIA_USER_AGENT } from '../src/broll/sources/wikimedia.js';
import type { SourceQuery } from '../src/broll/sources/types.js';

interface Call { url: URL; init?: RequestInit }
const jsonFetch = (body: unknown, calls: Call[]): typeof fetch =>
  (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: new URL(String(input)), init });
    return new Response(JSON.stringify(body), { status: 200 });
  }) as typeof fetch;

const q = (over: Partial<SourceQuery> = {}): SourceQuery => ({ text: 'contract signing', orientation: 'landscape', kind: 'photo', perPage: 6, ...over });

const item = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: `标题${id}`, url: `https://img.example/${id}.jpg`, thumbnail: `https://api.openverse.org/v1/images/${id}/thumb/`,
  foreign_landing_url: `https://www.flickr.com/photos/x/${id}`, creator: '作者A', creator_url: 'https://www.flickr.com/photos/x',
  license: 'by', license_version: '2.0', license_url: 'https://creativecommons.org/licenses/by/2.0/',
  width: 1024, height: 683, mature: false, ...over,
});

describe('openverseSource', () => {
  it('请求参数：许可白名单、排除成人内容与 Wikimedia（另有来源）、方向、不带任何 key，带项目 User-Agent', async () => {
    const calls: Call[] = [];
    await openverseSource({ fetchImpl: jsonFetch({ results: [] }, calls) })(q({ orientation: 'portrait', perPage: 8 }));
    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url.origin + url.pathname).toBe('https://api.openverse.org/v1/images/');
    expect(url.searchParams.get('q')).toBe('contract signing');
    expect(url.searchParams.get('license')).toBe('cc0,pdm,by');
    expect(url.searchParams.get('mature')).toBe('false');
    expect(url.searchParams.get('aspect_ratio')).toBe('tall');
    expect(url.searchParams.get('page_size')).toBe('8');
    expect(url.searchParams.get('size')).toBe('medium,large');
    expect(url.searchParams.get('excluded_source')).toBe('wikimedia');
    const headers = init?.headers as Record<string, string>;
    expect(headers['User-Agent']).toBe(WIKIMEDIA_USER_AGENT);
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('authorization');
  });

  it('方向映射：landscape→wide，square→square；page_size 不超过匿名上限 20', async () => {
    const calls: Call[] = [];
    const f = jsonFetch({ results: [] }, calls);
    await openverseSource({ fetchImpl: f })(q({ orientation: 'landscape', perPage: 50 }));
    await openverseSource({ fetchImpl: f })(q({ orientation: 'square' }));
    expect(calls.map((c) => c.url.searchParams.get('aspect_ratio'))).toEqual(['wide', 'square']);
    expect(calls[0].url.searchParams.get('page_size')).toBe('20');
  });

  it('只有照片：kind=video 不发请求，kind=any 按照片检索', async () => {
    const calls: Call[] = [];
    const f = jsonFetch({ results: [] }, calls);
    expect(await openverseSource({ fetchImpl: f })(q({ kind: 'video' }))).toEqual([]);
    expect(calls).toHaveLength(0);
    await openverseSource({ fetchImpl: f })(q({ kind: 'any' }));
    expect(calls).toHaveLength(1);
  });

  it('解析：真实宽高、缩略图、原图、作品页、作者、许可与署名要求', async () => {
    const body = { results: [
      item('a'),
      item('b', { license: 'cc0', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/zero/1.0/', creator: null, creator_url: null }),
      item('c', { license: 'pdm', license_version: '1.0', license_url: 'https://creativecommons.org/publicdomain/mark/1.0/' }),
    ] };
    const out = await openverseSource({ fetchImpl: jsonFetch(body, []) })(q());
    expect(out[0]).toEqual({
      id: 'openverse:a', source: 'openverse', kind: 'photo', thumb: 'https://api.openverse.org/v1/images/a/thumb/', url: 'https://img.example/a.jpg',
      width: 1024, height: 683, page: 'https://www.flickr.com/photos/x/a', author: '作者A', authorUrl: 'https://www.flickr.com/photos/x',
      license: 'CC BY 2.0', licenseUrl: 'https://creativecommons.org/licenses/by/2.0/', attributionRequired: true, aiGenerated: false,
    });
    expect(out.map((c) => [c.id, c.license, c.attributionRequired])).toEqual([
      ['openverse:a', 'CC BY 2.0', true], ['openverse:b', 'CC0 1.0', false], ['openverse:c', 'Public domain', false],
    ]);
    expect(out[1].author).toBeUndefined();
  });

  it('许可过滤：BY-SA、NC、ND、未知许可、成人内容、缺版本号的 CC BY 一律排除（即使服务端漏过滤）', async () => {
    const body = { results: [
      item('sa', { license: 'by-sa' }), item('nc', { license: 'by-nc' }), item('nd', { license: 'by-nd' }), item('ncnd', { license: 'by-nc-nd' }),
      item('ncsa', { license: 'by-nc-sa' }), item('samp', { license: 'sampling+' }), item('x', { license: 'weird' }),
      item('mature', { mature: true }), item('nover', { license_version: null }),
      item('ok'),
    ] };
    const out = await openverseSource({ fetchImpl: jsonFetch(body, []) })(q());
    expect(out.map((c) => c.id)).toEqual(['openverse:ok']);
  });

  it('CC BY 没有作者则丢弃（无法合规署名）；缺宽高、缺原图、缺作品页的丢弃', async () => {
    const body = { results: [
      item('noauthor', { creator: null }), item('blank', { creator: '  ' }),
      item('nowidth', { width: null }), item('nourl', { url: '' }), item('nopage', { foreign_landing_url: null }),
      item('ok'),
    ] };
    const out = await openverseSource({ fetchImpl: jsonFetch(body, []) })(q());
    expect(out.map((c) => c.id)).toEqual(['openverse:ok']);
  });

  it('没有缩略图时退回原图地址', async () => {
    const out = await openverseSource({ fetchImpl: jsonFetch({ results: [item('a', { thumbnail: null })] }, []) })(q());
    expect(out[0].thumb).toBe('https://img.example/a.jpg');
  });

  it('429：读 Retry-After（≤10 秒）等待后重试一次并成功', async () => {
    let n = 0;
    const waits: number[] = [];
    const f = (async () => {
      n += 1;
      return n === 1
        ? new Response('slow', { status: 429, headers: { 'Retry-After': '3' } })
        : new Response(JSON.stringify({ results: [item('a')] }), { status: 200 });
    }) as typeof fetch;
    const out = await openverseSource({ fetchImpl: f, sleep: async (ms) => { waits.push(ms); } })(q());
    expect(n).toBe(2);
    expect(waits).toEqual([3000]);
    expect(out).toHaveLength(1);
  });

  it('429：Retry-After 超过 10 秒不重试，直接报限流；重试后仍 429 也报限流', async () => {
    let n = 0;
    const long = (async () => { n += 1; return new Response('', { status: 429, headers: { 'Retry-After': '3600' } }); }) as typeof fetch;
    await expect(openverseSource({ fetchImpl: long, sleep: async () => undefined })(q())).rejects.toThrow(/Openverse.*限流/);
    expect(n).toBe(1);
    n = 0;
    const twice = (async () => { n += 1; return new Response('', { status: 429, headers: { 'Retry-After': '1' } }); }) as typeof fetch;
    await expect(openverseSource({ fetchImpl: twice, sleep: async () => undefined })(q())).rejects.toThrow(/Openverse.*限流/);
    expect(n).toBe(2);
  });

  it('服务端错误带来源名与状态码', async () => {
    const f = (async () => new Response('boom', { status: 503 })) as typeof fetch;
    await expect(openverseSource({ fetchImpl: f })(q())).rejects.toThrow(/Openverse.*503/);
  });
});

describe('freeSources 顺序', () => {
  const cfg = { dataDir: '/tmp/x' };
  it('Pexels（有 key）→ Pixabay（有 key）→ Openverse → Wikimedia', () => {
    expect(freeSources(cfg, { pexelsKey: 'a', pixabayKey: 'b' }).map((s) => s.name)).toEqual(['pexels', 'pixabay', 'openverse', 'wikimedia']);
  });
  it('没有 key 时只剩免 key 的两个来源', () => {
    expect(freeSources(cfg, {}).map((s) => s.name)).toEqual(['openverse', 'wikimedia']);
  });
});
