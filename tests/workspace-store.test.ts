import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SpaceStore, type SpaceSettings } from '../src/workspace/store.js';

const SETTINGS: SpaceSettings = { captionStyle: 'blade', budgetYuan: 20, broll: true, maxVideos: 3, background: { kind: 'preset', id: 'warm' } };
const NEW_VERSION = { summary: '初版', changedShots: [1, 2], costYuan: 0, status: 'running' as const };

let root: string;
let store: SpaceStore;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'mz-store-'));
  store = new SpaceStore(root);
});

describe('SpaceStore 项目', () => {
  it('create 写出 space.json 并可 get 回来', () => {
    const space = store.create('我的口播', ['/a.mp4', '/b.mp4'], SETTINGS);
    expect(space.id).toMatch(/^[0-9a-f]{8}$/);
    expect(space.title).toBe('我的口播');
    expect(space.inputs).toEqual(['/a.mp4', '/b.mp4']);
    expect(space.versions).toEqual([]);
    expect(Number.isNaN(Date.parse(space.createdAt))).toBe(false);
    expect(store.get(space.id)).toEqual(space);
    expect(existsSync(join(root, space.id, 'space.json'))).toBe(true);
  });

  it('list 返回全部项目，最新创建的在前，忽略没有 space.json 的目录', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const a = store.create('甲', [], SETTINGS);
      vi.setSystemTime(new Date('2026-01-02T00:00:00Z'));
      const b = store.create('乙', [], SETTINGS);
      writeFileSync(join(root, 'stray.txt'), 'x');
      expect(store.list().map((s) => s.id)).toEqual([b.id, a.id]);
      expect(new SpaceStore(join(root, 'nope')).list()).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('list 跳过损坏的 space.json 并告警，其他项目照常返回', () => {
    const good = store.create('好的', [], SETTINGS);
    const bad = store.create('坏的', [], SETTINGS);
    writeFileSync(join(root, bad.id, 'space.json'), '{broken');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      expect(store.list().map((s) => s.id)).toEqual([good.id]);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(String(warn.mock.calls[0][0])).toContain(bad.id);
    } finally {
      warn.mockRestore();
    }
  });

  it('get 不存在的项目抛中文错误', () => {
    expect(() => store.get('deadbeef')).toThrow('项目不存在：deadbeef');
  });

  it('get 拒绝路径穿越的 id', () => {
    expect(() => store.get('../etc')).toThrow('项目 id 不合法');
  });

  it('create 返回的对象不与调用方传入的 inputs、settings 共享引用', () => {
    const inputs = ['/a.mp4'];
    const settings: SpaceSettings = { ...SETTINGS, background: { kind: 'preset', id: 'warm' } };
    const space = store.create('t', inputs, settings);
    inputs.push('/z.mp4');
    (settings.background as { id: string }).id = 'changed';
    expect(space.inputs).toEqual(['/a.mp4']);
    expect(space.settings.background).toEqual({ kind: 'preset', id: 'warm' });
  });

  it('rename 只改标题，其余字段保留', () => {
    const space = store.create('旧名', ['/a.mp4'], SETTINGS);
    store.addVersion(space.id, NEW_VERSION);
    const renamed = store.rename(space.id, '新名');
    expect(renamed.title).toBe('新名');
    expect(renamed.versions).toHaveLength(1);
    expect(renamed.settings).toEqual(SETTINGS);
    expect(store.get(space.id).title).toBe('新名');
  });

  it('rename 空标题报错', () => {
    const space = store.create('旧名', [], SETTINGS);
    expect(() => store.rename(space.id, '   ')).toThrow('标题不能为空');
  });
});

describe('SpaceStore 版本', () => {
  it('addVersion 依次编号 1、2、3 并补 createdAt', () => {
    const { id } = store.create('t', [], SETTINGS);
    const v1 = store.addVersion(id, NEW_VERSION);
    const v2 = store.addVersion(id, { ...NEW_VERSION, parent: 1, summary: '改字幕' });
    expect([v1.n, v2.n]).toEqual([1, 2]);
    expect(v2.parent).toBe(1);
    expect(Number.isNaN(Date.parse(v1.createdAt))).toBe(false);
    expect(store.get(id).versions.map((v) => v.n)).toEqual([1, 2]);
  });

  it('updateVersion 只合并 patch 字段，不丢其他字段，也不动别的版本', () => {
    const { id } = store.create('t', [], SETTINGS);
    store.addVersion(id, NEW_VERSION);
    store.addVersion(id, { ...NEW_VERSION, summary: '二版' });
    const done = store.updateVersion(id, 1, { status: 'done', costYuan: 1.5 });
    expect(done).toMatchObject({ n: 1, summary: '初版', changedShots: [1, 2], status: 'done', costYuan: 1.5 });
    const scored = store.updateVersion(id, 1, { qaScore: 88 });
    expect(scored).toMatchObject({ status: 'done', costYuan: 1.5, qaScore: 88 });
    const space = store.get(id);
    expect(space.versions[1]).toMatchObject({ summary: '二版', status: 'running' });
  });

  it('updateVersion 不允许改 n 与 createdAt', () => {
    const { id } = store.create('t', [], SETTINGS);
    const v1 = store.addVersion(id, NEW_VERSION);
    const out = store.updateVersion(id, 1, { n: 9, createdAt: '2000-01-01T00:00:00.000Z' } as never);
    expect(out.n).toBe(1);
    expect(out.createdAt).toBe(v1.createdAt);
  });

  it('版本不存在抛中文错误', () => {
    const { id } = store.create('t', [], SETTINGS);
    expect(() => store.updateVersion(id, 3, { status: 'done' })).toThrow('版本不存在：v3');
    expect(() => store.addVersion('deadbeef', NEW_VERSION)).toThrow('项目不存在');
  });

  it('baseDir 与 versionDir 位于项目目录下且互不相同', () => {
    const { id } = store.create('t', [], SETTINGS);
    expect(store.baseDir(id)).toBe(join(root, id, 'base'));
    expect(store.versionDir(id, 2)).toBe(join(root, id, 'v2'));
    expect(store.versionDir(id, 1)).not.toBe(store.versionDir(id, 2));
  });

  it('versionDir 拒绝非正整数与路径穿越的版本号', () => {
    const { id } = store.create('t', [], SETTINGS);
    for (const bad of [0, -1, 1.5, Number.NaN, '../../x' as unknown as number]) {
      expect(() => store.versionDir(id, bad)).toThrow('版本号不合法');
    }
  });
});

describe('SpaceStore 写入', () => {
  it('多次写入后目录里没有残留临时文件，内容是合法 JSON', () => {
    const { id } = store.create('t', [], SETTINGS);
    for (let i = 0; i < 5; i += 1) store.addVersion(id, NEW_VERSION);
    expect(readdirSync(join(root, id)).filter((f) => f.includes('.tmp'))).toEqual([]);
    expect(JSON.parse(readFileSync(join(root, id, 'space.json'), 'utf8')).versions).toHaveLength(5);
  });

  it('旧文件损坏时报中文错误而不是静默返回', () => {
    const { id } = store.create('t', [], SETTINGS);
    writeFileSync(join(root, id, 'space.json'), '{broken');
    expect(() => store.get(id)).toThrow('项目文件已损坏');
  });
});
