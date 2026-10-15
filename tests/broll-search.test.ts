import { describe, expect, it } from 'vitest';
import { extractUrls, KEXIANG_RESPONSES_URL, searchUrls, SEARCH_MODEL } from '../src/broll/search.js';

describe('extractUrls', () => {
  it('提取正文网址，去掉反引号与末尾标点，去重保序', () => {
    expect(extractUrls('1. `https://a.com/x`，2. https://b.org/y). 再看 https://a.com/x')).toEqual(['https://a.com/x', 'https://b.org/y']);
  });
});

describe('searchUrls', () => {
  it('调用 Responses + web_search（gpt-5.6-luna），优先 annotations，过滤 pdf/图片', async () => {
    let body: any;
    let url = '';
    const fetchImpl = (async (u: string, init: RequestInit) => {
      url = u;
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ output: [{ type: 'message', content: [{ type: 'output_text', text: '见 https://c.com/z 与 https://d.com/a.pdf', annotations: [{ type: 'url_citation', url: 'https://e.com/1' }] }] }] }));
    }) as unknown as typeof fetch;
    const urls = await searchUrls('k', 'FDE 前置部署工程师', { fetchImpl });
    expect(url).toBe(KEXIANG_RESPONSES_URL);
    expect(body).toMatchObject({ model: SEARCH_MODEL, tools: [{ type: 'web_search' }] });
    expect(String(body.input)).toContain('FDE 前置部署工程师');
    expect(urls).toEqual(['https://e.com/1', 'https://c.com/z']);
  });
  it('非 2xx 报错', async () => {
    const fetchImpl = (async () => new Response('bad', { status: 500 })) as unknown as typeof fetch;
    await expect(searchUrls('k', 'x', { fetchImpl })).rejects.toThrow('500');
  });
});
