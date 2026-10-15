import { parseArgs } from 'node:util';
import { resolveCliPaths } from './cli-paths.js';
import { parseBackgroundArgs } from './background/resolve.js';
import { loadConfig } from './config.js';
import { KexiangClient } from './llm/kexiang.js';
import { KexiangTaskClient } from './llm/kexiang-task.js';
import { runPipeline } from './pipeline/run.js';

const USAGE = '用法：pnpm mingzhi edit <口播视频> [-o 输出.mp4] [--work 工作目录] [--bg 预设id|背景图片] [--bg-prompt 一句话描述背景]';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string', short: 'o' }, work: { type: 'string' }, bg: { type: 'string' }, 'bg-prompt': { type: 'string' } } });
  const [command, inputArg] = positionals;
  if (command !== 'edit' || !inputArg) throw new Error(USAGE);
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const { input, workDir, output } = resolveCliPaths(inputArg, values, baseDir);
  const cfg = loadConfig();
  const background = parseBackgroundArgs(values.bg, values['bg-prompt'], baseDir);
  const task = background?.kind === 'prompt' ? new KexiangTaskClient(cfg.kexiangKey ?? '') : undefined;
  const llm = new KexiangClient(cfg.kexiangKey ?? '');
  const started = Date.now();
  const res = await runPipeline({ input, workDir, output, cfg, llm, background, task, onProgress: (e) => console.log(`[${e.step}] ${e.message}`) });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n完成：删除 ${res.cuts.length} 处 · 成片 ${res.plan.outputDurationSec.toFixed(1)} 秒 · ${res.storyboard.shots.length} 个镜头 · 用时 ${secs} 秒\n${res.output}`);
}

main().catch((err: Error) => {
  console.error(`出错了：${err.message}`);
  process.exit(1);
});
