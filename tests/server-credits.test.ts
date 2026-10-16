import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { startApp } from '../src/server/app.js';
import { validateStockKey } from '../src/server/stock-validate.js';
import type { RunnerCtx } from '../src/workspace/runner.js';
import { memoryKeyStore, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

const PEXELS = 'pexels-key-ABCDEFGH0123456789abcdef';
const PIXABAY = '12345678-pixabaykey0123456789ab';

let t: TestApp;
let seenCtx: RunnerCtx | undefined;
beforeAll(async () => {
  t = await startTestApp({
    deps: {
      validateStockKey: async (_p, key) => {
        if (key === 'neterr') throw new Error('无法校验 key：网络错误');
        return key === PEXELS || key === PIXABAY;
      },
    },
  });
});
afterAll(async () => { await t.close(); });

describe('图库 key 存取与校验', () => {
  it('初始都未配置', async () => {
    const r = await t.call('GET', '/api/stock-keys');
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ pexels: { configured: false }, pixabay: { configured: false } });
  });

  it('无效 400、暂时无法校验 503（不是「无效」）、有效才保存，响应里没有完整 key', async () => {
    const bad = await t.call('POST', '/api/stock-keys', { provider: 'pexels', key: 'wrong-key' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('无效');
    const net = await t.call('POST', '/api/stock-keys', { provider: 'pexels', key: 'neterr' });
    expect(net.status).toBe(503);
    expect(net.json.error).toContain('暂时无法校验');
    expect(net.json.error).not.toContain('无效');
    expect((await t.call('GET', '/api/stock-keys')).json.pexels.configured).toBe(false);

    const ok = await t.call('POST', '/api/stock-keys', { provider: 'pexels', key: PEXELS });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain(PEXELS);
    expect(ok.json.pexels).toMatchObject({ configured: true, source: 'file', masked: '…cdef' });
    expect(ok.json.pixabay).toEqual({ configured: false });
    expect((await t.call('GET', '/api/stock-keys')).text).not.toContain(PEXELS);
  });

  it('回退文件是 600 权限；两个来源互不覆盖', async () => {
    await t.call('POST', '/api/stock-keys', { provider: 'pixabay', key: PIXABAY });
    const file = join(t.app.cfg.dataDir, 'pexels-key');
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(readFileSync(file, 'utf8').trim()).toBe(PEXELS);
    const all = (await t.call('GET', '/api/stock-keys')).json;
    expect(all.pexels.configured).toBe(true);
    expect(all.pixabay).toMatchObject({ configured: true, masked: '…89ab' });
  });

  it('参数不合法 400：来源不认识、key 为空或含空白', async () => {
    expect((await t.call('POST', '/api/stock-keys', { provider: 'unsplash', key: 'abc' })).status).toBe(400);
    expect((await t.call('POST', '/api/stock-keys', { provider: 'pexels', key: '  ' })).status).toBe(400);
    expect((await t.call('POST', '/api/stock-keys', { provider: 'pexels', key: 'a b' })).status).toBe(400);
    expect((await t.call('DELETE', '/api/stock-keys?provider=nope')).status).toBe(400);
  });

  it('保存过的 key 会被错误文案与事件的抹除逻辑覆盖', async () => {
    expect(t.app.keys.redact(`请求失败 ${PEXELS} 与 ${PIXABAY}`)).not.toMatch(/ABCDEFGH|pixabaykey/);
  });

  it('出片时把图库 key 交给运行器的配置，且不进项目事件', async () => {
    const k = await startTestApp({
      key: 'sk-goodkey1234567890',
      deps: {
        validateStockKey: async () => true,
        runFirst: async (ctx, id) => { seenCtx = ctx; return ctx.store.addVersion(id, { summary: '首版', changedShots: [], costYuan: 0, status: 'failed' }); },
      },
    });
    try {
      await k.call('POST', '/api/stock-keys', { provider: 'pexels', key: PEXELS });
      const id = await spaceWithInput(k);
      expect((await k.call('POST', `/api/spaces/${id}/start`)).status).toBe(202);
      await waitFor(() => seenCtx !== undefined);
      expect(seenCtx?.cfg.pexelsKey).toBe(PEXELS);
      expect(seenCtx?.cfg.pixabayKey).toBeUndefined();
    } finally {
      await k.close();
    }
  });

  it('DELETE 清除一个来源', async () => {
    expect((await t.call('DELETE', '/api/stock-keys?provider=pexels')).status).toBe(204);
    const all = (await t.call('GET', '/api/stock-keys')).json;
    expect(all.pexels).toEqual({ configured: false });
    expect(all.pixabay.configured).toBe(true);
    await t.call('DELETE', '/api/stock-keys?provider=pixabay');
  });

  it('环境变量优先，来源标 env', async () => {
    const cfg = { ...loadConfig({}), dataDir: join(t.root, 'env-data'), pexelsKey: PEXELS };
    const app = await startApp({ cfg, keyStore: memoryKeyStore(), webDir: t.webDir, deps: { validateStockKey: async () => true } }, 0);
    try {
      const r = await fetch(`${app.url}/api/stock-keys`);
      const body = await r.json() as { pexels: { source?: string; masked?: string } };
      expect(body.pexels).toMatchObject({ configured: true, source: 'env', masked: '…cdef' });
    } finally {
      await app.close();
    }
  });
});

describe('validateStockKey（各调一次最便宜的搜索接口）', () => {
  const res = (status: number, body = ''): Response => new Response(body, { status });

  it('Pexels：Authorization 头带 key，1 条结果；200 有效，401/403 无效，其余抛错', async () => {
    const calls: { url: string; auth: string | null }[] = [];
    const make = (status: number): typeof fetch => (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), auth: new Headers(init?.headers).get('Authorization') });
      return res(status);
    }) as typeof fetch;
    expect(await validateStockKey('pexels', 'K1', make(200))).toBe(true);
    expect(calls[0].url).toBe('https://api.pexels.com/v1/search?query=nature&per_page=1');
    expect(calls[0].auth).toBe('K1');
    expect(await validateStockKey('pexels', 'K1', make(401))).toBe(false);
    expect(await validateStockKey('pexels', 'K1', make(403))).toBe(false);
    await expect(validateStockKey('pexels', 'K1', make(429))).rejects.toThrow('暂时无法校验');
    await expect(validateStockKey('pexels', 'K1', make(500))).rejects.toThrow('暂时无法校验');
  });

  it('Pixabay：key 在查询串里（编码），per_page 取接口下限 3；400 且提示 key 问题判无效', async () => {
    const urls: string[] = [];
    const make = (status: number, body = ''): typeof fetch => (async (input: RequestInfo | URL) => { urls.push(String(input)); return res(status, body); }) as typeof fetch;
    expect(await validateStockKey('pixabay', 'a b&c', make(200))).toBe(true);
    expect(urls[0]).toBe('https://pixabay.com/api/?key=a%20b%26c&q=nature&per_page=3');
    expect(await validateStockKey('pixabay', 'K2', make(400, '[ERROR 400] Invalid or missing API key'))).toBe(false);
    expect(await validateStockKey('pixabay', 'K2', make(401))).toBe(false);
    await expect(validateStockKey('pixabay', 'K2', make(400, 'bad request'))).rejects.toThrow('暂时无法校验');
    await expect(validateStockKey('pixabay', 'K2', make(429))).rejects.toThrow('暂时无法校验');
  });

  it('网络错误：提示暂时无法校验，且错误文案里没有 key', async () => {
    const boom = (async () => { throw new TypeError('fetch failed'); }) as typeof fetch;
    const err = await validateStockKey('pixabay', 'SECRETKEY123', boom).catch((e: Error) => e);
    expect((err as Error).message).toContain('暂时无法校验');
    expect((err as Error).message).not.toContain('SECRETKEY123');
  });
});

/** 造一个已完成的版本并写入 credits.json */
async function versionWithCredits(entries: unknown, extra: Record<string, string> = {}): Promise<{ id: string; dir: string }> {
  await t.call('POST', '/api/key', { key: 'sk-goodkey1234567890' });
  const id = await spaceWithInput(t);
  await t.call('POST', `/api/spaces/${id}/start`);
  await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
  const dir = t.app.store.versionDir(id, 1);
  mkdirSync(join(dir, 'broll'), { recursive: true });
  writeFileSync(join(dir, 'credits.json'), typeof entries === 'string' ? entries : JSON.stringify(entries));
  for (const [name, text] of Object.entries(extra)) writeFileSync(join(dir, name), text);
  return { id, dir };
}

const base = {
  page: 'https://example.com/p', license: 'Pexels License', attributionRequired: false, aiGenerated: false, modified: ['crop'], query: 'office', fetchedAt: '2026-10-16T00:00:00.000Z',
};
const ENTRIES = [
  { ...base, file: 'broll/office.mp4', source: 'pexels', author: 'Ann', authorUrl: 'https://www.pexels.com/@ann' },
  { ...base, file: 'broll/server.jpg', source: 'wikimedia', author: 'Eve', license: 'CC BY 4.0', attributionRequired: true },
  { ...base, file: 'broll/shot.png', source: 'screenshot', page: 'https://news.example.com/a', license: '网页截图', modified: [] },
  { ...base, file: 'broll/ai.png', source: 'generated', license: 'AI 生成', aiGenerated: true, modified: [] },
];

describe('素材来源 credits', () => {
  it('没有 credits.json（旧版本）→ 空列表', async () => {
    await t.call('POST', '/api/key', { key: 'sk-goodkey1234567890' });
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    const r = await t.call('GET', `/api/spaces/${id}/versions/1/credits`);
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ entries: [], attribution: '' });
  });

  it('逐条列出：只给文件名与缩略图地址，不含本机路径；带署名文本', async () => {
    const { id } = await versionWithCredits(ENTRIES);
    const r = await t.call('GET', `/api/spaces/${id}/versions/1/credits`);
    expect(r.status).toBe(200);
    expect(r.json.entries).toHaveLength(4);
    expect(r.json.entries[0]).toMatchObject({
      file: 'office.mp4', kind: 'video', source: 'pexels', author: 'Ann', license: 'Pexels License', aiGenerated: false, modified: ['crop'],
      thumb: `/api/spaces/${id}/versions/1/credits/office.mp4/thumb`,
    });
    expect(r.json.entries[1]).toMatchObject({ file: 'server.jpg', kind: 'image', attributionRequired: true });
    expect(r.json.entries[3]).toMatchObject({ aiGenerated: true });
    expect(r.json.attribution).toContain('素材：Pexels');
    expect(r.text).not.toContain(t.root);
    expect(r.text).not.toContain('broll/');
  });

  it('项目或版本不存在 404', async () => {
    const { id } = await versionWithCredits(ENTRIES);
    expect((await t.call('GET', `/api/spaces/${id}/versions/9/credits`)).status).toBe(404);
    expect((await t.call('GET', `/api/spaces/nope/versions/1/credits`)).status).toBe(404);
  });

  it('credits.json 损坏 → 500 中文提示', async () => {
    const { id } = await versionWithCredits('{not json');
    const r = await t.call('GET', `/api/spaces/${id}/versions/1/credits`);
    expect(r.status).toBe(500);
    expect(r.json.error).toContain('素材来源记录已损坏');
  });

  it('缩略图：返回素材文件本身；记录里的路径越出版本目录 → 404', async () => {
    const entries = [...ENTRIES, { ...base, file: '../../secret.png', source: 'pexels' }];
    const { id } = await versionWithCredits(entries, { 'broll/server.jpg': 'JPEGDATA' });
    writeFileSync(join(t.root, 'data', 'spaces', 'secret.png'), 'SECRET');
    const ok = await t.call('GET', `/api/spaces/${id}/versions/1/credits/server.jpg/thumb`);
    expect(ok.status).toBe(200);
    expect(ok.text).toBe('JPEGDATA');
    expect(ok.headers.get('content-type')).toBe('image/jpeg');
    expect((await t.call('GET', `/api/spaces/${id}/versions/1/credits/secret.png/thumb`)).status).toBe(404);
    expect((await t.call('GET', `/api/spaces/${id}/versions/1/credits/unknown.png/thumb`)).status).toBe(404);
    expect((await t.call('GET', `/api/spaces/${id}/versions/1/credits/ai.png/thumb`)).status).toBe(404); // 文件不存在
  });

  it('标记替换 / 删除：落盘、再次读取带 mark，可改标记；不认识的文件或动作被拒', async () => {
    const { id, dir } = await versionWithCredits(ENTRIES);
    const rep = await t.call('POST', `/api/spaces/${id}/versions/1/credits/office.mp4/replace`);
    expect(rep.status).toBe(200);
    expect(rep.json).toMatchObject({ file: 'office.mp4', action: 'replace', pending: true });
    expect(JSON.parse(readFileSync(join(dir, 'credits-marks.json'), 'utf8'))['broll/office.mp4'].action).toBe('replace');
    await t.call('POST', `/api/spaces/${id}/versions/1/credits/server.jpg/remove`);
    await t.call('POST', `/api/spaces/${id}/versions/1/credits/office.mp4/remove`);
    const r = await t.call('GET', `/api/spaces/${id}/versions/1/credits`);
    const mark = (f: string): unknown => r.json.entries.find((e: { file: string }) => e.file === f).mark;
    expect(mark('office.mp4')).toBe('remove');
    expect(mark('server.jpg')).toBe('remove');
    expect(mark('ai.png')).toBeUndefined();
    expect((await t.call('POST', `/api/spaces/${id}/versions/1/credits/nope.png/replace`)).status).toBe(404);
    expect((await t.call('POST', `/api/spaces/${id}/versions/1/credits/office.mp4/explode`)).status).toBe(400);
  });

  it('条目带镜头序号：对照版本状态里 shots[i].broll.file；没用在镜头上的没有', async () => {
    const { id, dir } = await versionWithCredits(ENTRIES);
    const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'));
    state.storyboard.shots[1] = { ...state.storyboard.shots[1], broll: { file: 'broll/office.mp4' } };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(state));
    const r = await t.call('GET', `/api/spaces/${id}/versions/1/credits`);
    expect(r.json.entries[0].shotIndex).toBe(1);
    expect(r.json.entries[1].shotIndex).toBeUndefined();
  });

  it('导出结果附署名文本（有素材记录才有）', async () => {
    const { id } = await versionWithCredits(ENTRIES);
    const out = await t.call('POST', `/api/spaces/${id}/versions/1/export`);
    expect(out.status).toBe(200);
    expect(out.json.attribution).toContain('素材：Pexels');
    expect(out.json.attribution).toContain('部分画面为 AI 生成');
    await t.call('POST', '/api/key', { key: 'sk-goodkey1234567890' });
    const plain = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${plain}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${plain}`)).json.versions[0]?.status === 'done');
    const out2 = await t.call('POST', `/api/spaces/${plain}/versions/1/export`);
    expect(out2.json.attribution).toBeUndefined();
  });
});
