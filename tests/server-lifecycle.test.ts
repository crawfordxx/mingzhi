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

describe('Activity 与 watchIdle（假时钟：定时器与系统时间一起走）', () => {
  const MIN = 60_000;
  /** 起一个 2 小时空闲、每分钟检查的监视器；Activity 与 watchIdle 都读被 vitest 接管的 Date.now */
  function setup(busy: () => boolean = () => false) {
    vi.useFakeTimers();
    const activity = new Activity(() => Date.now());
    const onIdle = vi.fn();
    const stop = watchIdle({ activity, busy, idleMs: 2 * HOUR, checkMs: MIN, onIdle });
    return { activity, onIdle, stop };
  }

  it('无连接、无任务满 2 小时才触发，且只触发一次', () => {
    const { onIdle } = setup();
    vi.advanceTimersByTime(2 * HOUR - MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(5 * HOUR);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('有连接开着（SSE、长上传）不算空闲；连接关掉后从那一刻重新计时', () => {
    const { activity, onIdle } = setup();
    const end = activity.begin();
    vi.advanceTimersByTime(10 * HOUR);
    expect(onIdle).not.toHaveBeenCalled();
    end();
    end(); // 重复调用不会把计数减成负数
    vi.advanceTimersByTime(2 * HOUR - MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('有任务在跑不算空闲；任务结束后从结束时重新计时', () => {
    let busy = true;
    const { onIdle } = setup(() => busy);
    vi.advanceTimersByTime(3 * HOUR);
    expect(onIdle).not.toHaveBeenCalled();
    busy = false;
    vi.advanceTimersByTime(2 * HOUR - MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('电脑睡眠后唤醒：系统时间跳了 8 小时但定时器只推进一次，这一轮不退出，给页面时间 ping', () => {
    const { activity, onIdle } = setup();
    vi.advanceTimersByTime(10 * MIN);
    vi.setSystemTime(Date.now() + 8 * HOUR); // 睡眠期间墙上时钟前进，定时器不走
    vi.advanceTimersByTime(MIN); // 唤醒后的第一轮检查
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN); // 下一轮：唤醒才 1 分钟，仍不退出
    expect(onIdle).not.toHaveBeenCalled();
    activity.begin()(); // 页面恢复后的 ping
    vi.advanceTimersByTime(2 * HOUR - MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('唤醒后页面没回来：从唤醒时起满 2 小时再退出', () => {
    const { onIdle } = setup();
    vi.setSystemTime(Date.now() + 8 * HOUR);
    vi.advanceTimersByTime(MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2 * HOUR - MIN);
    expect(onIdle).not.toHaveBeenCalled();
    vi.advanceTimersByTime(MIN);
    expect(onIdle).toHaveBeenCalledTimes(1);
  });

  it('停止后不再检查', () => {
    const { onIdle, stop } = setup();
    stop();
    vi.advanceTimersByTime(10 * HOUR);
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

describe('空闲自动退出（服务内，真实时间缩短：空闲 1 秒、每 25ms 检查；计时逻辑见上面的假时钟单测）', () => {
  const IDLE = { idleExitMs: 1000, idleCheckMs: 25 };
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('有 ping 就顺延；不再 ping 后以 0 退出', async () => {
    const onExit = vi.fn();
    t = await startTestApp({ app: { onExit, ...IDLE } });
    for (let i = 0; i < 6; i += 1) {
      await sleep(250);
      expect((await t.call('GET', '/api/ping')).status).toBe(204);
    }
    expect(onExit).not.toHaveBeenCalled();
    await waitFor(() => onExit.mock.calls.length > 0, 5000);
    expect(onExit).toHaveBeenCalledWith(0);
  });

  it('有任务在跑或事件流开着时不退出；都结束后才退出', async () => {
    const onExit = vi.fn();
    t = await startTestApp({ key: GOOD_KEY, app: { onExit, ...IDLE } });
    const release = holdRuns(t);
    const id = await spaceWithInput(t);
    await t.call('POST', `/api/spaces/${id}/start`);
    const tab = new AbortController();
    const stream = await fetch(`${t.url}/api/spaces/${id}/events?version=1`, { signal: tab.signal });
    await stream.body!.getReader().read();
    await sleep(1500);
    expect(onExit).not.toHaveBeenCalled();
    release();
    await waitFor(async () => (await t!.call('GET', `/api/spaces/${id}`)).json.versions[0]?.status === 'done');
    await sleep(1200);
    expect(onExit).not.toHaveBeenCalled(); // 事件流还开着
    tab.abort(); // 相当于关掉标签页
    await waitFor(() => onExit.mock.calls.length > 0, 5000);
  });

  it('没配置空闲退出时（测试、开发）不会退出', async () => {
    const onExit = vi.fn();
    t = await startTestApp({ app: { onExit } });
    await sleep(1200);
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
