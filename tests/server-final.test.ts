import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { startApp } from '../src/server/app.js';
import { GOOD_KEY, memoryKeyStore, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
afterEach(async () => { await t?.close(); });

type V = { n: number; status: string; parent?: number };
const versionsOf = async (id: string): Promise<V[]> => (await t.call('GET', `/api/spaces/${id}`)).json.versions;
const statusAt = (id: string, n: number, status: string) => async (): Promise<boolean> => (await versionsOf(id)).find((v) => v.n === n)?.status === status;
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
const upload = (path: string, name: string, body: Buffer | string): Promise<Response> =>
  fetch(`${t.url}${path}`, { method: 'POST', headers: { 'x-filename': encodeURIComponent(name) }, body });

function holdRuns(): () => void {
  let release!: () => void;
  t.control.gate = new Promise<void>((r) => { release = r; });
  return () => { release(); t.control.gate = undefined; };
}

/** 对话规划的假模型：每次记 ¥0.02 */
const planDeps = { planClient: (_key: string, meter: { addTask: (m: string, y: number, l: string) => unknown }) => ({ chatJson: async () => { meter.addTask('fake', 0.02, '修改'); return { reply: '好', ops: [] }; } }) };

describe('项目级预算（I1）', () => {
  it('剩余额度不够必需步骤时 start 返回 402 与中文提示；调高上限后可以开始', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t, { settings: { budgetYuan: 0.04 } }); // 12 秒口播的必需步骤约 ¥0.05
    const r = await t.call('POST', `/api/spaces/${id}/start`);
    expect(r.status).toBe(402);
    expect(r.json.error).toContain('已接近上限 ¥0.04，请在设置里调高上限');
    expect(t.control.calls).toEqual([]);
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { budgetYuan: 1 } })).status).toBe(200);
    expect((await t.call('POST', `/api/spaces/${id}/start`)).status).toBe(202);
  });

  it('出过片后：对话规划与要花钱的修改按剩余额度拦截，不花钱的修改与回退照常', async () => {
    t = await startTestApp({ key: GOOD_KEY, deps: planDeps });
    const id = await spaceWithInput(t, { settings: { budgetYuan: 0.5 } });
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(statusAt(id, 1, 'done')); // 假运行器每版 ¥0.5，正好用完
    const chat = await t.call('POST', `/api/spaces/${id}/messages`, { message: '换个标题' });
    expect(chat.status).toBe(402);
    expect(chat.json.error).toContain('已接近上限 ¥0.5，请在设置里调高上限');
    const cover = await t.call('POST', `/api/spaces/${id}/apply`, { ops: [{ type: 'setCoverStyle', id: 'swiss' }] });
    expect(cover.status).toBe(402);
    expect((await t.call('POST', `/api/spaces/${id}/apply`, { ops: [{ type: 'pace', direction: 'tighter' }] })).status).toBe(202);
    await waitFor(statusAt(id, 2, 'done'));
    expect((await t.call('POST', `/api/spaces/${id}/versions/1/revert`)).status).toBe(202);
    await waitFor(statusAt(id, 3, 'done'));
    // 调高上限后规划照常，花费记进项目
    await t.call('PATCH', `/api/spaces/${id}`, { settings: { budgetYuan: 5 } });
    const ok = await t.call('POST', `/api/spaces/${id}/messages`, { message: '换个标题' });
    expect(ok.status).toBe(200);
    expect((await t.call('GET', `/api/spaces/${id}`)).json).toMatchObject({ chatCostYuan: 0.02, totalCostYuan: 1.52 });
  });

  it('任何时候都能调上限（出片中也行）；其余设置出片中仍不能改', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const release = holdRuns();
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.job?.state === 'running');
    const r = await t.call('PATCH', `/api/spaces/${id}`, { settings: { budgetYuan: 25 } });
    expect(r.status).toBe(200);
    expect(r.json.settings.budgetYuan).toBe(25);
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { broll: false } })).status).toBe(409);
    release();
    await waitFor(statusAt(id, 1, 'done'));
  });
});

describe('首版失败或取消后可以恢复（I3）', () => {
  it('没有 done 版本时可以改设置、增删口播、换背景，再点开始出片；出片中仍然不行', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    t.control.failWith = '没有音轨';
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(statusAt(id, 1, 'failed'));
    t.control.failWith = undefined;
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { captionStyle: 'song', background: { kind: 'preset', id: 'cafe' } } })).status).toBe(200);
    expect((await upload(`/api/spaces/${id}/inputs`, '补一段.mp4', 'ok-more')).status).toBe(201);
    expect((await t.call('DELETE', `/api/spaces/${id}/inputs/0`)).status).toBe(200);
    expect((await upload(`/api/spaces/${id}/background`, 'bg.png', PNG)).status).toBe(201);
    const release = holdRuns();
    expect((await t.call('POST', `/api/spaces/${id}/start`)).json).toMatchObject({ version: 2 });
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.job?.state === 'running');
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { captionStyle: 'blade' } })).status).toBe(409);
    expect((await upload(`/api/spaces/${id}/inputs`, 'x.mp4', 'ok')).status).toBe(409);
    release();
    await waitFor(statusAt(id, 2, 'done'));
    expect((await versionsOf(id)).find((v) => v.n === 2)?.parent).toBeUndefined();
    // 有 done 版本之后照旧拒绝
    expect((await t.call('PATCH', `/api/spaces/${id}`, { settings: { captionStyle: 'blade' } })).status).toBe(409);
  });

  it('首版失败后改了口播：清掉 base/ 里依赖旧口播的分析、剪切与抠像图层', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    t.control.failWith = '炸了';
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(statusAt(id, 1, 'failed'));
    const base = t.app.store.baseDir(id);
    const stale = ['analysis.json', 'audio16k.wav', 'cut.mp4', 'fgr.mp4', 'matte.mp4', 'matte.json', 'source.mp4', 'order.json'];
    for (const f of stale) writeFileSync(join(base, f), 'old');
    mkdirSync(join(base, 'segments'), { recursive: true });
    writeFileSync(join(base, 'segments', 'keep.mp4'), 'cache');
    expect((await upload(`/api/spaces/${id}/inputs`, '新的.mp4', 'ok-new')).status).toBe(201);
    for (const f of stale) expect(existsSync(join(base, f)), f).toBe(false);
    expect(existsSync(join(base, 'segments', 'keep.mp4'))).toBe(true); // 分段缓存按内容命中，不用清
  });
});

describe('服务重启与并发写', () => {
  it('重启时把 running 的版本标失败，并补发 failed 事件（服务重启，任务中断）', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t);
    t.app.store.addVersion(id, { summary: '首个版本', changedShots: [], costYuan: 0, status: 'running' });
    t.app.bus.publish({ t: Date.now(), spaceId: id, version: 1, step: 'compose', message: '渲染 40%' });
    await t.close();
    const again = await startApp({ cfg: { ...loadConfig({}), dataDir: join(t.root, 'data') }, keyStore: memoryKeyStore(GOOD_KEY), webDir: t.webDir }, 0);
    try {
      expect(again.app.store.get(id).versions[0].status).toBe('failed');
      const last = again.app.bus.history(id, 1).at(-1);
      expect(last).toMatchObject({ step: 'failed', message: '服务重启，任务中断', seq: 2 });
    } finally {
      await again.close();
    }
    t = await startTestApp();
  });

  it('PATCH 先读完请求体再取快照写回：读请求体期间完成的版本不被旧快照覆盖', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t);
    t.app.store.addVersion(id, { summary: '首个版本', changedShots: [], costYuan: 0, status: 'running' });
    const url = new URL(`${t.url}/api/spaces/${id}`);
    const done = new Promise<number>((resolve, reject) => {
      const req = request({ host: url.hostname, port: url.port, path: url.pathname, method: 'PATCH', headers: { 'Content-Type': 'application/json' } }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      });
      req.on('error', reject);
      req.write('{"settings":');
      setTimeout(() => {
        t.app.store.updateVersion(id, 1, { status: 'done', costYuan: 0.3 }); // 请求体还没读完时，运行器把版本置 done
        req.end('{"budgetYuan":20}}');
      }, 80);
    });
    expect(await done).toBe(200);
    expect(t.app.store.get(id)).toMatchObject({ settings: { budgetYuan: 20 }, versions: [{ status: 'done', costYuan: 0.3 }] });
  });
});

describe('不外露本机路径', () => {
  it('事件里的项目内绝对路径改成相对路径；项目与版本状态里的自定义背景只给文件名', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t);
    const dir = t.app.store.versionDir(id, 1);
    mkdirSync(dir, { recursive: true });
    t.app.bus.publish({ t: Date.now(), spaceId: id, version: 1, step: 'compose', message: `写入 ${join(dir, 'final.mp4')} 失败`, detail: { kind: 'x', data: { file: join(dir, 'a.png') } } });
    const e = t.app.bus.history(id, 1)[0];
    expect(e.message).toBe('写入 v1/final.mp4 失败');
    expect(e.detail).toEqual({ kind: 'x', data: { file: 'v1/a.png' } });
    const up = await (await upload(`/api/spaces/${id}/background`, '我的背景.png', PNG)).json() as { background: { path: string }; settings: { background: { path: string } } };
    expect(up.background.path).toBe('我的背景.png');
    expect(up.settings.background.path).toBe('我的背景.png');
    expect(t.app.store.get(id).settings.background).toMatchObject({ kind: 'file', path: expect.stringContaining(join(t.root, 'data')) });
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(statusAt(id, 1, 'done'));
    const space = (await t.call('GET', `/api/spaces/${id}`)).json;
    expect(JSON.stringify(space)).not.toContain(t.root);
    const stateFile = join(t.app.store.versionDir(id, 1), 'state.json');
    const saved = JSON.parse(readFileSync(stateFile, 'utf8')) as { settings: Record<string, unknown> };
    writeFileSync(stateFile, JSON.stringify({ ...saved, settings: { ...saved.settings, background: { kind: 'file', path: join(t.root, 'data', 'spaces', id, 'backgrounds', 'x', '底图.png') } } }));
    const state = await t.call('GET', `/api/spaces/${id}/versions/1/state`);
    expect(state.json.settings.background).toEqual({ kind: 'file', path: '底图.png' });
    expect(JSON.stringify(state.json)).not.toContain(t.root);
  });

  it('媒体与缩略图带 Cross-Origin-Resource-Policy: same-origin，别的网页嵌不进去', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(statusAt(id, 1, 'done'));
    const res = await fetch(`${t.url}/media/${id}/1/final.mp4`);
    expect(res.headers.get('cross-origin-resource-policy')).toBe('same-origin');
    await res.arrayBuffer();
  });
});
