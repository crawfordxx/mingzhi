import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { networkReason } from '../llm/errors.js';

export interface KeyStore {
  get(): Promise<string | null>;
  set(key: string): Promise<void>;
  clear(): Promise<void>;
}

/** 执行外部命令：不经过 shell；需要保密的内容通过 input 走 stdin，不进入参数 */
export type Exec = (cmd: string, args: string[], opts?: { input?: string }) => Promise<{ stdout: string; code: number }>;

/**
 * 校验用的接口：可想的模型列表对任何 key 都返回 200，不能用来校验；
 * 对话接口发空请求体时，key 无效返回 401，key 有效返回 400（参数缺失），不产生花费（2026-10-15 实测）
 */
export const KEXIANG_VALIDATE_URL = 'https://kexiangai.com/api/v1/chat/completions';
const SERVICE = 'mingzhi';
const ACCOUNT = 'kexiang';
const VALIDATE_TIMEOUT_MS = 15_000;
/** 外部命令超时：钥匙串被锁或弹授权框时 security 会一直阻塞，超时按失败处理并退回文件 */
const EXEC_TIMEOUT_MS = 10_000;

/** DPAPI：把 stdin 里的明文加密成当前 Windows 用户才能解开的密文 */
const PS_ENCRYPT = '[Console]::In.ReadToEnd() | ConvertTo-SecureString -AsPlainText -Force | ConvertFrom-SecureString';
const PS_DECRYPT =
  '$s = [Console]::In.ReadToEnd().Trim() | ConvertTo-SecureString; ' +
  '$b = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); ' +
  'try { [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b) } finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b) }';

export const defaultExec: Exec = (cmd, args, opts) =>
  new Promise((resolve) => {
    const child = execFile(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: EXEC_TIMEOUT_MS }, (err, stdout) => {
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0; // 不读 err.message/err.cmd，避免带出命令行内容
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

/** 回退文件：先写 0o600 的临时文件再 rename，新文件一创建就是 600 且不会留下截断内容。Windows 上 0o600 基本不起作用，只能靠用户目录自身的 ACL */
class FileKey {
  constructor(private readonly dir: string, private readonly name: string) {}

  private get path(): string {
    return join(this.dir, this.name);
  }

  exists(): boolean {
    return existsSync(this.path);
  }

  read(): string | null {
    if (!existsSync(this.path)) return null;
    return readFileSync(this.path, 'utf8').trim() || null;
  }

  write(content: string): void {
    mkdirSync(this.dir, { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${content}\n`, { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}

function needKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) throw new Error('key 不能为空');
  if (/[\u0000-\u001f\u007f]/.test(trimmed)) throw new Error('key 含换行或控制字符，无法保存，请检查是否复制完整');
  return trimmed;
}

/** security -i 的命令行里用双引号包住密码，其中的反斜杠和双引号需转义 */
const quoteForSecurity = (key: string): string => `"${key.replace(/[\\"]/g, '\\$&')}"`;

function darwinStore(exec: Exec, plain: FileKey): KeyStore {
  const find = async () => {
    const r = await run(exec, 'security', ['find-generic-password', '-s', SERVICE, '-a', ACCOUNT, '-w']);
    return r.code === 0 ? r.stdout.trim() || null : null;
  };
  return {
    // 回退文件只在钥匙串写入失败时才存在（写成功会删掉它），所以文件优先才能保证 set 之后 get 拿到新 key
    async get() {
      return plain.read() ?? (await find());
    },
    async set(raw) {
      const key = needKey(raw);
      // 命令从 stdin 送入，key 不进 argv（ps 看不到）
      const r = await run(exec, 'security', ['-i'], `add-generic-password -U -s ${SERVICE} -a ${ACCOUNT} -w ${quoteForSecurity(key)}\n`);
      if (r.code === 0 && (await find()) === key) {
        plain.remove();
        return;
      }
      plain.write(key);
      await run(exec, 'security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]); // 尽力清掉旧条目
    },
    async clear() {
      await run(exec, 'security', ['delete-generic-password', '-s', SERVICE, '-a', ACCOUNT]);
      plain.remove();
    },
  };
}

function windowsStore(exec: Exec, plain: FileKey, dpapi: FileKey): KeyStore {
  const powershell = (script: string, input: string) => run(exec, 'powershell', ['-NoProfile', '-Command', script], input);
  return {
    async get() {
      const fallback = plain.read(); // 与 macOS 同理：文件只在 DPAPI 加密失败时才存在，文件优先
      if (fallback) return fallback;
      const blob = dpapi.read();
      if (!blob) return null;
      const r = await powershell(PS_DECRYPT, blob);
      return r.code === 0 ? r.stdout.trim() || null : null;
    },
    async set(raw) {
      const key = needKey(raw);
      const r = await powershell(PS_ENCRYPT, key);
      if (r.code === 0 && r.stdout.trim()) {
        dpapi.write(r.stdout.trim());
        plain.remove();
      } else {
        plain.write(key);
        dpapi.remove(); // 旧密文必须删，否则会和新 key 并存
      }
    },
    async clear() {
      dpapi.remove();
      plain.remove();
    },
  };
}

function fileStore(plain: FileKey): KeyStore {
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

export function createKeyStore(dataDir: string, platform: NodeJS.Platform = process.platform, exec: Exec = defaultExec): KeyStore {
  const plain = new FileKey(dataDir, 'key');
  if (platform === 'darwin') return darwinStore(exec, plain);
  if (platform === 'win32') return windowsStore(exec, plain, new FileKey(dataDir, 'key.dpapi'));
  return fileStore(plain);
}

/** 200 有效；401/403 无效；其余（429、404、5xx、网络错误）无法判断，抛错让调用方提示「稍后重试」而不是误判 key 无效 */
export async function validateKey(key: string, fetchImpl: typeof fetch = fetch): Promise<boolean> {
  const trimmed = key.trim();
  if (!trimmed) return false;
  let res: Response;
  try {
    res = await fetchImpl(KEXIANG_VALIDATE_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${trimmed.startsWith('sk-') ? trimmed : `sk-${trimmed}`}`, 'content-type': 'application/json' },
      body: '{}',
      signal: AbortSignal.timeout(VALIDATE_TIMEOUT_MS),
    });
  } catch (err) {
    throw new Error(`无法校验 key：${networkReason(err)}`);
  }
  void res.body?.cancel().catch(() => undefined); // 只看状态码，释放连接
  // 空请求体：key 有效时可想返回 400（参数校验失败），无效时 401
  if (res.ok || res.status === 400) return true;
  if (res.status === 401 || res.status === 403) return false;
  throw new Error(`无法校验 key：可想 AI 返回 HTTP ${res.status}，请稍后重试`);
}
