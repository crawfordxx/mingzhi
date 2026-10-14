import { basename, extname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from './config.js';
import { KexiangClient } from './llm/kexiang.js';
import { runPipeline } from './pipeline/run.js';

const USAGE = '用法：pnpm mingzhi edit <口播视频> [-o 输出.mp4] [--work 工作目录]';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string', short: 'o' }, work: { type: 'string' } } });
  const [command, inputArg] = positionals;
  if (command !== 'edit' || !inputArg) throw new Error(USAGE);
  const input = resolve(inputArg);
  const name = basename(input, extname(input));
  const workDir = resolve(values.work ?? join('work', name));
  const output = resolve(values.output ?? join(workDir, `${name}_精剪.mp4`));
  const cfg = loadConfig();
  const llm = new KexiangClient(cfg.kexiangKey ?? '');
  const started = Date.now();
  const res = await runPipeline({ input, workDir, output, cfg, llm, onProgress: (e) => console.log(`[${e.step}] ${e.message}`) });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n完成：删除 ${res.cuts.length} 处 · 成片 ${res.plan.outputDurationSec.toFixed(1)} 秒 · 用时 ${secs} 秒\n${res.output}`);
}

main().catch((err: Error) => {
  console.error(`出错了：${err.message}`);
  process.exit(1);
});
