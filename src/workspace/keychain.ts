import { execFile } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkReason } from '../llm/errors.js';

export interface KeyStore {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** 执行外部命令：不经过 shell；需要保密的内容通过 input 走 stdin，不进入参数 */
export type Exec = (cmd: string, args: string[], opts?: { input?: string }) => Promise<{ stdout: string; code: number }>;

export const KEXIANG_MODELS_URL = 'https://kexiangai.com/api/v1/models';
const SERVICE = 'mingzhi';
const ACCOUNT = 'kexiang';
const VALIDATE_TIMEOUT_MS = 15_000;

/** DPAPI：把 stdin 里的明文加密成当前 Windows 用户才能解开的密文 */
const PS_ENCRYPT = '[Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString';
const PS_DECRYPT =
  '$s = [Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString; ' +
  '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
  'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }';

export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { encoding: 'utf8', windowsHide: true }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ stdout: stdout ?? '', code });
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(opts?.input);
  });

/** 调用外部命令；命令不存在或执行异常一律当作失败（code -1），由调用方退回文件 */
async function run(exec: Exec, cmd: string, args: string[], input?: string): Promise<{ stdout: string; code: number }> {
  try {
    return await exec(cmd, args, input === undefined ? undefined : { input });
  } catch {
    return { stdout: '', code: -1 };
  }
}

class FileKey {
  constructor(private readonly dir: string, private readonly name: string) {}

  private get path(): string {
    return join(this.dir, this.name);
  }

  read(): string | null {
    if (!existsSync(this.path)) return null;
    return readFileSync(this.path, 'utf8').trim() || null;
  }

  write(content: string): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(this.path, `${content}\n`, { mode: 0o600 });
    chmodSync(this.path, 0o600); // 覆盖已有文件时 mode 参数不生效，再显式收紧一次
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

export function createKeyStore(dataDir: string, platform: NodeJS.Platform = process.platform, exec: Exec = defaultExec): KeyStore {
  const plain = new FileKey(dataDir, 'key');
  const dpapi = new FileKey(dataDir, 'key.dpapi');
  const needKey = (key: string): string => {
    const trimmed = key.trim();
    if (!trimmed) throw new Error('key 不能为空');
    return trimmed;
  };

  if (platform === 'darwin') {
    return {
      async get() {
        const r = await run(exec, 'security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
        return (r.code === 0 && r.stdout.trim()) || plain.read();
      },
      async set(raw) {
        const key = needKey(raw);
        const r = await run(exec, 'security', ['add-generic-password', '-U', '-s', SERVICE, '-a', ACCOUNT, '-w', key]);
        if (r.code === 0) plain.remove();
        else plain.write(key);
      },
      async clear() {
        await run(exec, 'security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
        plain.remove();
      },
    };
  }

  if (platform === 'win32') {
    const powershell = (script: string, input: string) => run(exec, 'powershell', ['-NoProfile', '-Command', script], input);
    return {
      async get() {
        const blob = dpapi.read();
        if (blob) {
          const r = await powershell(PS_DECRYPT, blob);
          if (r.code === 0 && r.stdout.trim()) return r.stdout.trim();
        }
        return plain.read();
      },
      async set(raw) {
        const key = needKey(raw);
        const r = await powershell(PS_ENCRYPT, key);
        if (r.code === 0 && r.stdout.trim()) {
          dpapi.write(r.stdout.trim());
          plain.remove();
        } else {
          plain.write(key);
        }
      },
      async clear() {
        dpapi.remove();
        plain.remove();
      },
    };
  }

  return {
    async get() {
      return plain.read();
    },
    async set(raw) {
      plain.write(needKey(raw));
    },
    async clear() {
      plain.remove();
    },
  };
}

/** 200 有效；401/403 无效；网络错误与 5xx 无法判断，抛错让调用方提示「稍后重试」而不是误判 key 无效 */
export async function validateKey(key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const trimmed = key.trim();
  if (!trimmed) return false;
  let res: Response;
  try {
    res = await fetchImpl(KEXIANG_MODELS_URL, {
      method: 'GET',
      headers: { Authorization: `Bearer ${trimmed.startsWith('sk-') ? trimmed : `sk-${trimmed}`}` },
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`无法校验 key：${networkReason(err)}`);
  }
  if (res.ok) return true;
  if (res.status >= 500) throw new Error(`无法校验 key：可想 AI 暂时不可用 ${res.status}`);
  return false;
}
