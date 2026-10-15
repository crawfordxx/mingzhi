import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { createApp, startApp } from '../src/server/app.js';
import { asHttpError, HttpError } from '../src/server/http.js';
import { KeyCache } from '../src/server/keys.js';
import { sanitizeFileName } from '../src/server/upload.js';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
afterEach(async () => { await t.close(); });

type V = { n: number; status: string };
const versionsOf = async (id: string): Promise<V[]> => (await t.call('GET', `/api/spaces/${id}`)).json.versions;
const doneAt = (id: string, n: number) => async (): Promise<boolean> => (await versionsOf(id)).find((v) => v.n === n)?.status === 'done';
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
/** 形似 key 但不是当前 key 的长串（任何 sk- 开头的长串都要被抹掉） */
const STRAY = ['sk', 'abcdefghijklmnopqrstuvwxyz'].join('-');

describe('事件流里的 key 一律抹除（I1）', () => {
  it('运行器事件、detail、抛出的错误含 key：SSE、history、events.jsonl 都看不到', async () => {
    const bare = GOOD_KEY.slice(3);
    t = await startTestApp({
      key: GOOD_KEY,
      deps: {
        runFirst: async (ctx, id) => {
          const v = ctx.store.addVersion(id, { summary: '首个版本', changedShots: [], costYuan: 0, status: 'running' });
          ctx.bus.publish({ t: 1, spaceId: id, version: v.n, step: 'probe', message: `Authorization: Bearer ${GOOD_KEY}`, detail: { kind: 'x', data: { raw: bare, other: STRAY } } });
          ctx.store.updateVersion(id, v.n, { status: 'failed' });
          throw new Error(`Incorrect API key provided: ${GOOD_KEY}`);
        },
      },
    });
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await versionsOf(id))[0]?.status === 'failed');
    await waitFor(() => t.app.bus.history(id, 1).some((e) => e.step === 'failed'));
    const file = readFileSync(join(t.root, 'data', 'spaces', id, 'v1', 'events.jsonl'), 'utf8');
    const reader = (await fetch(`${t.url}/api/spaces/${id}/events?version=1`)).body!.getReader();
    let live = '';
    while (!live.includes('"step":"failed"')) live += new TextDecoder().decode((await reader.read()).value);
    await reader.cancel();
    for (const text of [file, JSON.stringify(t.app.bus.history(id, 1)), live]) {
      expect(text).not.toContain(bare);
      expect(text).not.toContain('abcdefghijklmnopqrstuvwxyz');
      expect(text).toContain('sk-***');
    }
  });

  it('KeyCache：记住见过的 key，换 key 后旧 key 仍被抹除；短时缓存不反复读钥匙串', async () => {
    let reads = 0;
    let value: string | null = 'sk-first-key-0123456789';
    const cache = new KeyCache({ dataDir: '/nonexistent' }, { get: async () => { reads += 1; return value; }, set: async () => undefined, clear: async () => undefined });
    await cache.get(); await cache.get(); await cache.get();
    expect(reads).toBe(1);
    value = 'sk-second-key-987654321';
    cache.invalidate();
    await cache.get();
    expect(reads).toBe(2);
    expect(cache.redact('旧 first-key-0123456789 新 sk-second-key-987654321')).toBe('旧 sk-*** 新 sk-***');
  });

  it('错误响应与状态轮询不会每次都去读钥匙串', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    let reads = 0;
    const original = t.keyStore.get;
    t.keyStore.get = async () => { reads += 1; return original(); };
    for (let i = 0; i < 5; i += 1) await t.call('GET', '/api/nothing');
    for (let i = 0; i < 3; i += 1) await t.call('GET', '/api/status');
    expect(reads).toBeLessThanOrEqual(1);
  });
});

describe('运行器建版本前失败（I2）', () => {
  it('排队期间删了 key：任务失败，不留 v<N> 目录；重新开始后历史干净', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    let release!: () => void;
    t.control.gate = new Promise<void>((r) => { release = r; });
    const a = await spaceWithInput(t);
    const b = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${a}/start`);
    await t.call('POST', `/api/spaces/${b}/start`); // 排队
    await t.call('DELETE', '/api/key');
    release();
    t.control.gate = undefined;
    await waitFor(doneAt(a, 1));
    await waitFor(async () => (await t.call('GET', `/api/spaces/${b}`)).json.job === null);
    expect(existsSync(join(t.root, 'data', 'spaces', b, 'v1'))).toBe(false);
    expect(await versionsOf(b)).toEqual([]);
    await t.call('POST', '/api/key', { key: GOOD_KEY });
    expect((await t.call('POST', `/api/spaces/${b}/start`)).json.version).toBe(1);
    await waitFor(doneAt(b, 1));
    expect(t.app.bus.history(b, 1).map((e) => e.step)).toEqual(['probe', 'done']);
  });
});

describe('对话花费计入项目（chatCostYuan）', () => {
  it('每次 messages 的花费累加到项目，失败的调用也记账；总花费 = 各版本 + 对话', async () => {
    let fail = false;
    t = await startTestApp({
      key: GOOD_KEY,
      deps: {
        planClient: (_key, meter) => ({
          chatJson: async () => {
            meter.addTask('fake', 0.02, '修改');
            if (fail) throw new Error('模型挂了');
            return { reply: '好', ops: [] };
          },
        }),
      },
    });
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(doneAt(id, 1));
    const r1 = await t.call('POST', `/api/spaces/${id}/messages`, { message: '你好' });
    expect(r1.json).toMatchObject({ costYuan: 0.02, chatCostYuan: 0.02 });
    fail = true;
    expect((await t.call('POST', `/api/spaces/${id}/messages`, { message: '再来' })).status).toBe(502);
    const space = (await t.call('GET', `/api/spaces/${id}`)).json;
    expect(space).toMatchObject({ chatCostYuan: 0.04, totalCostYuan: 0.54 });
    expect(t.app.store.get(id).chatCostYuan).toBe(0.04);
  });
});

describe('自定义背景白名单', () => {
  it('只收本项目 backgrounds/ 下的图片文件', async () => {
    t = await startTestApp();
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    const dir = join(t.root, 'data', 'spaces', id);
    mkdirSync(join(dir, 'backgrounds', 'x'), { recursive: true });
    writeFileSync(join(dir, 'backgrounds', 'x', 'fake.png'), 'not an image');
    writeFileSync(join(dir, 'backgrounds', 'x', 'real.png'), PNG);
    writeFileSync(join(dir, 'backgrounds', 'x', 'real.txt'), PNG);
    const bad = [dir, join(dir, 'space.json'), join(dir, 'backgrounds'), join(dir, 'backgrounds', 'x'), join(dir, 'backgrounds', 'x', 'fake.png'), join(dir, 'backgrounds', 'x', 'real.txt')];
    for (const path of bad) expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { background: { kind: 'file', path } } })).status, path).toBe(400);
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { background: { kind: 'file', path: join(dir, 'backgrounds', 'x', 'real.png') } } })).status).toBe(200);
  });
});

describe('服务本身', () => {
  it('响应头禁止被内嵌；请求超时已关闭（大文件上传）；只听 127.0.0.1', async () => {
    t = await startTestApp();
    for (const path of ['/api/status', '/', '/api/nothing']) {
      const r = await fetch(`${t.url}${path}`);
      expect(r.headers.get('x-frame-options'), path).toBe('DENY');
      expect(r.headers.get('content-security-policy'), path).toBe("frame-ancestors 'none'");
      expect(r.headers.get('x-content-type-options'), path).toBe('nosniff');
    }
    expect(createApp({ cfg: t.app.cfg, keyStore: t.keyStore }).server.requestTimeout).toBe(0);
    expect(new URL(t.url).hostname).toBe('127.0.0.1');
  });

  it('端口被占用时顺延到下一个可用端口', async () => {
    t = await startTestApp();
    const second = await startApp({ cfg: t.app.cfg, keyStore: t.keyStore }, t.port);
    try {
      expect(second.port).toBeGreaterThan(t.port);
      expect(second.port).toBeLessThanOrEqual(t.port + 20);
      expect((await fetch(`${second.url}/api/status`)).status).toBe(200);
    } finally {
      await second.close();
    }
  });

  it('磁盘写满翻成中文 507', () => {
    const mapped = asHttpError(Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' }));
    expect(mapped).toBeInstanceOf(HttpError);
    expect((mapped as HttpError).status).toBe(507);
    expect((mapped as HttpError).message).toBe('磁盘空间不足，请清理磁盘后重试');
    const other = new Error('别的错');
    expect(asHttpError(other)).toBe(other);
  });

  it('HEAD 事件流 405；HEAD 媒体可用', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(doneAt(id, 1));
    const head = (path: string): Promise<{ code: number; length: string | undefined }> => new Promise((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port: t.port, path, method: 'HEAD' }, (res) => { res.resume(); resolve({ code: res.statusCode ?? 0, length: res.headers['content-length'] }); });
      req.on('error', reject);
      req.end();
    });
    expect((await head(`/api/spaces/${id}/events?version=1`)).code).toBe(405);
    expect(await head(`/media/${id}/1/final.mp4`)).toEqual({ code: 200, length: '1000' });
  });

  it('多段口播时 start 先拦住，不白占队列和版本号', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t);
    await fetch(`${t.url}/api/spaces/${id}/inputs`, { method: 'POST', headers: { 'x-filename': 'b.mp4' }, body: 'ok-2' });
    const r = await t.call('POST', `/api/spaces/${id}/start`);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('一段');
    expect(await versionsOf(id)).toEqual([]);
  });

  it('Windows 保留设备名加前缀', () => {
    expect(sanitizeFileName('CON.mp4')).toBe('_CON.mp4');
    expect(sanitizeFileName('nul')).toBe('_nul');
    expect(sanitizeFileName('console.mp4')).toBe('console.mp4');
  });
});

describe('导出', () => {
  it('同名文件已存在时加 (2)、(3) 后缀，不覆盖；标题只剩点时回退「成片」', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t, { title: '...' });
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(doneAt(id, 1));
    const first = await t.call('POST', `/api/spaces/${id}/versions/1/export`);
    writeFileSync(first.json.files[0], 'MARK');
    const second = await t.call('POST', `/api/spaces/${id}/versions/1/export`);
    const third = await t.call('POST', `/api/spaces/${id}/versions/1/export`);
    const names = (r: { json: { files: string[] } }): string[] => r.json.files.map((f) => f.slice(t.exportDir.length + 1));
    expect(names(first)).toEqual(['成片-v1.mp4', '成片-v1-封面3x4.png', '成片-v1-封面4x3.png']);
    expect(names(second)[0]).toBe('成片-v1(2).mp4');
    expect(names(third)[0]).toBe('成片-v1(3).mp4');
    expect(readFileSync(first.json.files[0], 'utf8')).toBe('MARK');
    expect(readdirSync(t.exportDir)).toHaveLength(9);
  });
});
