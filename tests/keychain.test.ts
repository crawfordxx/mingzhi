import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyStore, validateKey, type Exec } from '../src/workspace/keychain.js';

const KEY = 'sk-test-secret-123';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-key-'));
});

const okExec = (stdout = ''): Exec & ReturnType<typeof vi.fn> => vi.fn(async () => ({ stdout, code: 0 }));
const failExec = (): Exec & ReturnType<typeof vi.fn> => vi.fn(async () => ({ stdout: '', code: 1 }));
const throwExec = (): Exec & ReturnType<typeof vi.fn> => vi.fn(async () => { throw new Error('spawn ENOENT'); });
const mode = (p: string) => statSync(p).mode & 0o777;

describe('KeyStore macOS', () => {
  it('set 调 security add-generic-password，key 只出现在 -w 参数里', async () => {
    const exec = okExec();
    await createKeyStore(dir, 'darwin', exec).set(KEY);
    expect(exec).toHaveBeenCalledWith('security', ['add-generic-password', '-U', '-s', 'mingzhi', '-a', 'kexiang', '-w', KEY], undefined);
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('get 调 find-generic-password 并去掉换行', async () => {
    const exec = okExec(`${KEY}\n`);
    expect(await createKeyStore(dir, 'darwin', exec).get()).toBe(KEY);
    expect(exec).toHaveBeenCalledWith('security', ['find-generic-password', '-s', 'mingzhi', '-a', 'kexiang', '-w'], undefined);
  });

  it('钥匙串失败时 set 退回 600 文件，get 能读回', async () => {
    const store = createKeyStore(dir, 'darwin', failExec());
    await store.set(KEY);
    expect(readFileSync(join(dir, 'key'), 'utf8').trim()).toBe(KEY);
    expect(mode(join(dir, 'key'))).toBe(0o600);
    expect(await store.get()).toBe(KEY);
  });

  it('exec 抛错（如没有 security 命令）同样退回文件', async () => {
    const store = createKeyStore(dir, 'darwin', throwExec());
    await store.set(KEY);
    expect(await store.get()).toBe(KEY);
  });

  it('钥匙串里没有、文件里有时 get 读文件；都没有返回 null', async () => {
    const store = createKeyStore(dir, 'darwin', failExec());
    expect(await store.get()).toBeNull();
    writeFileSync(join(dir, 'key'), `${KEY}\n`, { mode: 0o600 });
    expect(await store.get()).toBe(KEY);
  });

  it('钥匙串写成功后清掉旧的回退文件', async () => {
    writeFileSync(join(dir, 'key'), 'sk-old', { mode: 0o600 });
    await createKeyStore(dir, 'darwin', okExec()).set(KEY);
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('clear 删钥匙串条目和回退文件', async () => {
    writeFileSync(join(dir, 'key'), KEY, { mode: 0o600 });
    const exec = okExec();
    await createKeyStore(dir, 'darwin', exec).clear();
    expect(exec).toHaveBeenCalledWith('security', ['delete-generic-password', '-s', 'mingzhi', '-a', 'kexiang'], undefined);
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('clear 在钥匙串条目不存在时也不抛错', async () => {
    await expect(createKeyStore(dir, 'darwin', failExec()).clear()).resolves.toBeUndefined();
  });

  it('set 空 key 报中文错误', async () => {
    await expect(createKeyStore(dir, 'darwin', okExec()).set('  ')).rejects.toThrow('key 不能为空');
  });
});

describe('KeyStore 其他平台', () => {
  it('linux 不调用 exec，直接用 600 文件', async () => {
    const exec = okExec();
    const store = createKeyStore(join(dir, 'nested'), 'linux', exec);
    await store.set(KEY);
    expect(exec).not.toHaveBeenCalled();
    expect(mode(join(dir, 'nested', 'key'))).toBe(0o600);
    expect(await store.get()).toBe(KEY);
    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it('覆盖已有文件后权限仍是 600', async () => {
    writeFileSync(join(dir, 'key'), 'sk-old', { mode: 0o644 });
    await createKeyStore(dir, 'linux', okExec()).set(KEY);
    expect(mode(join(dir, 'key'))).toBe(0o600);
  });
});

describe('KeyStore Windows DPAPI', () => {
  it('set 用 powershell ConvertFrom-SecureString 加密，key 走 stdin 而不在参数里', async () => {
    const exec = okExec('01000000d08c9ddf');
    await createKeyStore(dir, 'win32', exec).set(KEY);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(args.slice(0, 2)).toEqual(['-NoProfile', '-Command']);
    expect(args.join(' ')).toContain('ConvertFrom-SecureString');
    expect(args.join(' ')).not.toContain(KEY);
    expect(opts).toEqual({ input: KEY });
    expect(readFileSync(join(dir, 'key.dpapi'), 'utf8').trim()).toBe('01000000d08c9ddf');
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('get 读密文，用 ConvertTo-SecureString 解密', async () => {
    writeFileSync(join(dir, 'key.dpapi'), '01000000d08c9ddf\n');
    const exec = okExec(`${KEY}\r\n`);
    expect(await createKeyStore(dir, 'win32', exec).get()).toBe(KEY);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(args.join(' ')).toContain('ConvertTo-SecureString');
    expect(opts).toEqual({ input: '01000000d08c9ddf' });
  });

  it('powershell 加密失败时退回 600 文件', async () => {
    const store = createKeyStore(dir, 'win32', failExec());
    await store.set(KEY);
    expect(existsSync(join(dir, 'key.dpapi'))).toBe(false);
    expect(await store.get()).toBe(KEY);
  });

  it('clear 删密文与回退文件', async () => {
    writeFileSync(join(dir, 'key.dpapi'), 'abc');
    writeFileSync(join(dir, 'key'), KEY);
    await createKeyStore(dir, 'win32', okExec()).clear();
    expect(existsSync(join(dir, 'key.dpapi'))).toBe(false);
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });
});

describe('validateKey', () => {
  const res = (status: number) => new Response('{}', { status });

  it('200 返回 true，请求 GET /api/v1/models 且带 Bearer sk- 前缀', async () => {
    const fetchImpl = vi.fn(async () => res(200));
    expect(await validateKey('abc', fetchImpl as unknown as typeof fetch)).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://kexiangai.com/api/v1/models');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
  });

  it('已带 sk- 前缀不重复添加', async () => {
    const fetchImpl = vi.fn(async () => res(200));
    await validateKey('sk-abc', fetchImpl as unknown as typeof fetch);
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
  });

  it('401/403 返回 false', async () => {
    expect(await validateKey('x', (async () => res(401)) as unknown as typeof fetch)).toBe(false);
    expect(await validateKey('x', (async () => res(403)) as unknown as typeof fetch)).toBe(false);
  });

  it('空 key 返回 false 且不发请求', async () => {
    const fetchImpl = vi.fn();
    expect(await validateKey('', fetchImpl as unknown as typeof fetch)).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('网络错误与 5xx 抛中文错误，区别于 key 无效', async () => {
    await expect(validateKey('x', (async () => { throw new Error('boom'); }) as unknown as typeof fetch)).rejects.toThrow('无法校验 key');
    await expect(validateKey('x', (async () => res(502)) as unknown as typeof fetch)).rejects.toThrow('无法校验 key');
  });
});
