import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 执行外部命令；失败时把 stderr 末尾 800 字附在报错里，方便定位 ffmpeg 问题 */
export async function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, { maxBuffer: 64 * 1024 * 1024 });
    return { stdout, stderr };
  } catch (err) {
    const e = err as { stderr?: string; message: string };
    const tail = (e.stderr ?? '').slice(-800);
    throw new Error(`命令执行失败：${cmd} ${args.slice(0, 6).join(' ')}…\n${tail || e.message}`);
  }
}
