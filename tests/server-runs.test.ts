import { afterEach, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

let t: TestApp;
afterEach(async () => { await t.close(); });

const versionsOf = async (id: string): Promise<{ n: number; status: string; summary: string; parent?: number }[]> => (await t.call('GET', `/api/spaces/${id}`)).json.versions;
const finished = (id: string, n: number) => async (): Promise<boolean> => (await versionsOf(id)).find((v) => v.n === n)?.status === 'done';

async function firstDone(): Promise<string> {
  const id = await spaceWithInput(t);
  await t.call('POST', `/api/spaces/${id}/start`);
  await waitFor(finished(id, 1));
  return id;
}

/** 让假运行器卡住，返回放行函数 */
function holdRuns(): () => void {
  let release!: () => void;
  t.control.gate = new Promise<void>((r) => { release = r; });
  return () => { release(); t.control.gate = undefined; };
}

describe('开始出片的前置检查', () => {
  it('没有 key 400；key 来自环境变量时优先于 KeyStore', async () => {
    t = await startTestApp();
    const id = await spaceWithInput(t);
    const r = await t.call('POST', `/api/spaces/${id}/start`);
    expect(r.status).toBe(400);
    expect(r.json.error).toContain('key');
    await t.close();
    t = await startTestApp({ env: 'env-key-0123456789', key: 'store-key-0123456789' });
    expect((await t.call('GET', '/api/key')).json).toMatchObject({ configured: true, source: 'env', masked: '…6789' });
    t.keyStore.clear();
    expect((await t.call('GET', '/api/status')).json.keyConfigured).toBe(true);
  });

  it('重复开始：同一项目排队或运行中 409；出过片后再 start 409', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const release = holdRuns();
    const id = await spaceWithInput(t);
    expect((await t.call('POST', `/api/spaces/${id}/start`)).status).toBe(202);
    const dup = await t.call('POST', `/api/spaces/${id}/start`);
    expect(dup.status).toBe(409);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.job?.state === 'running');
    expect((await t.call('GET', `/api/spaces/${id}`)).json.job).toEqual({ state: 'running', version: 1 });
    // 出片期间不能改口播
    const up = await fetch(`${t.url}/api/spaces/${id}/inputs`, { method: 'POST', headers: { 'x-filename': 'b.mp4' }, body: 'ok' });
    expect(up.status).toBe(409);
    release();
    await waitFor(finished(id, 1));
    expect((await t.call('POST', `/api/spaces/${id}/start`)).status).toBe(409);
  });
});

describe('排队与取消', () => {
  it('不同项目串行：第二个排队；排队中取消不留版本，也不留事件痕迹', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const release = holdRuns();
    const a = await spaceWithInput(t);
    const b = await spaceWithInput(t);
    expect((await t.call('POST', `/api/spaces/${a}/start`)).json).toEqual({ version: 1, queued: 0 });
    const queued = await t.call('POST', `/api/spaces/${b}/start`);
    expect(queued.json).toEqual({ version: 1, queued: 1 });
    expect((await t.call('GET', `/api/spaces/${b}`)).json.job).toEqual({ state: 'queued', version: 1 });
    const cancelled = await t.call('POST', `/api/spaces/${b}/cancel`);
    expect(cancelled.json).toEqual({ cancelled: true });
    expect((await t.call('GET', `/api/spaces/${b}`)).json).toMatchObject({ job: null, versions: [] });
    expect(existsSync(join(t.root, 'data', 'spaces', b, 'v1'))).toBe(false);
    expect((await t.call('POST', `/api/spaces/${b}/cancel`)).status).toBe(409);
    release();
    await waitFor(finished(a, 1));
    // b 重新开始，版本 1 的事件里没有上次取消的残留
    t.control.gate = undefined;
    expect((await t.call('POST', `/api/spaces/${b}/start`)).json.version).toBe(1);
    await waitFor(finished(b, 1));
    const history = t.app.bus.history(b, 1).map((e) => e.step);
    expect(history).toEqual(['probe', 'done']);
  });

  it('运行中取消：版本置为失败，事件里有「已取消」', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const release = holdRuns();
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await t.call('GET', `/api/spaces/${id}`)).json.job?.state === 'running');
    expect((await t.call('POST', `/api/spaces/${id}/cancel`)).json).toEqual({ cancelled: true });
    release();
    await waitFor(async () => (await versionsOf(id))[0]?.status === 'failed');
    await waitFor(() => t.app.bus.history(id, 1).some((e) => e.step === 'failed'));
    expect(t.app.bus.history(id, 1).find((e) => e.step === 'failed')?.message).toBe('已取消');
    expect((await t.call('GET', `/api/spaces/${id}`)).json.job).toBeNull();
  });

  it('运行失败后可以重新开始', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    t.control.failWith = '剪辑失败';
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    await waitFor(async () => (await versionsOf(id))[0]?.status === 'failed');
    t.control.failWith = undefined;
    expect((await t.call('POST', `/api/spaces/${id}/start`)).json.version).toBe(2);
    await waitFor(finished(id, 2));
  });

  it('服务重启后，上次没跑完的版本记为失败', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    t.app.store.addVersion(id, { summary: '残留', changedShots: [], costYuan: 0, status: 'running' });
    const { createApp } = await import('../src/server/app.js');
    const again = createApp({ cfg: t.app.cfg, keyStore: t.keyStore });
    expect(again.app.store.get(id).versions[0].status).toBe('failed');
  });
});

describe('对话修改', () => {
  it('messages 返回 EditPlan，默认基于最新完成版本', async () => {
    t = await startTestApp({
      key: GOOD_KEY,
      deps: { planClient: () => ({ chatJson: async () => ({ reply: '好的，换成宋韵', ops: [{ type: 'setCaptionStyle', id: 'song' }], options: [{ label: '备选', ops: [{ type: 'pace', direction: 'tighter' }] }] }) }) },
    });
    const id = await firstDone();
    const r = await t.call('POST', `/api/spaces/${id}/messages`, { message: '字幕换成宋体' });
    expect(r.status).toBe(200);
    expect(r.json).toEqual({ reply: '好的，换成宋韵', ops: [{ type: 'setCaptionStyle', id: 'song' }], options: [{ label: '备选', ops: [{ type: 'pace', direction: 'tighter' }] }], version: 1, costYuan: 0, chatCostYuan: 0 });
    expect((await t.call('POST', `/api/spaces/${id}/messages`, { message: '  ' })).status).toBe(400);
    expect((await t.call('POST', `/api/spaces/${id}/messages`, { message: 'x'.repeat(2001) })).status).toBe(400);
    expect((await t.call('POST', `/api/spaces/${id}/messages`, { message: '改', version: 9 })).status).toBe(404);
  });

  it('apply：ops 先过 validateOps，非法的丢弃并报告；全非法 400；最多 20 个', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await firstDone();
    const mixed = [{ type: 'setCaptionStyle', id: 'song' }, { type: 'setCaptionStyle', id: 'nope' }, { type: 'rm -rf' }, { type: 'setBackground', spec: { kind: 'file', path: '/etc/passwd' } }];
    const r = await t.call('POST', `/api/spaces/${id}/apply`, { ops: mixed, summary: '换宋体' });
    expect(r.status).toBe(202);
    expect(r.json.version).toBe(2);
    expect(r.json.dropped).toHaveLength(3);
    await waitFor(finished(id, 2));
    expect(t.control.calls.at(-1)).toEqual({ kind: 'next', parent: 1, ops: [{ type: 'setCaptionStyle', id: 'song' }], summary: '换宋体' });
    expect((await versionsOf(id))[1]).toMatchObject({ n: 2, parent: 1, summary: '换宋体' });

    const none = await t.call('POST', `/api/spaces/${id}/apply`, { ops: [{ type: 'nope' }] });
    expect(none.status).toBe(400);
    expect(none.json.error).toContain('没有可执行的修改');
    const many = await t.call('POST', `/api/spaces/${id}/apply`, { ops: Array.from({ length: 21 }, () => ({ type: 'pace', direction: 'tighter' })) });
    expect(many.status).toBe(400);
    expect(many.json.error).toContain('最多');
    expect((await t.call('POST', `/api/spaces/${id}/apply`, { ops: [] })).status).toBe(400);
    expect((await t.call('POST', `/api/spaces/${id}/apply`, { ops: 'x' })).status).toBe(400);
    expect(t.control.calls.filter((c) => c.kind === 'next')).toHaveLength(1);
  });

  it('apply 可指定 parent；revert 传空 ops 并带摘要', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = await firstDone();
    await t.call('POST', `/api/spaces/${id}/apply`, { ops: [{ type: 'pace', direction: 'tighter' }] });
    await waitFor(finished(id, 2));
    const r = await t.call('POST', `/api/spaces/${id}/versions/1/revert`);
    expect(r.status).toBe(202);
    expect(r.json.version).toBe(3);
    await waitFor(finished(id, 3));
    expect(t.control.calls.at(-1)).toEqual({ kind: 'next', parent: 1, ops: [], summary: '回退到 v1' });
    expect((await t.call('POST', `/api/spaces/${id}/versions/7/revert`)).status).toBe(404);
    expect((await t.call('POST', `/api/spaces/${id}/versions/abc/revert`)).status).toBe(404);
    const withParent = await t.call('POST', `/api/spaces/${id}/apply`, { parent: 1, ops: [{ type: 'pace', direction: 'looser' }] });
    expect(withParent.json.version).toBe(4);
    await waitFor(finished(id, 4));
    expect(t.control.calls.at(-1)?.parent).toBe(1);
  });

  it('版本没完成时不能修改 / 导出', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const id = (await t.call('POST', '/api/spaces', {})).json.id as string;
    expect((await t.call('POST', `/api/spaces/${id}/apply`, { ops: [{ type: 'pace', direction: 'tighter' }] })).status).toBe(409);
    expect((await t.call('POST', `/api/spaces/${id}/versions/1/export`)).status).toBe(404);
  });
});
