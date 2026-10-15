import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { CancelledError } from '../cancel.js';

const execFileAsync = promisify(execFile);

/** 执行外部命令；失败时把 stderr 末尾 800 字附在报错里，方便定位 ffmpeg 问题。传入 signal 时取消会结束子进程并抛 CancelledError */
export async function run(cmd: string, args: string[], opts: { cwd?: string; signal?: AbortSignal } = {}): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024, cwd: opts.cwd, signal: opts.signal });
    return { stdout, stderr };
  } catch (err) {
    if (opts.signal?.aborted) throw new CancelledError();
    const e = err as { stderr?: string; message: string };
    const tail = (e.stderr ?? '').slice(-800);
    throw new Error(`命令执行失败：${cmd} ${args.slice(0, 6).join(' ')}…\n${tail || e.message}`);
  }
}

/** 执行外部命令并取二进制 stdout（如 ffmpeg 输出 rawvideo）；失败时附 stderr 末尾 800 字 */
export async function runBuffer(cmd: string, args: string[]): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync(cmd, args, { encoding: 'buffer', maxBuffer: 256 * 1024 * 1024 });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: Buffer; message: string };
    const tail = (e.stderr?.toString('utf8') ?? '').slice(-800);
    throw new Error(`命令执行失败：${cmd} ${args.slice(0, 6).join(' ')}…\n${tail || e.message}`);
  }
}
