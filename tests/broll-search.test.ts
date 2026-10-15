import { describe, expect, it } from 'vitest';
import { extractUrls, isPublicHttpUrl, KEXIANG_RESPONSES_URL, searchUrls, SEARCH_MODEL } from '../src/broll/search.js';

describe('extractUrls', () => {
  it('提取正文网址，去掉反引号与末尾标点，去重保序', () => {
    expect(extractUrls('1. `https://a.com/x`，2. https://b.org/y). 再看 https://a.com/x')).toEqual(['https://a.com/x', 'https://b.org/y']);
  });
  it('markdown 链接只取括号里的网址', () => {
    expect(extractUrls('[https://a.com](https://a.com) 和 [官网](https://b.com/p)')).toEqual(['https://a.com', 'https://b.com/p']);
  });
  it('去掉加粗星号', () => {
    expect(extractUrls('**https://a.com/x**')).toEqual(['https://a.com/x']);
  });
  it('遇到中文字符就截断', () => {
    expect(extractUrls('https://a.com/x是官网')).toEqual(['https://a.com/x']);
  });
  it('网址自带括号时保留成对的右括号', () => {
    expect(extractUrls('见 https://en.wikipedia.org/wiki/Foo_(bar)')).toEqual(['https://en.wikipedia.org/wiki/Foo_(bar)']);
  });
  it('全角括号包裹的网址', () => {
    expect(extractUrls('（https://a.com/x）')).toEqual(['https://a.com/x']);
  });
});

describe('extractUrls 下划线与星号', () => {
  it('末尾下划线属于网址，不剥离', () => {
    expect(extractUrls('见 https://a.com/foo_')).toEqual(['https://a.com/foo_']);
  });
  it('网址中间的星号保留，末尾星号剥离', () => {
    expect(extractUrls('https://a.com/a*b?q=1**')).toEqual(['https://a.com/a*b?q=1']);
  });
});

describe('isPublicHttpUrl 内网网段（语法判断，不做 DNS 解析）', () => {
  const rejected = [
    // 主机名：尾点、特殊后缀
    'http://localhost./', 'http://foo.localhost./', 'http://printer.local/', 'http://db.internal/', 'http://db.internal./',
    // IPv4
    'http://0.1.2.3/', 'http://10.255.0.1/', 'http://100.64.0.1/', 'http://100.127.255.255/', 'http://127.0.0.1/',
    'http://169.254.1.1/', 'http://172.16.0.1/', 'http://172.31.255.255/', 'http://192.0.0.5/', 'http://192.168.1.1/',
    'http://198.18.0.1/', 'http://198.19.255.255/', 'http://224.0.0.1/', 'http://239.255.255.255/', 'http://240.0.0.1/',
    'http://255.255.255.255/',
    // IPv6
    'http://[::]/', 'http://[::1]/', 'http://[::7f00:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:10.0.0.1]/',
    'http://[64:ff9b::7f00:1]/', 'http://[2002:7f00:1::]/', 'http://[2002:c0a8:101::1]/',
    'http://[fc00::1]/', 'http://[fd12:3456::1]/', 'http://[fe80::1]/', 'http://[febf::1]/', 'http://[fec0::1]/',
    'http://[ff02::1]/',
  ];
  const allowed = [
    'https://example.com/', 'https://example.com./', 'http://8.8.8.8/', 'http://100.63.255.255/', 'http://100.128.0.1/',
    'http://172.15.0.1/', 'http://172.32.0.1/', 'http://198.17.0.1/', 'http://198.20.0.1/', 'http://223.255.255.255/',
    'http://[2606:4700::1111]/', 'http://[2001:4860:4860::8888]/', 'http://[::ffff:8.8.8.8]/',
    'http://[64:ff9b::808:808]/', 'http://[2002:808:808::1]/',
  ];
  it.each(rejected)('拒绝 %s', (u) => expect(isPublicHttpUrl(u)).toBe(false));
  it.each(allowed)('放行 %s', (u) => expect(isPublicHttpUrl(u)).toBe(true));
});

describe('isPublicHttpUrl', () => {
  it.each([
    'https://example.com/a',
    'http://93.184.216.34/x',
    'https://172.32.0.1/',
  ])('放行 %s', (u) => expect(isPublicHttpUrl(u)).toBe(true));
  it.each([
    'file:///etc/passwd',
    'javascript:alert(1)',
    'ftp://a.com/x',
    '--remote-debugging-port=1',
    'http://localhost:3000/',
    'http://foo.localhost/',
    'http://127.0.0.1/',
    'http://127.5.5.5/',
    'http://10.0.0.1/',
    'http://172.16.0.1/',
    'http://172.31.255.255/',
    'http://192.168.1.1/',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]/',
    'http://0.0.0.0/',
    'http://2130706433/',
  ])('拒绝 %s', (u) => expect(isPublicHttpUrl(u)).toBe(false));
});

function fakeFetch(payload: unknown, seen?: { url?: string; body?: any; auth?: string }): typeof fetch {
  return (async (u: string, init: RequestInit) => {
    if (seen) {
      seen.url = u;
      seen.body = JSON.parse(String(init.body));
      seen.auth = (init.headers as Record<string, string>).Authorization;
    }
    return new Response(JSON.stringify(payload));
  }) as unknown as typeof fetch;
}

describe('searchUrls', () => {
  it('调用 Responses + web_search（gpt-5.6-luna），优先 annotations，过滤 pdf/图片', async () => {
    const seen: { url?: string; body?: any } = {};
    const payload = { output: [{ type: 'message', content: [{ type: 'output_text', text: '见 https://c.com/z 与 https://d.com/a.pdf', annotations: [{ type: 'url_citation', url: 'https://e.com/1' }] }] }] };
    const urls = await searchUrls('k', 'FDE 前置部署工程师', { fetchImpl: fakeFetch(payload, seen) });
    expect(seen.url).toBe(KEXIANG_RESPONSES_URL);
    expect(seen.body).toMatchObject({ model: SEARCH_MODEL, tools: [{ type: 'web_search' }] });
    expect(String(seen.body.input)).toContain('FDE 前置部署工程师');
    expect(urls).toEqual(['https://e.com/1', 'https://c.com/z']);
  });
  it('非 2xx 报错', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 500 })) as unknown as typeof fetch;
    await expect(searchUrls('k', 'x', { fetchImpl })).rejects.toThrow('500');
  });
  it('丢掉非 http(s) 与内网地址', async () => {
    const text = 'file:///etc/passwd http://localhost:8080/a http://192.168.1.2/b https://ok.com/p';
    const urls = await searchUrls('k', 'x', { fetchImpl: fakeFetch({ output: [{ type: 'message', content: [{ text }] }] }) });
    expect(urls).toEqual(['https://ok.com/p']);
  });
  it('去掉 utm_* 参数后再去重', async () => {
    const text = 'https://a.com/x?utm_source=g&id=1 https://a.com/x?id=1&utm_medium=m https://b.com?utm_campaign=z';
    const urls = await searchUrls('k', 'x', { fetchImpl: fakeFetch({ output: [{ type: 'message', content: [{ text }] }] }) });
    expect(urls).toEqual(['https://a.com/x?id=1', 'https://b.com/']);
  });
  it('apiKey 去首尾空白并补 sk- 前缀', async () => {
    const seen: { auth?: string } = {};
    await searchUrls('  k  ', 'x', { fetchImpl: fakeFetch({ output: [] }, seen) });
    expect(seen.auth).toBe('Bearer sk-k');
  });
  it.each([0, 11, 1.5, Number.NaN])('max=%s 非法时报错', async (max) => {
    await expect(searchUrls('k', 'x', { max, fetchImpl: fakeFetch({ output: [] }) })).rejects.toThrow('max');
  });
  it('max 截断结果数量', async () => {
    const text = 'https://a.com https://b.com https://c.com';
    const urls = await searchUrls('k', 'x', { max: 2, fetchImpl: fakeFetch({ output: [{ type: 'message', content: [{ text }] }] }) });
    expect(urls).toHaveLength(2);
  });
});
