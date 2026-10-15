/**
 * 假模型模式（仅测试用）：环境变量 MINGZHI_FAKE_LLM=1 时，服务给运行器与对话修改注入假模型、假生图、假卡片自检与假封面，
 * 返回固定的剪口误、分镜与修改方案，不联网、不花钱；识别、剪切、抠像、渲染、响度与成片检查仍走真实本地实现。
 * 为了让工作台的「花费」显示可测，每次假调用按名义单价记一笔（标注「假模式」，并没有真的扣费）。
 */
import { copyFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { presetPath } from '../background/presets.js';
import type { BrollDeps } from '../broll/fulfill.js';
import type { AppConfig } from '../config.js';
import type { CostMeter } from '../cost/meter.js';
import type { LlmClient } from '../llm/kexiang.js';
import type { TaskClient } from '../llm/kexiang-task.js';
import { run } from '../media/exec.js';
import type { CoverDeps } from '../pipeline/finish-step.js';
import type { QaDeps } from '../pipeline/qa-step.js';
import { hardChecks } from '../qa/hard.js';
import type { CardQaEntry, CardScore } from '../qa/visual.js';
import { fileKeyStore } from '../workspace/keychain.js';
import type { AppDeps, AppOptions } from './context.js';

export const FAKE_LLM_ENV = 'MINGZHI_FAKE_LLM';
export const isFakeMode = (env: NodeJS.ProcessEnv = process.env): boolean => env[FAKE_LLM_ENV] === '1';

/** 每次假调用的名义花费与延迟（延迟让剪辑直播有节奏，不是真的在等网络） */
const FAKE_CALL_YUAN = 0.02;
const FAKE_DELAY_MS = 350;
const FILLERS = new Set(['嗯', '呃', '额', '啊', '哦']);
const SHOT_SEC = 3.6;
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 剪口误：语气词、口头禅（「然后呢」「不对」）与紧挨着重复的 2–3 字（「一个一个」的前一个）；token 从 formatTokensForLlm 的「[下标]字」里认 */
function fakeCuts(user: string): unknown {
  const toks = [...user.matchAll(/\[(\d+)\]([^[\n]*)/g)].map(([, idx, text]) => ({ i: Number(idx), t: text.trim() }));
  const text = (a: number, n: number) => toks.slice(a, a + n).map((x) => x.t).join('');
  const cuts: { from: number; to: number; type: string; reason: string }[] = [];
  const add = (a: number, n: number, type: string, reason: string) => {
    if (cuts.some((c) => c.to >= toks[a].i)) return;
    cuts.push({ from: toks[a].i, to: toks[a + n - 1].i, type, reason });
  };
  toks.forEach((tok, a) => {
    if (FILLERS.has(tok.t)) add(a, 1, 'filler', '语气词');
    else if (text(a, 3) === '然后呢') add(a, 3, 'filler', '口头禅');
    else if (text(a, 2) === '不对') add(a, 2, 'slip', '改口');
    else for (const n of [3, 2]) if (a + 2 * n <= toks.length && text(a, n) === text(a + n, n) && /^\p{Script=Han}+$/u.test(text(a, n))) { add(a, n, 'repeat', '重复'); break; }
  });
  return { cuts };
}

const CARDS = [
  { template: 'title', props: { title: '逛 GitHub 的日常', crumb: '开场' } },
  { template: 'bigNumber', props: { value: '650', unit: '条', label: '高性价比人生指南' } },
  { template: 'title', props: { title: '少花冤枉钱', subtitle: '每一条都有证据来源' } },
  { template: 'strikeList', props: { title: '先别买', items: ['含糖饮料', '彩票', '保健品'] } },
];

/** 分镜：按总时长每 3.6 秒一个镜头，分屏卡片与全屏人像交替 */
function fakeStoryboard(user: string): unknown {
  const total = Number(/总时长：([\d.]+)/.exec(user)?.[1] ?? 15);
  const count = Math.max(2, Math.round(total / SHOT_SEC));
  const step = total / count;
  const shots = Array.from({ length: count }, (_, i) => ({
    start: Number((i * step).toFixed(2)), end: Number(((i + 1) * step).toFixed(2)),
    ...(i % 2 === 0 ? { layout: 'split', card: CARDS[(i / 2) % CARDS.length] } : { layout: 'full' }),
  }));
  return { bgm: 'tech', coverTitle: { title: '高性价比人生', subtitle: '650 条省钱常识' }, shots };
}

/** 修改：改被 @ 引用的那张分屏卡（引用的是全屏镜头就取最近的分屏卡，没有引用就改最后一张标题卡），给两种版式让用户挑 */
function fakeEditPlan(user: string): unknown {
  const split = [...user.matchAll(/^#(\d+) \[[^\]]+\] split (\w+)(?:「([^」]*)」)?/gm)].map(([, i, tpl, t]) => ({ index: Number(i), tpl, title: t ?? '' }));
  const ref = Number(/→ 镜头 #(\d+)/.exec(user)?.[1] ?? -1);
  const nearest = ref < 0 ? undefined : [...split].sort((a, b) => Math.abs(a.index - ref) - Math.abs(b.index - ref))[0];
  const target = nearest ?? split.filter((s) => s.tpl === 'title').at(-1) ?? split.at(-1);
  if (!target) return { reply: '这一版没有可以改的卡片，换个说法试试？', ops: [] };
  const card = (props: Record<string, string>) => [{ type: 'replaceCard', shotIndex: target.index, card: { template: 'title', props } }];
  return {
    reply: `明白，只改第 ${target.index + 1} 段这张卡，其余镜头原样复用。想要哪种版式？`,
    ops: [],
    options: [
      { label: '大字标题', ops: card({ title: '省下的都是赚到的' }) },
      { label: '加一行副标题', ops: card({ title: target.title || '少花冤枉钱', subtitle: '650 条，每条都有出处' }) },
    ],
  };
}

export function fakeLlm(meter?: CostMeter): LlmClient {
  return {
    chatJson: async (o) => {
      await wait(FAKE_DELAY_MS);
      meter?.addTask('fake-llm', FAKE_CALL_YUAN, `${o.label ?? '模型'}（假模式）`);
      if (o.label === '剪口误') return fakeCuts(o.user);
      if (o.label === '分镜') return fakeStoryboard(o.user);
      if (o.label === '修改') return fakeEditPlan(o.user);
      return { lines: [] }; // 字幕校对等：返回空，走本地兜底分行
    },
  };
}

/** 假生图：返回预设背景图的 data URL（下载走 fetch，支持 data:，不联网） */
const fakeTask = (meter: CostMeter): TaskClient => ({
  run: async (_input, opts) => {
    await wait(FAKE_DELAY_MS);
    meter.addTask('fake-task', FAKE_CALL_YUAN, `${opts.label ?? '生图'}（假模式）`);
    const url = `data:image/jpeg;base64,${readFileSync(presetPath('study')).toString('base64')}`;
    return { taskId: 'fake', url, cost: FAKE_CALL_YUAN };
  },
});

const fakeBroll = (meter: CostMeter): BrollDeps => ({
  screenshot: async () => { throw new Error('假模式不截图'); },
  search: async () => [],
  image: async (_prompt, out) => {
    copyFileSync(presetPath('cafe'), out);
    meter.addTask('fake-img', FAKE_CALL_YUAN, '生图（假模式）');
    return { cost: FAKE_CALL_YUAN };
  },
  video: async () => { throw new Error('假模式不生成视频'); },
});

/** 卡片自检：给每张分屏卡一组固定分数，逐张跳出（带 onProgress 明细，与真实自检的事件形状一致） */
const fakeQa = (): QaDeps => ({
  hardChecks,
  qaCards: async (o) => {
    const targets = o.storyboard.shots.flatMap((s, i) => (s.layout === 'split' && s.card && (!o.only || o.only.includes(i)) ? [i] : []));
    const report: CardQaEntry[] = [];
    for (const [k, shotIndex] of targets.entries()) {
      await wait(FAKE_DELAY_MS);
      const score: CardScore = { layout: k % 2 ? 8.8 : 9.1, hierarchy: 8.8, motion: [8.6, 8.7, 8.8][k % 3], brand: 9.3, notes: '假模式固定分数' };
      o.meter.addTask('fake-qa', FAKE_CALL_YUAN, '卡片自检（假模式）');
      o.onProgress?.(`第 ${shotIndex + 1} 镜卡片自检：版式 ${score.layout} 层级 ${score.hierarchy} 动效 ${score.motion} 品牌 ${score.brand}`, { shotIndex, attempt: 1, score, passed: true });
      report.push({ shotIndex, scores: [score], revised: 0, passed: true });
    }
    return { storyboard: o.storyboard, report };
  },
});

/** 封面：从人像视频取一帧，裁成 3:4 与 4:3 两张 PNG（本地 ffmpeg，不生图） */
const fakeCovers = (cfg: AppConfig): CoverDeps => ({
  makeCovers: async (o) => {
    const cover34 = join(o.workDir, 'cover-3x4.png');
    const cover43 = join(o.workDir, 'cover-4x3.png');
    const grab = (out: string, vf: string) => run(cfg.ffmpeg, ['-v', 'error', '-y', '-ss', '0.5', '-i', o.personVideo, '-frames:v', '1', '-vf', vf, out]);
    await grab(cover34, 'crop=iw:iw*4/3,scale=720:-2');
    await grab(cover43, 'crop=iw:iw*3/4,scale=960:-2');
    o.meter?.addTask('fake-cover', FAKE_CALL_YUAN, '封面（假模式）');
    return { cover34, cover43, attempts: 0, costYuan: FAKE_CALL_YUAN, unverified: [], person: true, reused: [] };
  },
});

/** 假模式下注入服务的依赖：key 校验恒通过、价格表为空、对话修改与运行器都用假模型 */
export function fakeDeps(cfg: AppConfig): Partial<AppDeps> {
  return {
    validateKey: async () => true,
    loadPrices: async () => ({}),
    planClient: (_key, meter) => fakeLlm(meter),
    ctxOverrides: {
      clients: (meter) => ({ llm: fakeLlm(meter), task: fakeTask(meter) }),
      brollDeps: fakeBroll, qaDeps: fakeQa(), coverDeps: fakeCovers(cfg),
    },
  };
}

/**
 * 假模式的服务选项：必须用独立的数据目录（MINGZHI_DATA_DIR，且不是默认的 ~/.mingzhi），
 * key 只存数据目录下的文件、不碰系统钥匙串。这样「key 校验恒通过」只在这个隔离目录里生效，
 * 假版本也不会混进真实项目。
 */
export function fakeAppOptions(cfg: AppConfig, env: NodeJS.ProcessEnv = process.env): Pick<AppOptions, 'keyStore' | 'deps'> {
  const dir = env.MINGZHI_DATA_DIR;
  if (!dir || resolve(dir) === resolve(homedir(), '.mingzhi')) {
    throw new Error(`${FAKE_LLM_ENV}=1 时必须用 MINGZHI_DATA_DIR 指定一个独立的数据目录（不能是 ~/.mingzhi）`);
  }
  return { keyStore: fileKeyStore(cfg.dataDir), deps: fakeDeps(cfg) };
}
