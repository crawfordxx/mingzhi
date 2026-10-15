import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { sanitizeFileName } from '../src/server/upload.js';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
let id: string;
beforeAll(async () => {
  t = await startTestApp({ key: GOOD_KEY });
  id = await spaceWithInput(t);
  await t.call('POST', `/api/spaces/${id}/start`);
  await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
  writeFileSync(join(t.root, 'secret.txt'), 'secret');
  writeFileSync(join(t.root, 'data', 'spaces', id, 'v1', 'state.json.bak'), 'x');
});
afterAll(async () => { await t.close(); });

/** 用原始 http 发请求，路径不经过 URL 归一化（fetch 会把 /../ 合并掉） */
function raw(path: string, headers: Record<string, string> = {}, method = 'GET'): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port: t.port, path, method, headers: { Host: `127.0.0.1:${t.port}`, ...headers } }, (res) => {
      let body = '';
      res.on('data', (d: Buffer) => { body += d.toString(); });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('媒体路由只认白名单', () => {
  it.each([
    [`/media/${id}/1/../../../../secret.txt`],
    [`/media/${id}/1/%2e%2e/%2e%2e/secret.txt`],
    [`/media/${id}/1/%2E%2E%2Fsecret.txt`],
    [`/media/${id}/1/..%2fstate.json`],
    [`/media/${id}/1/state.json`],
    [`/media/${id}/1/state.json.bak`],
    [`/media/${id}/1/events.jsonl`],
    [`/media/${id}/1/%2Fetc%2Fpasswd`],
    [`/media/${id}/1//etc/passwd`],
    [`/media/..%2f..%2f/1/final.mp4`],
    [`/media/%2e%2e/1/final.mp4`],
    [`/media/${id}/0/final.mp4`],
    [`/media/${id}/9/final.mp4`],
    [`/media/${id}/1/final.mp4%00.png`],
    [`/media/nope/1/final.mp4`],
  ])('%s → 404', async (path) => {
    const r = await raw(path);
    expect(r.status).toBe(404);
    expect(r.body).not.toContain('secret');
  });

  it('白名单内的文件正常', async () => {
    expect((await raw(`/media/${id}/1/final.mp4`)).status).toBe(200);
    expect((await raw(`/media/${id}/1/cover-4x3.png`)).status).toBe(200);
  });
});

describe('拒绝跨源与 DNS 重绑定', () => {
  it('跨源写请求被拒（Origin 不是本机当前端口）', async () => {
    for (const origin of ['http://evil.example', 'https://127.0.0.1:' + t.port, `http://127.0.0.1:${t.port + 1}`, 'null']) {
      const r = await t.call('POST', '/api/spaces', {}, { Origin: origin });
      expect(r.status, origin).toBe(403);
      expect(r.json.error).toContain('跨源');
    }
    expect((await t.call('GET', '/api/spaces')).json.length).toBeGreaterThan(0);
    const before = (await t.call('GET', '/api/spaces')).json.length;
    await t.call('POST', '/api/spaces', {}, { Origin: 'http://evil.example' });
    expect((await t.call('GET', '/api/spaces')).json.length).toBe(before);
  });

  it('本机同端口 Origin 放行（127.0.0.1 与 localhost）', async () => {
    expect((await t.call('POST', '/api/spaces', {}, { Origin: `http://127.0.0.1:${t.port}` })).status).toBe(201);
    expect((await t.call('POST', '/api/spaces', {}, { Origin: `http://localhost:${t.port}` })).status).toBe(201);
  });

  it('Sec-Fetch-Site 为跨站时写请求被拒', async () => {
    expect((await t.call('POST', '/api/spaces', {}, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403);
    expect((await t.call('POST', '/api/spaces', {}, { 'Sec-Fetch-Site': 'same-origin' })).status).toBe(201);
  });

  it('Host 不是本机地址时拒绝（DNS 重绑定）', async () => {
    expect((await raw('/api/status', { Host: 'evil.example' })).status).toBe(403);
    expect((await raw('/api/status', { Host: `evil.example:${t.port}` })).status).toBe(403);
    expect((await raw('/api/status', { Host: `localhost:${t.port}` })).status).toBe(200);
  });

  it('开发端口：默认不允许 vite 的 Host；设置 devPort 后 Host 与 Origin 都放行', async () => {
    expect((await raw('/api/status', { Host: '127.0.0.1:5173' })).status).toBe(403);
    const dev = await startTestApp({ devPort: 5173 });
    try {
      const viaProxy = { Host: '127.0.0.1:5173', Origin: 'http://127.0.0.1:5173' };
      expect((await dev.call('POST', '/api/spaces', {}, viaProxy)).status).toBe(201);
      expect((await dev.call('POST', '/api/spaces', {}, { ...viaProxy, Origin: 'http://127.0.0.1:5174' })).status).toBe(403);
    } finally {
      await dev.close();
    }
  });
});

describe('请求体错误给中文提示', () => {
  it('JSON 解析失败 400', async () => {
    const r = await t.call('POST', '/api/spaces', '{坏的');
    expect(r.status).toBe(400);
    expect(r.json.error).toBe('请求体不是有效的 JSON');
  });

  it('不是对象 400', async () => {
    expect((await t.call('POST', '/api/spaces', '[1]')).json.error).toBe('请求体必须是 JSON 对象');
  });

  it('超大请求体 413', async () => {
    const r = await t.call('POST', '/api/key', { key: 'x'.repeat(2 * 1024 * 1024) });
    expect(r.status).toBe(413);
    expect(r.json.error).toContain('请求体过大');
  });

  it('设置不合法 400（字幕样式、预算、未知字段、文件背景）', async () => {
    expect((await t.call('POST', '/api/spaces', { settings: { captionStyle: 'nope' } })).status).toBe(400);
    expect((await t.call('POST', '/api/spaces', { settings: { budgetYuan: -1 } })).status).toBe(400);
    expect((await t.call('POST', '/api/spaces', { settings: { evil: 1 } })).status).toBe(400);
    const file = await t.call('POST', '/api/spaces', { settings: { background: { kind: 'file', path: '/etc/passwd' } } });
    expect(file.status).toBe(400);
    expect((await t.call('POST', '/api/spaces', { title: '' })).json.error).toContain('标题不能为空');
  });

  it('不支持的方法 405，未知接口 404', async () => {
    expect((await raw('/api/status', {}, 'PUT')).status).toBe(405);
    expect((await t.call('POST', '/api/status', {})).status).toBe(405);
    expect((await t.call('GET', '/api/nothing')).status).toBe(404);
  });
});

describe('上传文件名清洗与限制', () => {
  it.each([
    ['../../etc/passwd.mp4', 'passwd.mp4'],
    ['..\\..\\evil.mp4', 'evil.mp4'],
    ['a:b*c?.mp4', 'a_b_c_.mp4'],
    ['  ..隐藏.mp4', '隐藏.mp4'],
    ['%E5%8F%A3%E6%92%AD.mp4', '口播.mp4'],
    ['%2e%2e%2fx.mp4', 'x.mp4'],
    ['.hidden.mp4', 'hidden.mp4'],
  ])('%s → %s', (input, out) => {
    expect(sanitizeFileName(input)).toBe(out);
  });

  it('不支持的扩展名 400，缺文件名头 400，视频无法识别 400 且不留文件', async () => {
    const sid = (await t.call('POST', '/api/spaces', {})).json.id as string;
    const send = (name: string | null, body: string): Promise<Response> => fetch(`${t.url}/api/spaces/${sid}/inputs`, { method: 'POST', headers: name === null ? {} : { 'x-filename': name }, body });
    expect((await send('a.exe', 'x')).status).toBe(400);
    expect((await send(null, 'x')).status).toBe(400);
    const bad = await send('bad.mp4', 'bad-content');
    expect(bad.status).toBe(400);
    expect((await bad.json() as { error: string }).error).toContain('不是可识别的视频');
    const dir = join(t.root, 'data', 'spaces', sid, 'inputs');
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([]);
    expect((await send('empty.mp4', '')).status).toBe(400);
  });

  it('上传的文件落在项目 inputs 目录内，且路径里没有 ..', async () => {
    const sid = await spaceWithInput(t);
    const dir = join(t.root, 'data', 'spaces', sid, 'inputs');
    const files = readdirSync(dir, { recursive: true }).map(String);
    expect(files.some((f) => f.endsWith('口播.mp4'))).toBe(true);
    expect(files.every((f) => !f.includes('..'))).toBe(true);
  });
});

describe('错误响应不泄露 key', () => {
  it('规划失败时错误里的 key 被抹掉', async () => {
    const leaky = await startTestApp({
      key: GOOD_KEY,
      deps: { planClient: () => ({ chatJson: async () => { throw new Error(`请求失败 Authorization: Bearer ${GOOD_KEY}`); } }) },
    });
    try {
      const sid = await spaceWithInput(leaky);
      await leaky.call('POST', `/api/spaces/${sid}/start`);
      await waitFor(async () => (await leaky.call('GET', `/api/spaces/${sid}`)).json.versions[0]?.status === 'done');
      const r = await leaky.call('POST', `/api/spaces/${sid}/messages`, { message: '换个背景' });
      expect(r.status).toBe(502);
      expect(r.text).not.toContain('goodkey1234567890');
    } finally {
      await leaky.close();
    }
  });
});
