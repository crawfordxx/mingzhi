import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SpaceStore } from '../src/workspace/store.js';
import { EventBus, toWorkEvent, type WorkEvent, type WorkEventInput } from '../src/workspace/events.js';
import { JobQueue, type Job } from '../src/workspace/jobs.js';

const ev = (spaceId: string, version: number, step: WorkEvent['step'], message: string, extra: Partial<WorkEventInput> = {}): WorkEventInput =>
  ({ t: 1, spaceId, version, step, message, ...extra });

const newStore = (): SpaceStore => new SpaceStore(mkdtempSync(join(tmpdir(), 'mz-jobs-')));
const SETTINGS = { captionStyle: 'blade', budgetYuan: 10, broll: false, maxVideos: 0 } as const;
const makeJob = (spaceId: string, version = 1): Job => ({ spaceId, version, args: {} as Job['args'] });
/** 让出事件循环若干轮，等排队里的异步任务推进 */
const tick = async (n = 5): Promise<void> => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };
const deferred = (): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } => {
  let resolve!: () => void; let reject!: (e: Error) => void;
  const promise = new Promise<void>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

describe('EventBus', () => {
  it('按项目订阅：只收到本项目的事件，退订后不再收到', () => {
    const store = newStore();
    const bus = new EventBus((id, n) => store.versionDir(id, n));
    const a: WorkEvent[] = []; const b: WorkEvent[] = [];
    const offA = bus.subscribe('aaa', (e) => a.push(e));
    bus.subscribe('bbb', (e) => b.push(e));
    bus.publish(ev('aaa', 1, 'probe', '一'));
    bus.publish(ev('bbb', 1, 'probe', '二'));
    offA();
    bus.publish(ev('aaa', 1, 'asr', '三'));
    expect(a.map((e) => e.message)).toEqual(['一']);
    expect(b.map((e) => e.message)).toEqual(['二']);
  });

  it('一个订阅者抛错不影响其他订阅者与落盘', () => {
    const store = newStore();
    const bus = new EventBus((id, n) => store.versionDir(id, n));
    const got: string[] = [];
    bus.subscribe('s1', () => { throw new Error('坏订阅者'); });
    bus.subscribe('s1', (e) => got.push(e.message));
    bus.publish(ev('s1', 1, 'probe', '照常'));
    expect(got).toEqual(['照常']);
    expect(bus.history('s1', 1).map((e) => e.message)).toEqual(['照常']);
  });

  it('事件追加写入 versionDir/events.jsonl，history 按顺序读回（含 detail）', () => {
    const store = newStore();
    const space = store.create('t', ['/tmp/a.mp4'], SETTINGS);
    const { n } = store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'running' });
    const bus = new EventBus((id, v) => store.versionDir(id, v));
    bus.publish(ev(space.id, n, 'asr', '识别', { detail: { kind: 'transcript', data: { lines: [{ start: 0, end: 1, text: '你好' }] } } }));
    bus.publish(ev(space.id, n, 'cuts', '剪口误'));
    const lines = readFileSync(join(store.versionDir(space.id, n), 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    // 用全新的 EventBus 读取，模拟服务重启后重播
    const replay = new EventBus((id, v) => store.versionDir(id, v)).history(space.id, n);
    expect(replay.map((e) => e.step)).toEqual(['asr', 'cuts']);
    expect(replay[0].detail).toEqual({ kind: 'transcript', data: { lines: [{ start: 0, end: 1, text: '你好' }] } });
  });

  it('history：版本没有事件文件时返回空数组；损坏的行（如写到一半）被跳过', () => {
    const store = newStore();
    const space = store.create('t', [], SETTINGS);
    const { n } = store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'running' });
    const bus = new EventBus((id, v) => store.versionDir(id, v));
    expect(bus.history(space.id, n)).toEqual([]);
    bus.publish(ev(space.id, n, 'probe', '好'));
    appendFileSync(join(store.versionDir(space.id, n), 'events.jsonl'), '{"t":1,"spaceId":"x"');
    expect(bus.history(space.id, n).map((e) => e.message)).toEqual(['好']);
  });

  it('不同版本的事件写入各自目录，互不串', () => {
    const store = newStore();
    const space = store.create('t', [], SETTINGS);
    store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'done' });
    store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'running' });
    const bus = new EventBus((id, v) => store.versionDir(id, v));
    bus.publish(ev(space.id, 1, 'done', 'v1'));
    bus.publish(ev(space.id, 2, 'probe', 'v2'));
    expect(bus.history(space.id, 1).map((e) => e.message)).toEqual(['v1']);
    expect(bus.history(space.id, 2).map((e) => e.message)).toEqual(['v2']);
  });

  it('seq：每个「项目+版本」内从 1 起单调递增，history 回放也带；换一个 EventBus（模拟重启）后继续往后编号', () => {
    const store = newStore();
    const space = store.create('t', [], SETTINGS);
    store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'done' });
    store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'running' });
    const dirOf = (id: string, v: number): string => store.versionDir(id, v);
    const bus = new EventBus(dirOf);
    const got: number[] = [];
    bus.subscribe(space.id, (e) => got.push(e.seq));
    expect(bus.publish(ev(space.id, 1, 'probe', 'a')).seq).toBe(1);
    bus.publish(ev(space.id, 1, 'asr', 'b'));
    expect(bus.publish(ev(space.id, 2, 'probe', 'c')).seq).toBe(1); // 另一个版本重新从 1 起
    expect(got).toEqual([1, 2, 1]);
    expect(bus.history(space.id, 1).map((e) => e.seq)).toEqual([1, 2]);
    const restarted = new EventBus(dirOf);
    expect(restarted.publish(ev(space.id, 1, 'cuts', 'd')).seq).toBe(3);
    expect(restarted.history(space.id, 1).map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  it('history：不是对象或缺字段的行（null、数字、数组、缺 step）被跳过并告警', () => {
    const store = newStore();
    const space = store.create('t', [], SETTINGS);
    const { n } = store.addVersion(space.id, { summary: '', changedShots: [], costYuan: 0, status: 'running' });
    const bus = new EventBus((id, v) => store.versionDir(id, v));
    bus.publish(ev(space.id, n, 'probe', '好'));
    appendFileSync(join(store.versionDir(space.id, n), 'events.jsonl'), 'null\n123\n[1]\n{"message":"缺 step"}\n');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(bus.history(space.id, n).map((e) => e.message)).toEqual(['好']);
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });

  it('目录不可写时 publish 不抛错、订阅者仍收到事件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mz-jobs-'));
    const blocker = join(dir, 'file');
    writeFileSync(blocker, 'x');
    const bus = new EventBus(() => join(blocker, 'sub')); // 在文件下建目录必然失败
    const got: string[] = [];
    bus.subscribe('s', (e) => got.push(e.message));
    expect(() => bus.publish(ev('s', 1, 'probe', '仍然送达'))).not.toThrow();
    expect(got).toEqual(['仍然送达']);
  });

  it('toWorkEvent：把流程进度事件补上项目、版本与时间', () => {
    const e = toWorkEvent('s1', 2, { step: 'matte', message: '抠像 1/2 帧', detail: { kind: 'progress', data: { pct: 50 } } }, 123);
    expect(e).toEqual({ t: 123, spaceId: 's1', version: 2, step: 'matte', message: '抠像 1/2 帧', detail: { kind: 'progress', data: { pct: 50 } } });
    expect('detail' in toWorkEvent('s1', 2, { step: 'asr', message: 'x' }, 1)).toBe(false);
  });
});

describe('JobQueue', () => {
  it('两个任务串行：第二个等第一个结束才开始，排队位置依次为 0、1', async () => {
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof deferred>>([['a', deferred()], ['b', deferred()]]);
    const q = new JobQueue(async (job) => {
      order.push(`开始 ${job.spaceId}`);
      await gates.get(job.spaceId)?.promise;
      order.push(`结束 ${job.spaceId}`);
    });
    expect(q.enqueue(makeJob('a'))).toBe(0);
    expect(q.enqueue(makeJob('b'))).toBe(1);
    expect(q.current()?.spaceId).toBe('a');
    await tick();
    expect(order).toEqual(['开始 a']);
    gates.get('a')?.resolve();
    await tick();
    expect(order).toEqual(['开始 a', '结束 a', '开始 b']);
    expect(q.current()?.spaceId).toBe('b');
    gates.get('b')?.resolve();
    await tick();
    expect(q.current()).toBeNull();
  });

  it('同一项目已有任务（排队或运行中）时拒绝再入队', async () => {
    const gate = deferred();
    const q = new JobQueue(() => gate.promise);
    q.enqueue(makeJob('a'));
    expect(() => q.enqueue(makeJob('a', 2))).toThrow('已有任务');
    gate.resolve();
    await tick();
    expect(q.enqueue(makeJob('a', 2))).toBe(0);
  });

  it('失败不阻塞后续任务，并发布 failed 事件；排队中的任务发布 queued 事件', async () => {
    const store = newStore();
    const bus = new EventBus((id, n) => store.versionDir(id, n));
    const seen: WorkEvent[] = [];
    bus.subscribe('a', (e) => seen.push(e));
    bus.subscribe('b', (e) => seen.push(e));
    const gate = deferred();
    const ran: string[] = [];
    const q = new JobQueue(async (job) => {
      ran.push(job.spaceId);
      if (job.spaceId === 'a') { await gate.promise; throw new Error('余额不足'); }
    }, bus);
    q.enqueue(makeJob('a'));
    q.enqueue(makeJob('b'));
    gate.resolve();
    await tick();
    expect(ran).toEqual(['a', 'b']);
    expect(seen.map((e) => [e.spaceId, e.step, e.message])).toEqual([
      ['b', 'queued', '排队中，前面还有 1 个任务'],
      ['a', 'failed', '余额不足'],
    ]);
    expect(q.current()).toBeNull();
  });

  it('取消运行中的任务：run 收到的 AbortSignal 被触发，失败后事件为 failed「已取消」，后续任务照常运行', async () => {
    const bus = new EventBus(() => mkdtempSync(join(tmpdir(), 'mz-jobs-')));
    const seen: WorkEvent[] = [];
    bus.subscribe('a', (e) => seen.push(e));
    let signalOfA: AbortSignal | undefined;
    const ran: string[] = [];
    const q = new JobQueue(async (job, signal) => {
      ran.push(job.spaceId);
      if (job.spaceId !== 'a') return;
      signalOfA = signal;
      await new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new Error('已取消'))));
    }, bus);
    q.enqueue(makeJob('a'));
    q.enqueue(makeJob('b'));
    await tick();
    expect(q.cancel('a')).toBe(true);
    expect(signalOfA?.aborted).toBe(true);
    await tick();
    expect(seen.map((e) => [e.step, e.message])).toEqual([['failed', '已取消']]);
    expect(ran).toEqual(['a', 'b']);
  });

  it('流程自己抛了别的错但任务已被取消，仍记为「已取消」', async () => {
    const bus = new EventBus(() => mkdtempSync(join(tmpdir(), 'mz-jobs-')));
    const seen: WorkEvent[] = [];
    bus.subscribe('a', (e) => seen.push(e));
    const q = new JobQueue(async (_job, signal) => {
      await new Promise<void>((r) => signal.addEventListener('abort', () => r()));
      throw new Error('ffmpeg 被杀');
    }, bus);
    q.enqueue(makeJob('a'));
    q.cancel('a');
    await tick();
    expect(seen.map((e) => e.message)).toEqual(['已取消']);
  });

  it('取消还在排队的任务：直接移出队列、不会运行、发布 failed「已取消」', async () => {
    const bus = new EventBus(() => mkdtempSync(join(tmpdir(), 'mz-jobs-')));
    const seen: WorkEvent[] = [];
    bus.subscribe('b', (e) => seen.push(e));
    const gate = deferred();
    const ran: string[] = [];
    const q = new JobQueue(async (job) => { ran.push(job.spaceId); if (job.spaceId === 'a') await gate.promise; }, bus);
    q.enqueue(makeJob('a'));
    q.enqueue(makeJob('b'));
    expect(q.cancel('b')).toBe(true);
    gate.resolve();
    await tick();
    expect(ran).toEqual(['a']);
    expect(seen.map((e) => [e.step, e.message])).toEqual([['queued', '排队中，前面还有 1 个任务'], ['failed', '已取消']]);
  });

  it('取消不存在的项目返回 false', () => {
    const q = new JobQueue(async () => undefined);
    expect(q.cancel('nope')).toBe(false);
  });

  it('事件顺序 queued → 流程事件，并可从 events.jsonl 重播（run 为模拟流程）', async () => {
    const store = newStore();
    const s1 = store.create('一', [], SETTINGS);
    const v1 = store.addVersion(s1.id, { summary: '', changedShots: [], costYuan: 0, status: 'running' });
    const bus = new EventBus((id, n) => store.versionDir(id, n));
    const gate = deferred();
    const q = new JobQueue(async (job, signal) => {
      bus.publish(toWorkEvent(job.spaceId, job.version, { step: 'probe', message: '开始' }, 1));
      await gate.promise;
      if (signal.aborted) throw new Error('已取消');
      bus.publish(toWorkEvent(job.spaceId, job.version, { step: 'done', message: '完成' }, 2));
    }, bus);
    q.enqueue(makeJob('blocker', 1));
    q.enqueue(makeJob(s1.id, v1.n));
    q.cancel('blocker');
    gate.resolve();
    await tick(10);
    const replay = new EventBus((id, n) => store.versionDir(id, n)).history(s1.id, v1.n);
    expect(replay.map((e) => `${e.step}:${e.message}`)).toEqual(['queued:排队中，前面还有 1 个任务', 'probe:开始', 'done:完成']);
  });
});
