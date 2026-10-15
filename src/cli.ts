import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { resolveCliPaths } from './cli-paths.js';
import { parseBackgroundArgs } from './background/resolve.js';
import { loadConfig } from './config.js';
import { confirmRun } from './cost/confirm.js';
import { estimateCost } from './cost/estimate.js';
import { CostMeter } from './cost/meter.js';
import { loadPrices } from './cost/prices.js';
import { InsufficientBalanceError, RECHARGE_URL } from './llm/errors.js';
import { KexiangClient } from './llm/kexiang.js';
import { makeTaskClient, parseBrollArgs } from './pipeline/broll-step.js';
import { parseFinishArgs } from './pipeline/finish-step.js';
import { KexiangTaskClient } from './llm/kexiang-task.js';
import { probe } from './media/probe.js';
import { qaSummary } from './pipeline/qa-step.js';
import { runPipeline } from './pipeline/run.js';

const USAGE = '用法：pnpm mingzhi edit <口播视频> [-o 输出.mp4] [--work 工作目录] [--bg 预设id|背景图片] [--bg-prompt 一句话描述背景] [--no-broll] [--max-videos N] [--budget 元] [--bgm auto|none|曲目id] [--caption-style 样式id] [--cover-style 风格id] [--no-cover] [--no-qa] [--yes]';

async function main(): Promise<void> {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { output: { type: 'string', short: 'o' }, work: { type: 'string' }, bg: { type: 'string' }, 'bg-prompt': { type: 'string' }, 'no-broll': { type: 'boolean' }, 'max-videos': { type: 'string' }, budget: { type: 'string' }, bgm: { type: 'string' }, 'caption-style': { type: 'string' }, 'cover-style': { type: 'string' }, 'no-cover': { type: 'boolean' }, 'no-qa': { type: 'boolean' }, yes: { type: 'boolean', short: 'y' } } });
  const [command, inputArg] = positionals;
  if (command !== 'edit' || !inputArg) throw new Error(USAGE);
  const baseDir = process.env.INIT_CWD ?? process.cwd();
  const { input, workDir, output } = resolveCliPaths(inputArg, values, baseDir);
  const cfg = loadConfig();
  const background = parseBackgroundArgs(values.bg, values['bg-prompt'], baseDir);
  const broll = parseBrollArgs(values, cfg.pexelsKey);
  const finish = parseFinishArgs(values);
  // 封面需要可想任务客户端；没配 key 时不在这里报错，由封面步骤降级跳过
  const meter = new CostMeter(await loadPrices(join(cfg.dataDir, 'prices.json'), fetch, Date.now, cfg.kexiangKey), broll.budgetYuan);
  const task = makeTaskClient(cfg, { background: background?.kind === 'prompt', broll, meter }) ?? (finish.cover && cfg.kexiangKey ? new KexiangTaskClient(cfg.kexiangKey, undefined, undefined, undefined, meter) : undefined);
  const llm = new KexiangClient(cfg.kexiangKey ?? '', undefined, undefined, meter);
  const estimate = estimateCost({ durationSec: (await probe(input, cfg)).durationSec, bgPrompt: background?.kind === 'prompt', broll: broll.enabled, maxVideos: broll.maxVideos, qa: !values['no-qa'], cover: finish.cover !== false });
  if (!(await confirmRun({ estimate, budgetYuan: broll.budgetYuan, yes: values.yes === true, isTTY: process.stdin.isTTY === true && process.stdout.isTTY === true }))) {
    console.log('已取消，未花费任何费用');
    return;
  }
  const started = Date.now();
  const res = await runPipeline({ input, workDir, output, cfg, llm, background, task, broll, meter, qa: !values['no-qa'], ...finish, onProgress: (e) => console.log(`[${e.step}] ${e.message}`) }).catch((err: unknown) => {
    console.error(`已花费 ¥${meter.total.toFixed(2)}`);
    if (err instanceof InsufficientBalanceError) console.error(`请先到 ${RECHARGE_URL} 充值，再重新运行（已完成的付费素材在工作目录里有缓存，重跑不会重复付费）`);
    throw err;
  });
  const secs = Math.round((Date.now() - started) / 1000);
  console.log(`\n完成：删除 ${res.cuts.length} 处 · 成片 ${res.plan.outputDurationSec.toFixed(1)} 秒 · ${res.storyboard.shots.length} 个镜头 · 用时 ${secs} 秒 · 花费 ¥${meter.total.toFixed(2)}（上限 ¥${broll.budgetYuan.toFixed(2)}）${values['no-qa'] ? '' : `\n${qaSummary(res.qa)}`}\n${res.output}`);
}

main().catch((err: Error) => {
  console.error(`出错了：${err.message}`);
  process.exit(1);
});
