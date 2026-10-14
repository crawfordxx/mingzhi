import { basename, extname, join, resolve } from 'node:path';

export interface CliPaths { input: string; workDir: string; output: string }

/** 命令行里的相对路径都基于调用目录 baseDir 解析（pnpm 运行时 cwd 是仓库根，用户所在目录在 INIT_CWD） */
export function resolveCliPaths(inputArg: string, opts: { output?: string; work?: string }, baseDir: string): CliPaths {
  const input = resolve(baseDir, inputArg);
  const name = basename(input, extname(input));
  const workDir = resolve(baseDir, opts.work ?? join('work', name));
  const output = resolve(baseDir, opts.output ?? join(workDir, `${name}_精剪.mp4`));
  if (output === input) throw new Error('输出路径不能与输入视频相同，请换一个 -o 路径');
  return { input, workDir, output };
}
