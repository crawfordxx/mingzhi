import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
beforeAll(async () => { t = await startTestApp(); });
afterAll(async () => { await t.close(); });

describe('状态、key 与选项', () => {
  it('status 反映 key 与素材就绪', async () => {
    const r = await t.call('GET', '/api/status');
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ keyConfigured: false, version: '0.1.0' });
    expect(typeof r.json.modelsReady).toBe('boolean');
    expect(typeof r.json.assetsReady).toBe('boolean');
  });

  it('key：无效 400、暂时无法校验 503（不是「无效」）、有效才保存，且响应不含完整 key', async () => {
    expect((await t.call('GET', '/api/key')).json).toEqual({ configured: false });
    const bad = await t.call('POST', '/api/key', { key: 'sk-wrong0000000' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toContain('无效');
    const net = await t.call('POST', '/api/key', { key: 'neterr' });
    expect(net.status).toBe(503);
    expect(net.json.error).toContain('暂时无法校验');
    expect(net.json.error).not.toContain('无效');
    expect(t.keyStore.value()).toBeNull();
    const ok = await t.call('POST', '/api/key', { key: GOOD_KEY });
    expect(ok.status).toBe(200);
    expect(ok.text).not.toContain(GOOD_KEY);
    expect(ok.json).toMatchObject({ configured: true, masked: 'sk-…7890' });
    expect(t.keyStore.value()).toBe(GOOD_KEY);
    expect((await t.call('GET', '/api/status')).json.keyConfigured).toBe(true);
    expect((await t.call('DELETE', '/api/key')).status).toBe(204);
    expect(t.keyStore.value()).toBeNull();
  });

  it('options：背景、字幕样式、封面风格的缩略图 / 预览 / 示例 URL', async () => {
    const r = await t.call('GET', '/api/options');
    expect(r.json.backgrounds).toHaveLength(10);
    expect(r.json.backgrounds[0]).toEqual({ id: 'study', name: '书房', thumb: '/thumbs/backgrounds/study.jpg' });
    expect(r.json.captionStyles).toHaveLength(6);
    expect(r.json.captionStyles[0]).toEqual({ id: 'blade', name: '刀锋', preview: '/previews/captions/blade.png' });
    expect(r.json.coverStyles).toHaveLength(10);
    expect(r.json.coverStyles[0]).toMatchObject({ id: 'bauhaus', example: '/covers/bauhaus.webp' });
  });
});

describe('创建 → 上传 → 预估 → 出片 → 看 → 导出', () => {
  it('走一遍', async () => {
    await t.call('POST', '/api/key', { key: GOOD_KEY });
    const created = await t.call('POST', '/api/spaces', { title: '我的口播/第1期', settings: { background: { kind: 'preset', id: 'study' }, captionStyle: 'song', coverStyle: 'neon' } });
    expect(created.status).toBe(201);
    const id = created.json.id as string;
    expect(created.json).toMatchObject({ title: '我的口播/第1期', inputs: [], versions: [], job: null, settings: { captionStyle: 'song', coverStyle: 'neon', budgetYuan: 10, broll: true, maxVideos: 1 } });
    expect((await t.call('GET', '/api/spaces')).json.map((s: { id: string }) => s.id)).toContain(id);

    expect((await t.call('GET', `/api/spaces/${id}/estimate`)).json.error).toContain('还没有上传');
    expect((await t.call('POST', `/api/spaces/${id}/start`)).status).toBe(400);

    const up = await fetch(`${t.url}/api/spaces/${id}/inputs`, { method: 'POST', headers: { 'x-filename': encodeURIComponent('../../口播 样片.mp4') }, body: Buffer.from('ok-video-bytes') });
    const upJson = await up.json() as { inputs: string[]; uploaded: { name: string; durationSec: number } };
    expect(up.status).toBe(201);
    expect(upJson.inputs).toEqual(['口播 样片.mp4']);
    expect(upJson.uploaded).toMatchObject({ name: '口播 样片.mp4', durationSec: 12, bytes: 14 });

    const est = await t.call('GET', `/api/spaces/${id}/estimate`);
    expect(est.status).toBe(200);
    expect(est.json).toMatchObject({ durationSec: 12, budgetYuan: 10 });
    expect(est.json.high).toBeGreaterThan(est.json.low);
    expect(est.json.items.length).toBeGreaterThan(3);
    expect(est.json.text).toContain('预估花费');

    const started = await t.call('POST', `/api/spaces/${id}/start`);
    expect(started.status).toBe(202);
    expect(started.json).toEqual({ version: 1, queued: 0 });
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    const space = (await t.call('GET', `/api/spaces/${id}`)).json;
    expect(space).toMatchObject({ job: null, totalCostYuan: 0.5 });
    expect(t.control.calls).toEqual([{ kind: 'first' }]);
    expect((await t.call('POST', `/api/spaces/${id}/start`)).status).toBe(409);

    // 成片 Range → 206
    const range = await fetch(`${t.url}/media/${id}/1/final.mp4`, { headers: { Range: 'bytes=10-19' } });
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 10-19/1000');
    expect(range.headers.get('content-type')).toBe('video/mp4');
    expect((await range.arrayBuffer()).byteLength).toBe(10);
    const full = await fetch(`${t.url}/media/${id}/1/final.mp4`);
    expect(full.status).toBe(200);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect((await fetch(`${t.url}/media/${id}/1/final.mp4`, { headers: { Range: 'bytes=5000-' } })).status).toBe(416);
    expect((await fetch(`${t.url}/media/${id}/1/cover-3x4.png`)).headers.get('content-type')).toBe('image/png');

    // 版本状态
    const state = await t.call('GET', `/api/spaces/${id}/versions/1/state`);
    expect(state.json.storyboard.shots.length).toBeGreaterThan(0);

    // 导出：标题里的 / 被换掉
    const exp = await t.call('POST', `/api/spaces/${id}/versions/1/export`);
    expect(exp.status).toBe(200);
    expect(exp.json.files.map((f: string) => f.slice(t.exportDir.length + 1))).toEqual(['我的口播_第1期-v1.mp4', '我的口播_第1期-v1-封面3x4.png', '我的口播_第1期-v1-封面4x3.png']);
    expect(readFileSync(join(t.exportDir, '我的口播_第1期-v1.mp4')).length).toBe(1000);
  });

  it('SSE：先补发历史，再推实时，按 seq 去重', async () => {
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    // 历史：probe + done
    const res = await fetch(`${t.url}/api/spaces/${id}/events?version=1`);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const read = async (until: (b: string) => boolean): Promise<void> => {
      while (!until(buf)) buf += decoder.decode((await reader.read()).value);
    };
    await read((b) => b.split('\n\n').filter((x) => x.startsWith('id:') || x.includes('\nid:')).length >= 2);
    const events = [...buf.matchAll(/id: (\d+)\ndata: (.+)\n/g)].map((m) => ({ seq: Number(m[1]), ...JSON.parse(m[2]) }));
    expect(events.map((e) => e.step)).toEqual(['probe', 'done']);
    expect(events.map((e) => e.seq)).toEqual([1, 2]);
    // 实时：发布一条新事件，只收到一次
    const app = t.app;
    app.bus.publish({ t: Date.now(), spaceId: id, version: 1, step: 'qa-final', message: '实时' });
    app.bus.publish({ t: Date.now(), spaceId: id, version: 2, step: 'qa-final', message: '别的版本' });
    await read((b) => b.includes('实时'));
    expect(buf.match(/实时/g)).toHaveLength(1);
    expect(buf).not.toContain('别的版本');
    await reader.cancel();
  });

  it('SSE 带 Last-Event-ID 只补它之后的', async () => {
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    const res = await fetch(`${t.url}/api/spaces/${id}/events?version=1`, { headers: { 'Last-Event-ID': '1' } });
    const reader = res.body!.getReader();
    let buf = '';
    while (!buf.includes('data:')) buf += new TextDecoder().decode((await reader.read()).value);
    expect(buf).toContain('"step":"done"');
    expect(buf).not.toContain('"step":"probe"');
    await reader.cancel();
  });

  it('项目目录里没有留下上传的 .part 临时文件', async () => {
    const id = await spaceWithInput(t);
    const dir = join(t.root, 'data', 'spaces', id, 'inputs');
    expect(existsSync(dir)).toBe(true);
    expect(readdirSync(dir, { recursive: true }).filter((f) => String(f).endsWith('.part'))).toEqual([]);
    const names = (await t.call('GET', `/api/spaces/${id}`)).json.inputs as string[];
    expect(names).toEqual(['口播.mp4']);
  });
});
