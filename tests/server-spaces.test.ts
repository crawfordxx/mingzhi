import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { probe } from '../src/media/probe.js';
import { makeBackgroundThumb } from '../src/server/thumbs.js';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
const cfg = loadConfig({});
beforeAll(async () => {
  t = await startTestApp({ key: GOOD_KEY, deps: { makeThumb: (src, dest) => makeBackgroundThumb(cfg, src, dest) } });
});
afterAll(async () => { await t.close(); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const upload = (path: string, name: string, body: Buffer | string): Promise<Response> =>
  fetch(`${t.url}${path}`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(name) }, body });

describe('项目设置', () => {
  it('PATCH 改标题与设置；出片前可改背景 / 字幕 / 封面风格', async () => {
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    const r = await t.call('PATCH', `/api/spaces/${id}`, { title: '新标题', settings: { background: { kind: 'prompt', prompt: '海边日落' }, captionStyle: 'minimal', coverStyle: 'swiss', budgetYuan: 20, broll: false } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ title: '新标题', settings: { background: { kind: 'prompt', prompt: '海边日落' }, captionStyle: 'minimal', coverStyle: 'swiss', budgetYuan: 20, broll: false, maxVideos: 1 } });
    const cleared = await t.call('PATCH', `/api/spaces/${id}`, { settings: { background: null } });
    expect(cleared.json.settings.background).toBeUndefined();
    expect((await t.call('GET', `/api/spaces/${id}`)).json.settings.captionStyle).toBe('minimal');
    expect((await t.call('PATCH', `/api/spaces/${id}`, { title: '  ' })).status).toBe(400);
    expect((await t.call('PATCH', `/api/spaces/${id}`, { inputs: [] })).status).toBe(400);
    expect((await t.call('PATCH', '/api/spaces/nope')).status).toBe(404);
    expect((await t.call('GET', '/api/spaces/..')).status).toBe(404);
    expect((await t.call('GET', '/api/spaces/不存在')).status).toBe(404);
  });

  it('预估按设置变化：关闭 B-roll 更便宜', async () => {
    const id = await spaceWithInput(t);
    const on = (await t.call('GET', `/api/spaces/${id}/estimate`)).json;
    await t.call('PATCH', `/api/spaces/${id}`, { settings: { broll: false } });
    const off = (await t.call('GET', `/api/spaces/${id}/estimate`)).json;
    expect(off.high).toBeLessThan(on.high);
  });

  it('出片后不能再改背景 / 字幕 / 封面风格，但可以改预算', async () => {
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { captionStyle: 'song' } })).status).toBe(409);
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { budgetYuan: 30 } })).json.settings.budgetYuan).toBe(30);
  });
});

describe('口播与自定义背景上传', () => {
  it('多段口播按上传顺序；可删除任意一段；出片后不能删', async () => {
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    for (const name of ['a.mp4', 'b.mov', 'c.mp4']) expect((await upload(`/api/spaces/${id}/inputs`, name, 'ok-data')).status).toBe(201);
    expect((await t.call('GET', `/api/spaces/${id}`)).json.inputs).toEqual(['a.mp4', 'b.mov', 'c.mp4']);
    const space = t.app.store.get(id);
    const secondDir = join(space.inputs[1], '..');
    const del = await t.call('DELETE', `/api/spaces/${id}/inputs/1`);
    expect(del.status).toBe(200);
    expect(del.json.inputs).toEqual(['a.mp4', 'c.mp4']);
    expect(existsSync(secondDir)).toBe(false);
    expect((await t.call('DELETE', `/api/spaces/${id}/inputs/5`)).status).toBe(404);
    expect((await t.call('DELETE', `/api/spaces/${id}/inputs/-1`)).status).toBe(404);
    expect((await t.call('DELETE', `/api/spaces/${id}/inputs/abc`)).status).toBe(404);
    // 估算把所有段的时长加起来
    expect((await t.call('GET', `/api/spaces/${id}/estimate`)).json.durationSec).toBe(24);
  });

  it('出片开始后不能删除 / 追加口播', async () => {
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    expect((await t.call('DELETE', `/api/spaces/${id}/inputs/0`)).status).toBe(409);
    expect((await upload(`/api/spaces/${id}/inputs`, 'x.mp4', 'ok')).status).toBe(409);
    expect((await upload(`/api/spaces/${id}/background`, 'x.png', PNG)).status).toBe(409);
  });

  it('自定义背景：只收 jpg / png / webp 且验证文件头，存项目目录，返回 file 类型 spec', async () => {
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    const ok = await upload(`/api/spaces/${id}/background`, '我的 背景.png', PNG);
    expect(ok.status).toBe(201);
    const body = await ok.json() as { background: { kind: string; path: string }; settings: { background: unknown } };
    expect(body.background.kind).toBe('file');
    expect(body.background.path.startsWith(join(t.root, 'data', 'spaces', id, 'backgrounds'))).toBe(true);
    expect(body.settings.background).toEqual(body.background);
    expect(readFileSync(body.background.path).equals(PNG)).toBe(true);
    expect((await upload(`/api/spaces/${id}/background`, 'x.gif', PNG)).status).toBe(400);
    const fake = await upload(`/api/spaces/${id}/background`, 'x.png', 'not an image at all');
    expect(fake.status).toBe(400);
    expect((await fake.json() as { error: string }).error).toContain('图片');
    const big = await upload(`/api/spaces/${id}/background`, 'big.png', Buffer.concat([PNG, Buffer.alloc(15 * 1024 * 1024)]));
    expect(big.status).toBe(413);
  });

  it('PATCH 里的 file 背景必须是本项目上传的图片', async () => {
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    const other = (await t.call('POST', '/api/spaces', {})).json.id as string;
    const mine = ((await (await upload(`/api/spaces/${id}/background`, 'a.png', PNG)).json()) as { background: { path: string } }).background;
    writeFileSync(join(t.root, 'outside.png'), PNG);
    for (const path of [join(t.root, 'outside.png'), '/etc/passwd', join(t.root, 'data', 'spaces', id, '..', 'x.png')]) {
      expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { background: { kind: 'file', path } } })).status, path).toBe(400);
    }
    expect((await t.call('PATCH', `/api/spaces/${other}`, { settings: { background: { kind: 'file', path: mine.path } } })).status).toBe(400);
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { background: { kind: 'file', path: mine.path } } })).status).toBe(200);
  });
});

describe('缩略图、字幕预览与静态页面', () => {
  it('背景缩略图：白名单 id，ffmpeg 缩到 320 宽并缓存', async () => {
    const r = await fetch(`${t.url}/thumbs/backgrounds/study.jpg`);
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toBe('image/jpeg');
    const cached = join(t.root, 'data', 'thumbs', 'backgrounds', 'study.jpg');
    expect(existsSync(cached)).toBe(true);
    expect((await probe(cached, cfg)).width).toBe(320);
    for (const bad of ['nope.jpg', '..%2fstudy.jpg', 'study.png', '%2e%2e.jpg', 'study.jpg.bak']) {
      expect((await fetch(`${t.url}/thumbs/backgrounds/${bad}`)).status, bad).toBe(404);
    }
  });

  it('字幕样式预览：首次请求渲染并缓存到 previews/captions，二次不再渲染', async () => {
    let renders = 0;
    const local = await startTestApp({ deps: { renderCaptionPreview: async (id, dest) => { renders += 1; await new Promise((r) => setTimeout(r, 30)); writeFileSync(dest, `png-${id}`); } } });
    try {
      const [a, b] = await Promise.all([fetch(`${local.url}/previews/captions/blade.png`), fetch(`${local.url}/previews/captions/blade.png`)]);
      expect(a.status).toBe(200);
      expect(await a.text()).toBe('png-blade');
      expect(await b.text()).toBe('png-blade');
      expect(renders).toBe(1);
      await fetch(`${local.url}/previews/captions/blade.png`);
      expect(renders).toBe(1);
      expect(existsSync(join(local.root, 'data', 'previews', 'captions', 'blade.png'))).toBe(true);
      expect((await fetch(`${local.url}/previews/captions/nope.png`)).status).toBe(404);
      expect((await fetch(`${local.url}/previews/captions/%2e%2e.png`)).status).toBe(404);
    } finally {
      await local.close();
    }
  });

  it('预览渲染失败（如字体未下载）返回中文错误而不是挂起', async () => {
    const local = await startTestApp({ deps: { renderCaptionPreview: async () => { throw new Error('字体还没有下载'); } } });
    try {
      const r = await fetch(`${local.url}/previews/captions/blade.png`);
      expect(r.status).toBe(500);
      expect(((await r.json()) as { error: string }).error).toContain('字体还没有下载');
    } finally {
      await local.close();
    }
  });

  it('静态托管 web/dist：根、资源、单页回退；缺失的资源文件 404；穿越 404', async () => {
    expect((await fetch(`${t.url}/`)).headers.get('content-type')).toContain('text/html');
    expect(await (await fetch(`${t.url}/assets/app.js`)).text()).toBe('console.log(1)');
    expect((await fetch(`${t.url}/assets/app.js`)).headers.get('cache-control')).toContain('immutable');
    expect((await fetch(`${t.url}/space/abc`)).status).toBe(200);
    expect((await fetch(`${t.url}/missing.js`)).status).toBe(404);
    expect((await fetch(`${t.url}/%2e%2e/secret.txt`)).status).toBe(404);
    expect((await fetch(`${t.url}/assets/%2e%2e%2f%2e%2e%2fsecret.txt`)).status).toBe(404);
  });
});
