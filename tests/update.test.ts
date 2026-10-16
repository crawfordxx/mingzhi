import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appVersion, isNewer, RELEASES_API, UPDATE_CACHE_FILE, UpdateChecker, type UpdateCheckerOptions } from '../src/server/update.js';

const DAY = 24 * 3600_000;
const RELEASE = {
  tag_name: 'v0.2.0',
  html_url: 'https://github.com/crawfordxx/mingzhi/releases/tag/v0.2.0',
  body: '修复了导出\n新增了封面风格',
  draft: false,
  prerelease: false,
};

const ok = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

function setup(over: Partial<UpdateCheckerOptions> = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'mz-update-'));
  let now = 1_800_000_000_000;
  const fetchFn = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => ok(RELEASE));
  const opts: UpdateCheckerOptions = { dataDir, current: '0.1.0', enabled: () => true, fetch: fetchFn as unknown as typeof fetch, now: () => now, ...over };
  return { dataDir, fetchFn, opts, checker: new UpdateChecker(opts), advance: (ms: number) => { now += ms; } };
}

describe('isNewer', () => {
  it.each([
    ['0.2.0', '0.1.0', true],
    ['v0.2.0', '0.1.0', true],
    ['0.1.10', '0.1.9', true],
    ['1.0.0', '0.99.99', true],
    ['0.1.0', '0.1.0', false],
    ['v0.1.0', '0.1.0', false],
    ['0.0.9', '0.1.0', false],
    ['0.2.0-beta.1', '0.1.0', true],
    ['0.2.0-beta.1', '0.2.0', false],
    ['0.2.0', '0.2.0-beta.1', true],
    ['latest', '0.1.0', false],
    ['0.2', '0.1.0', false],
    ['0.2.0', 'dev', false],
  ])('%s 比 %s 新：%s', (a, b, want) => {
    expect(isNewer(a, b)).toBe(want);
  });
});

describe('appVersion', () => {
  it('读 package.json（不受环境变量影响）', () => {
    const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8')) as { version: string };
    vi.stubEnv('MINGZHI_APP_VERSION', '9.9.9');
    expect(appVersion()).toBe(pkg.version);
    vi.unstubAllEnvs();
  });
});

describe('UpdateChecker', () => {
  it('有新版本：available 给出版本、Release 页面与说明，并写入缓存', async () => {
    const { checker, fetchFn, dataDir } = setup();
    expect(checker.available()).toBeNull();
    await checker.poke();
    expect(checker.available()).toEqual({ version: '0.2.0', url: RELEASE.html_url, notes: RELEASE.body });
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const cache = JSON.parse(readFileSync(join(dataDir, UPDATE_CACHE_FILE), 'utf8')) as { checkedAt: number };
    expect(cache.checkedAt).toBeGreaterThan(0);
  });

  it('匿名 GET：只请求 GitHub Releases 的 latest，不带任何标识或凭据', async () => {
    const { checker, fetchFn } = setup();
    await checker.poke();
    const [url, init] = fetchFn.mock.calls[0];
    expect(String(url)).toBe(RELEASES_API);
    expect(init?.method ?? 'GET').toBe('GET');
    expect(init?.headers).toEqual({ Accept: 'application/vnd.github+json' });
    expect(init?.body).toBeUndefined();
    expect(init?.credentials).toBeUndefined();
  });

  it('已是最新：available 为 null', async () => {
    const { checker } = setup({ current: '0.2.0' });
    await checker.poke();
    expect(checker.available()).toBeNull();
  });

  it('每天最多查 1 次；过了一天再查', async () => {
    const { checker, fetchFn, advance } = setup();
    await checker.poke();
    advance(DAY - 1000);
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    advance(2000);
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });

  it('并发 poke 只发一次请求', async () => {
    const { checker, fetchFn } = setup();
    await Promise.all([checker.poke(), checker.poke(), checker.poke()]);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('缓存跨进程：新实例读到当天的结果，不再请求', async () => {
    const first = setup();
    await first.checker.poke();
    const again = new UpdateChecker({ ...first.opts });
    expect(again.available()?.version).toBe('0.2.0');
    await again.poke();
    expect(first.fetchFn).toHaveBeenCalledTimes(1);
  });

  it('换成新版本后，缓存里的旧「新版本」不再提示', async () => {
    const first = setup();
    await first.checker.poke();
    const upgraded = new UpdateChecker({ ...first.opts, current: '0.2.0' });
    expect(upgraded.available()).toBeNull();
  });

  it.each([
    ['404（仓库未公开）', async () => new Response('{"message":"Not Found"}', { status: 404 })],
    ['403（限流）', async () => new Response('{}', { status: 403 })],
    ['网络错误', async () => { throw new TypeError('fetch failed'); }],
    ['不是 JSON', async () => new Response('<html>', { status: 200 })],
    ['字段不对', async () => ok({ name: 'x' })],
    ['地址不是本仓库的 Release 页', async () => ok({ ...RELEASE, html_url: 'https://evil.example/releases/tag/v9.9.9' })],
  ])('失败静默：%s → 不抛错、无提示、当天不再重试', async (_name, impl) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { checker, fetchFn, advance } = setup();
    fetchFn.mockImplementation(impl as never);
    await expect(checker.poke()).resolves.toBeUndefined();
    expect(checker.available()).toBeNull();
    advance(3600_000);
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    error.mockRestore();
  });

  it('失败不覆盖之前查到的新版本', async () => {
    const { checker, fetchFn, advance } = setup();
    await checker.poke();
    fetchFn.mockImplementation(async () => { throw new TypeError('fetch failed'); });
    advance(DAY + 1);
    await checker.poke();
    expect(checker.available()?.version).toBe('0.2.0');
  });

  it('预发布与草稿不算新版本', async () => {
    const { checker, fetchFn } = setup();
    fetchFn.mockImplementation(async () => ok({ ...RELEASE, prerelease: true }));
    await checker.poke();
    expect(checker.available()).toBeNull();
  });

  it('说明过长时截断，空说明给空串', async () => {
    const long = setup();
    long.fetchFn.mockImplementation(async () => ok({ ...RELEASE, body: 'x'.repeat(10_000) }));
    await long.checker.poke();
    expect(long.checker.available()!.notes.length).toBeLessThanOrEqual(2001);
    const empty = setup();
    empty.fetchFn.mockImplementation(async () => ok({ ...RELEASE, body: null }));
    await empty.checker.poke();
    expect(empty.checker.available()!.notes).toBe('');
  });

  it('关闭检查更新：不请求、不提示（已缓存的新版本也不提示）', async () => {
    let on = true;
    const { checker, fetchFn, advance } = setup({ enabled: () => on });
    await checker.poke();
    on = false;
    expect(checker.available()).toBeNull();
    advance(DAY * 2);
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('缓存文件损坏时当作没查过', async () => {
    const { dataDir, opts, fetchFn } = setup();
    writeFileSync(join(dataDir, UPDATE_CACHE_FILE), '{坏的');
    const checker = new UpdateChecker(opts);
    expect(checker.available()).toBeNull();
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it('数据目录写不进去也不抛错，且同一进程当天不重试', async () => {
    const { opts, fetchFn } = setup({ dataDir: join(tmpdir(), 'mz-update-missing', 'no', 'such') });
    const checker = new UpdateChecker(opts);
    await expect(checker.poke()).resolves.toBeUndefined();
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(existsSync(opts.dataDir)).toBe(false);
  });

  it('系统时间被调回过去时重新查', async () => {
    const { checker, fetchFn, advance } = setup();
    await checker.poke();
    advance(-DAY * 3);
    await checker.poke();
    expect(fetchFn).toHaveBeenCalledTimes(2);
  });
});
