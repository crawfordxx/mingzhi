import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createKeyStore, validateKey, type Exec } from '../src/workspace/keychain.js';

const KEY = 'sk-test-secret-123';
const NEW_KEY = 'sk-new-key-456';
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mz-key-'));
});

type MockExec = Exec & ReturnType<typeof vi.fn>;
const okExec = (stdout = ''): MockExec => vi.fn(async () => ({ stdout, code: 0 })) as MockExec;
const failExec = (): MockExec => vi.fn(async () => ({ stdout: '', code: 1 })) as MockExec;
const throwExec = (): MockExec => vi.fn(async () => { throw new Error('spawn ENOENT'); }) as MockExec;
const mode = (p: string) => statSync(p).mode & 0o777;

/** 带状态的假 macOS 钥匙串：-i 读 stdin 里的 add 命令（含转义），find/delete 操作同一份状态 */
function fakeMac(init: { value?: string; failAdd?: boolean } = {}) {
  const state = { value: init.value ?? null as string | null };
  const exec = vi.fn(async (_cmd: string, args: string[], opts?: { input?: string }) => {
    if (args[0] === '-i') {
      if (init.failAdd) return { stdout: '', code: 1 };
      const m = /-w "((?:[^"\\]|\\.)*)"/.exec(opts?.input ?? '');
      state.value = m ? m[1].replace(/\\(.)/g, '$1') : state.value;
      return { stdout: '', code: 0 };
    }
    if (args[0] === 'find-generic-password') return state.value === null ? { stdout: '', code: 44 } : { stdout: `${state.value}\n`, code: 0 };
    if (args[0] === 'delete-generic-password') {
      const had = state.value !== null;
      state.value = null;
      return { stdout: '', code: had ? 0 : 44 };
    }
    return { stdout: '', code: 1 };
  }) as MockExec;
  return { exec, state };
}

/** 假 DPAPI：密文就是 "enc:"+明文，只验证流程与参数 */
function fakePowershell(failEncrypt = false): MockExec {
  return vi.fn(async (_cmd: string, args: string[], opts?: { input?: string }) => {
    const script = args.join(' ');
    if (script.includes('ConvertFrom-SecureString')) return failEncrypt ? { stdout: '', code: 1 } : { stdout: `enc:${opts?.input}\r\n`, code: 0 };
    if (script.includes('ConvertTo-SecureString')) return { stdout: `${(opts?.input ?? '').replace(/^enc:/, '')}\r\n`, code: 0 };
    return { stdout: '', code: 1 };
  }) as MockExec;
}

describe('KeyStore macOS', () => {
  it('set 用 security -i，命令从 stdin 送入，argv 里没有 key', async () => {
    const { exec, state } = fakeMac();
    await createKeyStore(dir, 'darwin', exec).set(KEY);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('security');
    expect(args).toEqual(['-i']);
    expect(JSON.stringify(exec.mock.calls.map((c) => [c[0], c[1]]))).not.toContain(KEY);
    expect(opts).toEqual({ input: `add-generic-password -U -s mingzhi -a kexiang -w "${KEY}"\n` });
    expect(state.value).toBe(KEY);
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('key 里的双引号和反斜杠在 stdin 命令里被转义，并能原样读回', async () => {
    const tricky = 'sk-a"b\\c d';
    const { exec, state } = fakeMac();
    const store = createKeyStore(dir, 'darwin', exec);
    await store.set(tricky);
    expect(exec.mock.calls[0][2]).toEqual({ input: 'add-generic-password -U -s mingzhi -a kexiang -w "sk-a\\"b\\\\c d"\n' });
    expect(state.value).toBe(tricky);
    expect(await store.get()).toBe(tricky);
  });

  it('key 含换行或控制字符时拒绝，不调用任何命令', async () => {
    const exec = okExec();
    const store = createKeyStore(dir, 'darwin', exec);
    for (const bad of ['sk-a\nadd-generic-password -w x', 'sk-a\rb', 'sk-a\u0000b', 'sk-a\tb']) {
      await expect(store.set(bad)).rejects.toThrow('key 含换行或控制字符');
    }
    expect(exec).not.toHaveBeenCalled();
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('get 调 find-generic-password 并去掉换行', async () => {
    const exec = okExec(`${KEY}\n`);
    expect(await createKeyStore(dir, 'darwin', exec).get()).toBe(KEY);
    expect(exec).toHaveBeenCalledWith('security', ['find-generic-password', '-s', 'mingzhi', '-a', 'kexiang', '-w'], undefined);
  });

  it('security 命令失败时 set 退回 600 文件，get 能读回', async () => {
    const store = createKeyStore(dir, 'darwin', failExec());
    await store.set(KEY);
    expect(readFileSync(join(dir, 'key'), 'utf8').trim()).toBe(KEY);
    expect(mode(join(dir, 'key'))).toBe(0o600);
    expect(await store.get()).toBe(KEY);
  });

  it('命令退出码为 0 但读回的值不对（-i 模式下写入静默失败）时同样退回文件', async () => {
    const exec = vi.fn(async (_c: string, args: string[]) =>
      args[0] === 'find-generic-password' ? { stdout: 'sk-stale\n', code: 0 } : { stdout: '', code: 0 }) as MockExec;
    const store = createKeyStore(dir, 'darwin', exec);
    await store.set(KEY);
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

  it('钥匙串里已有旧 key，新 key 写钥匙串失败退回文件后，get 返回新 key（I1）', async () => {
    const { exec, state } = fakeMac({ value: KEY, failAdd: true });
    const store = createKeyStore(dir, 'darwin', exec);
    await store.set(NEW_KEY);
    expect(await store.get()).toBe(NEW_KEY);
    expect(state.value).toBeNull(); // 旧条目也被尽力清掉了
  });

  it('钥匙串写成功后清掉旧的回退文件，get 读钥匙串里的新 key', async () => {
    writeFileSync(join(dir, 'key'), 'sk-old', { mode: 0o600 });
    const { exec } = fakeMac();
    const store = createKeyStore(dir, 'darwin', exec);
    await store.set(KEY);
    expect(existsSync(join(dir, 'key'))).toBe(false);
    expect(await store.get()).toBe(KEY);
  });

  it('clear 删钥匙串条目和回退文件', async () => {
    writeFileSync(join(dir, 'key'), KEY, { mode: 0o600 });
    const { exec, state } = fakeMac({ value: KEY });
    await createKeyStore(dir, 'darwin', exec).clear();
    expect(exec).toHaveBeenCalledWith('security', ['delete-generic-password', '-s', 'mingzhi', '-a', 'kexiang'], undefined);
    expect(state.value).toBeNull();
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

  it('覆盖已有 644 文件后权限是 600，且目录里没有残留临时文件', async () => {
    writeFileSync(join(dir, 'key'), 'sk-old', { mode: 0o644 });
    await createKeyStore(dir, 'linux', okExec()).set(KEY);
    expect(mode(join(dir, 'key'))).toBe(0o600);
    expect(readFileSync(join(dir, 'key'), 'utf8').trim()).toBe(KEY);
    expect(readdirSync(dir)).toEqual(['key']);
  });
});

describe('KeyStore Windows DPAPI', () => {
  it('set 用 powershell ConvertFrom-SecureString 加密，key 走 stdin 而不在参数里', async () => {
    const exec = fakePowershell();
    await createKeyStore(dir, 'win32', exec).set(KEY);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(args.slice(0, 2)).toEqual(['-NoProfile', '-Command']);
    expect(args.join(' ')).toContain('ConvertFrom-SecureString');
    expect(args.join(' ')).not.toContain(KEY);
    expect(opts).toEqual({ input: KEY });
    expect(readFileSync(join(dir, 'key.dpapi'), 'utf8').trim()).toBe(`enc:${KEY}`);
    expect(existsSync(join(dir, 'key'))).toBe(false);
  });

  it('get 读密文，用 ConvertTo-SecureString 解密，密文走 stdin', async () => {
    writeFileSync(join(dir, 'key.dpapi'), '01000000d08c9ddf\n');
    const exec = okExec(`${KEY}\r\n`);
    expect(await createKeyStore(dir, 'win32', exec).get()).toBe(KEY);
    const [cmd, args, opts] = exec.mock.calls[0];
    expect(cmd).toBe('powershell');
    expect(args.join(' ')).toContain('ConvertTo-SecureString');
    expect(opts).toEqual({ input: '01000000d08c9ddf' });
  });

  it('set 之后 get 能读回同一个 key', async () => {
    const store = createKeyStore(dir, 'win32', fakePowershell());
    await store.set(KEY);
    expect(await store.get()).toBe(KEY);
  });

  it('powershell 加密失败时退回文件，并删掉旧密文，get 返回新 key（I1）', async () => {
    writeFileSync(join(dir, 'key.dpapi'), `enc:${KEY}`);
    const store = createKeyStore(dir, 'win32', fakePowershell(true));
    await store.set(NEW_KEY);
    expect(existsSync(join(dir, 'key.dpapi'))).toBe(false);
    expect(await store.get()).toBe(NEW_KEY);
  });

  it('key 含控制字符时拒绝', async () => {
    const exec = fakePowershell();
    await expect(createKeyStore(dir, 'win32', exec).set('sk-a\nb')).rejects.toThrow('key 含换行或控制字符');
    expect(exec).not.toHaveBeenCalled();
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
  const asFetch = (fn: unknown) => fn as typeof fetch;

  it('空请求体 POST 对话接口：400（参数缺失）即 key 有效，带 Bearer sk- 前缀', async () => {
    const fetchImpl = vi.fn(async () => res(400));
    expect(await validateKey('abc', asFetch(fetchImpl))).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://kexiangai.com/api/v1/chat/completions');
    expect(init.method).toBe('POST');
    expect(init.body).toBe('{}');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
  });

  it('已带 sk- 前缀不重复添加', async () => {
    const fetchImpl = vi.fn(async () => res(200));
    await validateKey('sk-abc', asFetch(fetchImpl));
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer sk-abc');
  });

  it('只有 401/403 返回 false', async () => {
    expect(await validateKey('x', asFetch(async () => res(401)))).toBe(false);
    expect(await validateKey('x', asFetch(async () => res(403)))).toBe(false);
  });

  it('空 key 返回 false 且不发请求', async () => {
    const fetchImpl = vi.fn();
    expect(await validateKey('', asFetch(fetchImpl))).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('网络错误、429、404、5xx 都抛中文错误，区别于 key 无效', async () => {
    await expect(validateKey('x', asFetch(async () => { throw new Error('boom'); }))).rejects.toThrow('无法校验 key');
    for (const status of [429, 404, 408, 500, 502]) {
      await expect(validateKey('x', asFetch(async () => res(status)))).rejects.toThrow(`无法校验 key：可想 AI 返回 HTTP ${status}`);
    }
  });
});
