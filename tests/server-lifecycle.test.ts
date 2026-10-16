import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Activity, watchIdle } from '../src/server/lifecycle.js';
import type { UpdateInfo } from '../src/server/update.js';
import { GOOD_KEY, spaceWithInput, startTestApp, waitFor, type TestApp } from './server-fixture.js';

const HOUR = 3600_000;
let t: TestApp | undefined;
afterEach(async () => {
  vi.useRealTimers();
  await t?.close();
  t = undefined;
});

/** 让假运行器卡住，返回放行函数 */
function holdRuns(app: TestApp): () => void {
  let release!: () => void;
  app.control.gate = new Promise<void>((r) => { release = r; });
  return () => { release(); app.control.gate = undefined; };
}

describe('Activity 与 watchIdle（假时钟）', () => {
  it('无连接、无任务满 2 小时才触发，且只触发一次', () => {
    vi.useFakeTimers();
    let now = 0;
    const activity = new Activity(() => now);
    const onIdle = vi.fn();
    watchIdle({ activity, busy: () => false, idleMs: 2 * HOUR, checkMs: 60_000, onIdle });
    now = 2 * HOUR - 1;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    now = 2 * HOUR;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
    now = 5 * HOUR;
    vi.advanceTimersByTime(600_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('有连接开着（SSE、长上传）不算空闲；连接关掉后从那一刻重新计时', () => {
    vi.useFakeTimers();
    let now = 0;
    const activity = new Activity(() => now);
    const onIdle = vi.fn();
    watchIdle({ activity, busy: () => false, idleMs: 2 * HOUR, checkMs: 60_000, onIdle });
    const end = activity.begin();
    now = 10 * HOUR;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    end();
    end(); // 重复调用不会把计数减成负数
    now = 12 * HOUR - 1;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    now = 12 * HOUR;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('有任务在跑不算空闲；任务结束后从结束时重新计时', () => {
    vi.useFakeTimers();
    let now = 0;
    let busy = true;
    const activity = new Activity(() => now);
    const onIdle = vi.fn();
    watchIdle({ activity, busy: () => busy, idleMs: 2 * HOUR, checkMs: 60_000, onIdle });
    now = 3 * HOUR;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    busy = false;
    now = 3 * HOUR + 60_000;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).not.toHaveBeenCalled();
    now = 5 * HOUR;
    vi.advanceTimersByTime(60_000);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('停止后不再检查', () => {
    vi.useFakeTimers();
    let now = 0;
    const onIdle = vi.fn();
    const stop = watchIdle({ activity: new Activity(() => now), busy: () => false, idleMs: HOUR, checkMs: 1000, onIdle });
    stop();
    now = 10 * HOUR;
    vi.advanceTimersByTime(10_000);
    expect(onIdle).not.toHaveBeenCalled();
  });
});

describe('POST /api/shutdown', () => {
  it('202 后优雅停止：结束运行中任务、关闭事件流，再以 0 退出', async () => {
    const onExit = vi.fn();
    t = await startTestApp({ key: GOOD_KEY, app: { onExit } });
    const release = holdRuns(t);
    const id = await spaceWithInput(t);
    expect((await t.call('POST', `/api/spaces/${id}/start`)).status).toBe(202);
    await waitFor(async () => (await t!.call('GET', `/api/spaces/${id}`)).json.job?.state === 'running');
    const stream = await fetch(`${t.url}/api/spaces/${id}/events?version=1`);
    const reader = stream.body!.getReader();
    await reader.read();

    const r = await t.call('POST', '/api/shutdown', undefined, { Origin: t.url, 'Sec-Fetch-Site': 'same-origin' });
    expect(r.status).toBe(202);
    expect(r.json).toEqual({ ok: true });
    // 运行器收到取消信号后才放行（假运行器在 gate 上不看信号）
    setTimeout(release, 50);
    await waitFor(() => onExit.mock.calls.length > 0, 5000);
    expect(onExit).toHaveBeenCalledWith(0);
    // 任务被结束：版本记为失败并落盘
    const space = JSON.parse(readFileSync(join(t.root, 'data', 'spaces', id, 'space.json'), 'utf8')) as { versions: { status: string }[] };
    expect(space.versions[0].status).toBe('failed');
    // 事件流被关闭
    for (;;) {
      const chunk = await reader.read().catch(() => ({ done: true }));
      if (chunk.done) break;
    }
    // 不再接受连接
    await expect(fetch(`${t.url}/api/status`)).rejects.toThrow();
  });

  it('没有任务时立即退出；重复触发只退出一次', async () => {
    const onExit = vi.fn();
    t = await startTestApp({ app: { onExit } });
    expect((await t.call('POST', '/api/shutdown')).status).toBe(202);
    t.app.requestShutdown();
    await waitFor(() => onExit.mock.calls.length > 0);
    await new Promise((r) => setTimeout(r, 50));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('跨源请求 403，不退出', async () => {
    const onExit = vi.fn();
    t = await startTestApp({ app: { onExit } });
    const evil = await t.call('POST', '/api/shutdown', undefined, { Origin: 'https://evil.example' });
    expect(evil.status).toBe(403);
    const site = await t.call('POST', '/api/shutdown', undefined, { 'Sec-Fetch-Site': 'cross-site' });
    expect(site.status).toBe(403);
    expect((await t.call('GET', '/api/shutdown')).status).toBe(405);
    await new Promise((r) => setTimeout(r, 50));
    expect(onExit).not.toHaveBeenCalled();
    expect((await t.call('GET', '/api/status')).status).toBe(200);
  });

  it('退出过程中不再接受新任务', async () => {
    t = await startTestApp({ key: GOOD_KEY });
    const release = holdRuns(t);
    const a = await spaceWithInput(t);
    const b = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${a}/start`);
    const stopping = t.app.runs.stopAll(2000);
    const r = await t.call('POST', `/api/spaces/${b}/start`);
    expect(r.status).toBe(503);
    expect(r.json.error).toContain('退出');
    release();
    await stopping;
  });
});

describe('空闲自动退出（服务内，假时钟）', () => {
  it('无请求满 2 小时以 0 退出；期间有 ping 就顺延', async () => {
    let now = 1_000_000;
    const onExit = vi.fn();
    t = await startTestApp({ app: { onExit, now: () => now, idleExitMs: 2 * HOUR, idleCheckMs: 10 } });
    now += HOUR;
    expect((await t.call('GET', '/api/ping')).status).toBe(204);
    now += 2 * HOUR - 1;
    await new Promise((r) => setTimeout(r, 60));
    expect(onExit).not.toHaveBeenCalled();
    now += 1;
    await waitFor(() => onExit.mock.calls.length > 0);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('有任务在跑或事件流开着时不退出', async () => {
    let now = 1_000_000;
    const onExit = vi.fn();
    t = await startTestApp({ key: GOOD_KEY, app: { onExit, now: () => now, idleExitMs: 2 * HOUR, idleCheckMs: 10 } });
    const release = holdRuns(t);
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    const tab = new AbortController();
    const stream = await fetch(`${t.url}/api/spaces/${id}/events?version=1`, { signal: tab.signal });
    const reader = stream.body!.getReader();
    await reader.read();
    now += 10 * HOUR;
    await new Promise((r) => setTimeout(r, 60));
    expect(onExit).not.toHaveBeenCalled();
    release();
    await waitFor(async () => (await t!.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    tab.abort(); // 相当于关掉标签页
    // 等服务端看到事件流关闭：关闭时会记一次活动；之后时钟每走一步 idleFor 才大于 0
    await waitFor(() => { now += 1; return t!.app.activity.idleFor() > 0; });
    now += HOUR;
    await new Promise((r) => setTimeout(r, 60));
    expect(onExit).not.toHaveBeenCalled();
    now += HOUR;
    await waitFor(() => onExit.mock.calls.length > 0);
  });

  it('没配置空闲退出时（测试、开发）不会退出', async () => {
    let now = 0;
    const onExit = vi.fn();
    t = await startTestApp({ app: { onExit, now: () => now } });
    now += 100 * HOUR;
    await new Promise((r) => setTimeout(r, 60));
    expect(onExit).not.toHaveBeenCalled();
  });
});

describe('检查更新：/api/status 与 /api/prefs', () => {
  const INFO: UpdateInfo = { version: '0.2.0', url: 'https://github.com/crawfordxx/mingzhi/releases/tag/v0.2.0', notes: '新功能' };
  const fakeUpdates = (info: UpdateInfo | null) => ({ available: vi.fn(() => info), poke: vi.fn(async () => undefined) });

  it('有新版本时 status 带 update，并顺手触发一次检查', async () => {
    const updates = fakeUpdates(INFO);
    t = await startTestApp({ app: { updates } });
    const r = await t.call('GET', '/api/status');
    expect(r.json.update).toEqual(INFO);
    expect(updates.poke).toHaveBeenCalled();
  });

  it('没有新版本时不带 update 字段', async () => {
    t = await startTestApp({ app: { updates: fakeUpdates(null) } });
    expect((await t.call('GET', '/api/status')).json).not.toHaveProperty('update');
  });

  it('检查更新开关：默认开，可关，写进数据目录；关掉后不再查', async () => {
    const updates = fakeUpdates(null);
    t = await startTestApp({ app: { updates } });
    expect((await t.call('GET', '/api/prefs')).json).toEqual({ checkUpdates: true });
    const off = await t.call('PATCH', '/api/prefs', { checkUpdates: false });
    expect(off.json).toEqual({ checkUpdates: false });
    expect(JSON.parse(readFileSync(join(t.root, 'data', 'prefs.json'), 'utf8'))).toEqual({ checkUpdates: false });
    expect((await t.call('GET', '/api/prefs')).json).toEqual({ checkUpdates: false });
    updates.poke.mockClear();
    const on = await t.call('PATCH', '/api/prefs', { checkUpdates: true });
    expect(on.json).toEqual({ checkUpdates: true });
    expect(updates.poke).toHaveBeenCalled();
  });

  it('开关参数不对 400', async () => {
    t = await startTestApp();
    expect((await t.call('PATCH', '/api/prefs', { checkUpdates: 'no' })).status).toBe(400);
    expect((await t.call('PATCH', '/api/prefs', { other: 1 })).status).toBe(400);
  });
});

describe('真实进程（src/server/index.ts）', () => {
  /** 起一个真实服务进程（假模式：不查更新、不调模型），返回地址与退出码 */
  async function spawnServer(): Promise<{ url: string; child: ChildProcess; exited: Promise<number | null> }> {
    const dataDir = mkdtempSync(join(tmpdir(), 'mz-life-'));
    const env = { ...process.env, MINGZHI_FAKE_LLM: '1', MINGZHI_DATA_DIR: dataDir, MINGZHI_PORT: String(47000 + Math.floor(Math.random() * 2000)) };
    const child = spawn(process.execPath, ['--import', 'tsx', join(__dirname, '..', 'src', 'server', 'index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    const url = await new Promise<string>((resolve, reject) => {
      let out = '';
      child.stdout!.on('data', (d: Buffer) => {
        out += d.toString();
        const m = /已启动：(http:\/\/127\.0\.0\.1:\d+)/.exec(out);
        if (m) resolve(m[1]);
      });
      child.once('exit', () => reject(new Error(`服务没起来：${out}`)));
    });
    return { url, child, exited };
  }

  it('POST /api/shutdown 后进程以 0 退出', async () => {
    const { url, exited } = await spawnServer();
    const r = await fetch(`${url}/api/shutdown`, { method: 'POST', headers: { Origin: url } });
    expect(r.status).toBe(202);
    expect(await exited).toBe(0);
  }, 30_000);

  it('SIGTERM（启动器看门狗）同样优雅停止并以 0 退出', async () => {
    const { child, exited } = await spawnServer();
    child.kill('SIGTERM');
    expect(await exited).toBe(0);
  }, 30_000);
});
