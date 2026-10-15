import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { renameSync } from 'node:fs';
import type { AppConfig } from '../config.js';

// 抠像用的 ffmpeg 进程工具：原始帧解码、带背压的编码器、失败根因

/** 启动 ffmpeg 解码为 rgb24 原始帧流 */
export function decoder(cfg: AppConfig, input: string, vf: string): ChildProcessWithoutNullStreams {
  const p = spawn(cfg.ffmpeg, ['-v', 'error', '-nostdin', '-i', input, '-vf', vf, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-']);
  p.stdin.on('error', () => {}); // 解码器不读 stdin，进程提前退出时的 EPIPE 无需处理
  return p;
}

/** 进程结束；非 0 退出时带 stderr 报错。返回的 promise 已挂空 catch，不会成为未处理的 rejection */
export function exited(p: ChildProcessWithoutNullStreams, name: string): Promise<void> {
  let stderr = '';
  p.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
  const done = new Promise<void>((resolve, reject) => {
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${name} 失败（退出码 ${code}）：${stderr.slice(-800)}`))));
  });
  done.catch(() => {});
  return done;
}

export const killAll = (...ps: ChildProcessWithoutNullStreams[]): void => {
  for (const p of ps) if (p.exitCode === null && p.signalCode === null) p.kill('SIGKILL');
};

export const reasonOf = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** 从 rgb24 流里按整帧切出，逐帧回调（回调可 await，以此形成背压）；chunk 只在凑够一帧时才合并一次 */
export async function forEachFrame(p: ChildProcessWithoutNullStreams, frameBytes: number, onFrame: (frame: Buffer) => Promise<void>): Promise<void> {
  let chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of p.stdout) {
    chunks.push(chunk as Buffer);
    length += (chunk as Buffer).length;
    if (length < frameBytes) continue;
    let pending = Buffer.concat(chunks, length);
    while (pending.length >= frameBytes) {
      await onFrame(pending.subarray(0, frameBytes));
      pending = pending.subarray(frameBytes);
    }
    chunks = pending.length > 0 ? [pending] : [];
    length = pending.length;
  }
}

/** tmp：编码进程写入的临时文件，成功后改名为 output */
export interface Encoder {
  proc: ChildProcessWithoutNullStreams;
  done: Promise<void>;
  write: (frame: Buffer) => Promise<void>;
  broken: () => boolean;
  tmp: string;
  output: string;
}

/** 先写临时文件，成功后再改名：取消或失败时不破坏已有的好文件 */
export const tmpOf = (output: string): string => `${output}.${randomUUID().slice(0, 8)}.tmp.mp4`;

/** 启动 x264 编码进程；write 带背压，编码进程退出/出错时立即抛错而不会挂起 */
export function startEncoder(cfg: AppConfig, args: string[], tmp: string, output: string): Encoder {
  const proc = spawn(cfg.ffmpeg, args);
  const done = exited(proc, '编码');
  let broken: Error | null = null;
  proc.stdin.on('error', (e) => { broken ??= e; });
  const write = async (frame: Buffer): Promise<void> => {
    if (broken) throw broken;
    if (proc.stdin.write(frame)) return;
    await new Promise<void>((resolve, reject) => {
      const onDrain = (): void => { cleanup(); resolve(); };
      const onDead = (): void => { cleanup(); reject(broken ?? new Error('编码进程已提前退出')); };
      const cleanup = (): void => { proc.stdin.off('drain', onDrain); proc.stdin.off('error', onDead); proc.off('close', onDead); };
      proc.stdin.once('drain', onDrain);
      proc.stdin.once('error', onDead);
      proc.once('close', onDead);
    });
  };
  return { proc, done, write, broken: () => broken !== null, tmp, output };
}

const isDead = (enc: Encoder): boolean => enc.broken() || enc.proc.exitCode !== null || enc.proc.signalCode !== null;

/** 失败后取根因：某个编码进程自己先挂掉（写管道出错或已退出）时，用它的 stderr 作为原因 */
export async function rootCause(err: unknown, encs: Encoder[]): Promise<string> {
  for (const enc of encs.filter(isDead)) {
    try {
      await enc.done;
    } catch (e) {
      return reasonOf(e);
    }
  }
  return reasonOf(err);
}


/** 原始帧输入参数（从 stdin 读） */
export const rawInput = (pixFmt: 'rgb24' | 'gray', w: number, h: number, fps: number): string[] =>
  ['-v', 'error', '-nostdin', '-y', '-f', 'rawvideo', '-pix_fmt', pixFmt, '-s', `${w}x${h}`, '-r', String(fps), '-i', '-'];

/** 全部编码器收尾并改名（全部成功才改名，避免几路输出不配套） */
export async function closeEncoders(encs: Encoder[]): Promise<void> {
  for (const enc of encs) enc.proc.stdin.end();
  await Promise.all(encs.map((enc) => enc.done));
  for (const enc of encs) renameSync(enc.tmp, enc.output);
}
