import { createInterface } from 'node:readline/promises';
import { formatEstimate, type Estimate } from './estimate.js';

export interface ConfirmOptions {
  estimate: Estimate;
  budgetYuan: number;
  /** 命令行带了 --yes */
  yes: boolean;
  isTTY: boolean;
  /** 提问函数，返回用户输入；缺省用 readline 读标准输入 */
  ask?: (question: string) => Promise<string>;
  /** 输出函数；缺省 console.log */
  print?: (text: string) => void;
}

const QUESTION = '继续吗？(y/N) ';

async function askStdin(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** 开跑前打印预估；--yes 或非交互终端直接继续，交互终端里只有回答 y / yes 才继续 */
export async function confirmRun(opts: ConfirmOptions): Promise<boolean> {
  (opts.print ?? console.log)(formatEstimate(opts.estimate, opts.budgetYuan));
  if (opts.yes || !opts.isTTY) return true;
  const answer = await (opts.ask ?? askStdin)(QUESTION);
  return /^y(es)?$/i.test(answer.trim());
}
