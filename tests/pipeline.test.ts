import { HOLD_SEC, OUTRO_MIN_SEC, outroSecFor } from '../src/compose/ending.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { burnSubtitles } from '../src/captions/burn.js';
import { toAss } from '../src/captions/ass.js';
import { loadConfig } from '../src/config.js';
import { CostMeter } from '../src/cost/meter.js';
import { InsufficientBalanceError } from '../src/llm/errors.js';
import type { LlmClient } from '../src/llm/kexiang.js';
import { run } from '../src/media/exec.js';
import { probe } from '../src/media/probe.js';
import type { ProjectFile, ProjectPatch } from '../src/pipeline/project.js';
import type { BrollDeps } from '../src/broll/fulfill.js';
import { brollSummary, makeTaskClient, parseBrollArgs, parseBudgetArg, runBroll } from '../src/pipeline/broll-step.js';
import { visualKey } from '../src/broll/fulfill.js';
import { runPipeline, type ProgressEvent } from '../src/pipeline/run.js';
import type { QaDeps } from '../src/pipeline/qa-step.js';
import type { CardQaEntry } from '../src/qa/visual.js';
import type { HardCheck } from '../src/qa/hard.js';
import type { FilmReport } from '../src/qa/film.js';
import type { Storyboard } from '../src/storyboard/schema.js';
import { hasModels, hasRvm } from './helpers/models.js';

describe('burnSubtitles', () => {
  it('工作目录名含 \' , [ ] = ; 等特殊字符时也能烧录', async () => {
    const cfg = loadConfig({});
    const dir = join(mkdtempSync(join(tmpdir(), 'mz-')), "it's 视频,[1] a=b;c");
    mkdirSync(dir);
    const input = join(dir, 'in.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=540x960:r=30:d=1', '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=mono',
      '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', input]);
    const assPath = join(dir, 'captions.ass');
    writeFileSync(assPath, toAss([{ start: 0, end: 1, text: '测试' }], { width: 540, height: 960 }));
    const output = join(dir, 'out.mp4');
    await burnSubtitles(input, assPath, output, cfg);
    const info = await probe(output, cfg);
    expect([info.width, info.height, info.hasAudio]).toEqual([540, 960, true]);
  });
});

const FAKE_STORYBOARD = { shots: [{ start: 0, end: 2, layout: 'split', card: { template: 'title', props: { title: '测试' } } }], bgm: 'tech', coverTitle: { title: '高性价比', subtitle: '测试封面' } };

/** 假卡片自检：不跑 Remotion 打包，原样返回分镜与一份报告；记录收到的参数。整片自检给达标的假度量 */
const fakeQa = (report: CardQaEntry[] = []): { deps: QaDeps; seen: { meter?: unknown; storyboard?: unknown }[] } => {
  const seen: { meter?: unknown; storyboard?: unknown }[] = [];
  // 整片自检默认给达标的假度量（流程顺序确定，不触发局部重做）；要真实度量的用例自己去掉 film
  const film: QaDeps['film'] = async () => ({ ok: true, durationSec: 0, metrics: [], templates: [], skipped: [] });
  return { seen, deps: { qaCards: async (o) => { seen.push({ meter: o.meter, storyboard: o.storyboard }); return { storyboard: o.storyboard, report }; }, film } };
};

describe.skipIf(!hasModels())('runPipeline（需要本地模型）', () => {
  afterEach(() => vi.restoreAllMocks());

  it('样片：删掉停顿与「嗯」，输出成片、ASS 和 project.json', async () => {
    // 假模型返回的字幕结果非法，会走兜底分行；告警应通过 onProgress 告知，而不是打控制台
    const warn = vi.spyOn(console, 'warn');
    const cfg = loadConfig({});
    const work = mkdtempSync(join(tmpdir(), 'mz-'));
    // 假模型：剪掉文字为「嗯」的 token；字幕返回非法结果以走兜底分行
    const llm: LlmClient = {
      chatJson: async (o) => {
        // 分镜提示词里也含「字幕」，必须先判断
        if (o.system.includes('分镜')) return FAKE_STORYBOARD;
        if (o.system.includes('剪辑师')) {
          const idx = [...o.user.matchAll(/\[(\d+)\]嗯/g)].map((m) => Number(m[1]));
          // 末尾混入一条越界的坏项，应被丢弃并在 cuts 步骤消息里说明
          return { cuts: [...idx.map((i) => ({ from: i, to: i, type: 'filler', reason: '语气词' })), { from: -1, to: 0, type: 'filler' }] };
        }
        return { lines: [] };
      },
    };
    const events: ProgressEvent[] = [];
    // 每一步完成后 project.json 立即落盘：在 plan 步骤回调时读出来，应已有剪切与方案、还没有字幕
    const snapshots: Partial<Record<string, ProjectFile>> = {};
    const onProgress = (e: ProgressEvent): void => {
      events.push(e);
      if (e.step === 'plan') snapshots.plan = JSON.parse(readFileSync(join(work, 'project.json'), 'utf8')) as ProjectFile;
    };
    const input = join(import.meta.dirname, 'fixtures', 'talk.mp4');
    // 整片自检用真实度量（成片抽帧、分镜指标）
    const res = await runPipeline({ input, workDir: work, output: join(work, 'out.mp4'), cfg, llm, qaDeps: { ...fakeQa().deps, film: undefined }, onProgress });
    const src = await probe(input, cfg);
    const out = await probe(res.output, cfg);
    // 成片 = 剪后口播 + 最后一句后的留白 + 品牌片尾（样片很短，片尾取下限 OUTRO_MIN_SEC）；扣掉片尾后仍比原片短（留白不足 1 秒）
    expect(out.durationSec - OUTRO_MIN_SEC).toBeLessThan(src.durationSec - 1.0);
    // 渲染进度事件（compose）会连续出现多次，按相邻去重后比较
    // 整片自检不达标时会局部重做一轮（再渲染一次、再测一次），所以中段可能重复出现 compose、loudness、qa-film
    const order = events.map((e) => e.step).filter((s, i, all) => s !== all[i - 1]);
    expect(order.slice(0, 12)).toEqual(['probe', 'audio', 'asr', 'cuts', 'plan', 'render', 'matte', 'captions', 'storyboard', 'qa-cards', 'compose', 'loudness']); // matte：不换背景时的人物取景
    expect(order.slice(-4)).toEqual(['qa-film', 'qa-final', 'cover', 'done']);
    // 兜底分行按字数换行，「高性价比」可能被拆到相邻两行，所以拼接所有字幕行再断言
    const assText = readFileSync(join(work, 'captions.ass'), 'utf8').split('\n')
      .filter((l) => l.startsWith('Dialogue:')).map((l) => l.split(',').slice(9).join(',')).join('');
    expect(assText).toContain('高性价比');
    expect(res.captions.length).toBeGreaterThan(0);
    expect(snapshots.plan?.plan?.keep.length).toBeGreaterThan(0);
    expect(snapshots.plan?.cuts?.length).toBeGreaterThan(0);
    expect(snapshots.plan?.captions).toBeUndefined();
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.version).toBe(1);
    expect(project.transcript?.tokens.length).toBeGreaterThan(20);
    expect(project.captionsSource).toBe('fallback');
    expect(project.captionLines?.length).toBeGreaterThan(0);
    expect(project.captionLines?.[0]).toMatchObject({ from: expect.any(Number), to: expect.any(Number), text: expect.any(String) });
    expect(project.artifacts).toEqual({ wav: join(work, 'audio16k.wav'), cut: join(work, 'cut.mp4'), ass: join(work, 'captions.ass'), output: join(work, 'out.mp4'), final: join(work, 'out.mp4') });
    // 只有两个字的标题卡第 0 帧上半屏几乎全是平坦块：整片自检判首帧空，局部重做把它改成钩子（标题沿用卡片标题）
    expect(project.film?.before.metrics.find((m) => m.id === 'firstFrame')?.ok).toBe(false);
    expect(project.film?.actions.map((a) => a.kind)).toContain('hook');
    expect(project.storyboard?.shots[0].card).toMatchObject({ template: 'hook', props: { headline: '测试' } });
    // 配乐、响度与封面：不依赖本机是否下载了素材，只断言流程字段
    expect(project.storyboard).toMatchObject({ bgm: 'tech', coverTitle: { title: '高性价比' } });
    expect(project.audio).toMatchObject({ mood: 'tech' });
    expect(Math.abs((project.loudness?.after ?? 0) + 14)).toBeLessThan(1.5);
    expect(existsSync(join(work, 'final.raw.mp4'))).toBe(false);
    expect(events.find((e) => e.step === 'cover')?.message).toContain('封面生成失败');
    // 成片硬检查用真实实现（只跑 ffmpeg）：7 项，结果落盘，未通过也不影响出片
    expect(project.qa?.hard.map((c) => c.id)).toEqual(['resolution', 'fps', 'loudness', 'truePeak', 'outroLoudness', 'blackFrames', 'safeArea', 'contrast']);
    expect(project.qa?.cards).toEqual([]);
    // 整片自检：真实成片抽帧得到静止、空白率、首帧三项，加上分镜类指标，写进 project.json
    expect(project.film?.before.metrics.map((m) => m.id)).toEqual(['static', 'blank', 'firstFrame', 'diversity', 'coverage', 'reuse', 'sfx', 'readability']);
    expect(project.film?.before.skipped).toEqual([]);
    expect(events.find((e) => e.step === 'qa-film')?.message).toMatch(/^整片自检 \d\/8 达标/);
    expect(events.find((e) => e.step === 'qa-final')?.message).toMatch(/^成片硬检查/);
    expect(res.qa).toEqual(project.qa);
    expect(project.storyboardDropped).toBe(0);
    expect(project.storyboardDemoted).toBe(0);
    expect(project.storyboardCapped).toBe(0);
    const final = await probe(res.output, cfg);
    expect([final.width, final.height, final.fps, final.hasAudio]).toEqual([1080, 1920, 30, true]);
    // 成片 = 人像视频（剪切结果）+ 最后一句后的留白（不足 HOLD_SEC，最多补到 0.6 秒）+ 品牌片尾；
    // 留白补出的部分不超过 HOLD_SEC，所以扣掉片尾后不超过人像时长 + HOLD_SEC
    const cutSec = (await probe(join(work, 'cut.mp4'), cfg)).durationSec;
    // 片尾 = clamp(内容长 × 8%, 1, 2.5)：内容长约等于成片时长 / 1.08
    const outroSec = outroSecFor(final.durationSec / 1.08);
    expect(final.durationSec - outroSec).toBeLessThanOrEqual(cutSec + HOLD_SEC + 0.15);
    expect(final.durationSec - outroSec).toBeGreaterThanOrEqual(cutSec - 0.15);
    expect(existsSync(join(work, 'cut.mp4'))).toBe(true);
    expect(events.find((e) => e.step === 'captions')?.message).toContain('改用自动分行');
    expect(events.find((e) => e.step === 'cuts')?.message).toContain('丢弃 1 条');
    expect(warn).not.toHaveBeenCalled();
  }, 120_000);
});

describe.skipIf(!hasModels())('runPipeline 配乐、响度与封面（需要本地模型）', () => {
  it('素材未下载时降级出片并提示 fetch-assets；先渲到 final.raw.mp4 再统一响度；封面用分镜标题与人像视频', async () => {
    // 数据目录指向空目录：配乐与字体都未下载，与本机是否下载素材无关（模型目录沿用本机）
    const cfg = { ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), 'mz-empty-')) };
    const workDir = mkdtempSync(join(tmpdir(), 'mz-fin-'));
    const output = join(workDir, 'out.mp4');
    const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? FAKE_STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
    const covers: { title: string; subtitle?: string; personVideo: string; meter?: unknown }[] = [];
    const coverDeps = { makeCovers: async (o: { title: string; subtitle?: string; personVideo: string; meter?: unknown }) => {
      covers.push(o);
      return { cover34: join(workDir, 'cover-3x4.png'), cover43: join(workDir, 'cover-4x3.png'), attempts: 2, costYuan: 1.2, unverified: [], person: true, reused: [] };
    } };
    const events: ProgressEvent[] = [];
    let rawSeen = false;
    const res = await runPipeline({ input: CLIP, workDir, output, cfg, llm, coverDeps: coverDeps as never, qaDeps: fakeQa().deps, onProgress: (e) => {
      events.push(e);
      // 响度统一之前最终成片还不存在，渲染结果在 final.raw.mp4
      if (e.step === 'compose' && e.message === '成片渲染完成') rawSeen = existsSync(join(workDir, 'final.raw.mp4')) && !existsSync(output);
    } });
    expect(rawSeen).toBe(true);
    expect(existsSync(join(workDir, 'final.raw.mp4'))).toBe(false);
    expect(events.map((e) => e.step).filter((s, i, all) => s !== all[i - 1]).slice(-6)).toEqual(['compose', 'loudness', 'qa-film', 'qa-final', 'cover', 'done']);
    const notes = events.filter((e) => e.message.includes('pnpm fetch-assets'));
    expect(notes).toHaveLength(2);
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.audio).toMatchObject({ track: null, mood: 'tech' });
    expect(project.loudness?.after).toBeDefined();
    expect(project.captionStyle).toBe('blade');
    expect(project.costs).toEqual({ total: 0, budget: null, entries: [] }); // 未传 meter：不限预算、无账目
    expect(project.cover).toEqual({ style: 'bauhaus', costYuan: 1.2, unverified: [], reused: [] });
    expect(project.artifacts).toMatchObject({ output, final: output, cover34: join(workDir, 'cover-3x4.png'), cover43: join(workDir, 'cover-4x3.png') });
    expect(covers).toEqual([expect.objectContaining({ title: '高性价比', subtitle: '测试封面', personVideo: join(workDir, 'cut.mp4') })]);
    expect(covers[0].meter).toBeInstanceOf(CostMeter); // 未传 meter 时封面也用流程内的本地 meter
    expect((await probe(output, cfg)).hasAudio).toBe(true);
  }, 240_000);

  it('封面一步余额不足（假封面抛 InsufficientBalanceError）：成片照常交付，runPipeline 不抛错，结果带封面缺失原因，project.json 记 coverError 且保留自检结果', async () => {
    const cfg = { ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), 'mz-empty-')) };
    const workDir = mkdtempSync(join(tmpdir(), 'mz-bal-cover-'));
    const output = join(workDir, 'out.mp4');
    const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? FAKE_STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
    const coverDeps = { makeCovers: async () => { throw new InsufficientBalanceError(); } };
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output, cfg, llm, coverDeps: coverDeps as never, qaDeps: fakeQa().deps, onProgress: (e) => events.push(e) });
    expect(existsSync(output)).toBe(true);
    expect(res.coverMissing).toMatch(/余额不足/);
    expect(events.find((e) => e.step === 'cover' && e.message.startsWith('封面未生成'))).toBeDefined();
    expect(events.at(-1)?.step).toBe('done');
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.coverError).toMatch(/余额不足/);
    expect(project.cover).toBeUndefined();
    expect(project.film?.before).toBeDefined();
    expect(res.film).toEqual(project.film);
    expect(project.artifacts.final).toBe(output);
  }, 240_000);
});

describe.skipIf(!hasModels() || !hasRvm())('runPipeline 换背景（需要 ASR 与 RVM 模型）', () => {
  it('剪切后抠像换背景再渲染成片；project.json 记录背景、取景框与 person 中间文件；进度含 background、matte', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-p2-'));
    const output = join(workDir, 'out.mp4');
    const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? FAKE_STORYBOARD : o.system.includes('字幕') ? { lines: ['我平时经常在 GitHub 上面'] } : { cuts: [] }) };
    const steps: string[] = [];
    const events: ProgressEvent[] = [];
    await runPipeline({ input: 'tests/fixtures/talk.mp4', workDir, output, cfg, llm, background: { kind: 'preset', id: 'study' }, qaDeps: fakeQa().deps, onProgress: (e: ProgressEvent) => { if (steps[steps.length - 1] !== e.step) steps.push(e.step); events.push(e); } });
    // 抠像期间的节流进度（不落盘）也算 matte 步骤，必须出现在 matte 完成消息之前
    const matteMessages = events.filter((e) => e.step === 'matte').map((e) => e.message);
    expect(matteMessages.length).toBeGreaterThan(1);
    expect(matteMessages[0]).toMatch(/抠像 \d+\/\d+ 帧/);
    expect(matteMessages[matteMessages.length - 1]).toContain('抠像换背景完成');
    expect(steps).toEqual(['probe', 'audio', 'asr', 'cuts', 'plan', 'render', 'background', 'matte', 'captions', 'storyboard', 'qa-cards', 'compose', 'loudness', 'qa-film', 'qa-final', 'cover', 'done']);
    const project = JSON.parse(readFileSync(join(workDir, 'project.json'), 'utf8')) as ProjectFile;
    expect(project.background?.spec).toEqual({ kind: 'preset', id: 'study' });
    expect(project.artifacts.person).toBe(join(workDir, 'person.mp4'));
    expect(existsSync(join(workDir, 'person.mp4'))).toBe(true);
    expect('subject' in project).toBe(true);
    const info = await probe(output, cfg);
    expect(info.hasAudio).toBe(true);
  });
});

describe.skipIf(!hasModels())('runPipeline 分镜降级（需要本地模型）', () => {
  it('分镜请求抛错时仍出片：整片一个全屏镜头，进度消息写明原因', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-sb-'));
    const llm: LlmClient = {
      chatJson: async (o) => {
        if (o.system.includes('分镜')) throw new Error('额度不足');
        return o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] };
      },
    };
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: 'tests/fixtures/talk.mp4', workDir, output: join(workDir, 'out.mp4'), cfg, llm, qaDeps: fakeQa().deps, onProgress: (e) => events.push(e) });
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.storyboard?.shots).toEqual([{ start: 0, end: res.plan.outputDurationSec, layout: 'full' }]);
    expect(events.find((e) => e.step === 'storyboard')?.message).toContain('分镜生成失败');
    expect(events.find((e) => e.step === 'storyboard')?.message).toContain('额度不足');
    expect(existsSync(res.output)).toBe(true);
  }, 120_000);
});

describe.skipIf(!hasModels())('runPipeline 自检步骤（需要本地模型）', () => {
  const llm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? FAKE_STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
  const cfg = { ...loadConfig({}), dataDir: mkdtempSync(join(tmpdir(), 'mz-empty-')) };
  const failing: HardCheck = { id: 'loudness', ok: false, detail: '积分响度 -20.0 LUFS（要求 -14 ± 1）' };

  it('自检改写的分镜用于成片并写进 project.json；未传 meter 时用不限预算的账；硬检查未通过只报告不报错', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-qa-'));
    const revisedCard = { template: 'title' as const, props: { title: '重写后' } };
    const report: CardQaEntry[] = [{ shotIndex: 0, scores: [], revised: 1, passed: true }];
    const rendered: unknown[] = [];
    const { deps, seen } = fakeQa(report);
    const qaDeps: QaDeps = {
      qaCards: async (o) => { await deps.qaCards!(o); return { storyboard: { ...o.storyboard, shots: o.storyboard.shots.map((s) => ({ ...s, card: revisedCard })) }, report }; },
      film: deps.film,
      hardChecks: async (video) => { rendered.push(existsSync(video)); return [failing, { id: 'fps', ok: true, detail: '30 fps' }]; },
    };
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm, cover: false, qaDeps, onProgress: (e) => events.push(e) });
    expect(res.storyboard.shots[0].card).toEqual(revisedCard);
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.storyboard?.shots[0].card).toEqual(revisedCard);
    expect(project.qa).toEqual({ cards: report, hard: [failing, { id: 'fps', ok: true, detail: '30 fps' }] });
    expect(res.qa).toEqual(project.qa);
    expect(seen[0].meter).toMatchObject({ total: 0, budget: Number.POSITIVE_INFINITY });
    expect(rendered).toEqual([true]);
    expect(events.find((e) => e.step === 'qa-cards')?.message).toBe('卡片自检 1 张：通过 1、重写 1 次、跳过 0');
    expect(events.find((e) => e.step === 'qa-final')?.message).toBe('成片硬检查 1/2 通过，未通过：loudness（积分响度 -20.0 LUFS（要求 -14 ± 1））');
    expect(events.at(-1)?.step).toBe('done');
  }, 240_000);

  it('传了 meter 就把同一个 meter 交给卡片自检；硬检查自己出错只报进度，流程照常走完', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-qa-'));
    const meter = new CostMeter({}, 7);
    const { deps, seen } = fakeQa();
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm, cover: false, meter,
      qaDeps: { ...deps, hardChecks: async () => { throw new Error('ffmpeg 崩了'); } }, onProgress: (e) => events.push(e) });
    expect(seen[0].meter).toBe(meter);
    expect(events.find((e) => e.step === 'qa-final')?.message).toBe('成片硬检查失败，已跳过（成片不受影响）：ffmpeg 崩了');
    expect(res.qa.hard).toEqual([]);
    expect(existsSync(res.output)).toBe(true);
  }, 240_000);

  it('整片自检不达标：局部重做只改目标镜头、按新分镜重渲一次、复测；最终分镜用于成片检查并写进 project.json', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-film-'));
    const bad: FilmReport = { ok: false, durationSec: 2, metrics: [{ id: 'blank', label: '上半屏空白率', value: 0.9, limit: 0.8, ok: false, detail: '最高 90%', shots: [0] }], templates: [], skipped: [] };
    const measured: Storyboard[] = [];
    const film: QaDeps['film'] = async (o) => { measured.push(o.storyboard); return measured.length === 1 ? bad : { ...bad, ok: true, metrics: [{ ...bad.metrics[0], ok: true, value: 0.4, shots: [] }] }; };
    const hardSeen: string[] = [];
    const events: ProgressEvent[] = [];
    // 三个镜头：只有第 1 镜要重做，它和紧跟的镜头（交叉淡出）重渲，后面的镜头复用缓存
    const three = { ...FAKE_STORYBOARD, shots: [FAKE_STORYBOARD.shots[0], { start: 2, end: 4, layout: 'full' }, { start: 4, end: 6, layout: 'split', card: { template: 'title', props: { title: '后面' } } }] };
    const llm3: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? three : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm: llm3, cover: false,
      qaDeps: { ...fakeQa().deps, film, hardChecks: async (video) => { hardSeen.push(video); return []; } }, onProgress: (e) => events.push(e) });
    expect(measured).toHaveLength(2);
    expect(measured[0].shots[0].layout).toBe('split');
    expect(measured[1].shots[0]).toMatchObject({ layout: 'overlay', card: { template: 'title' } });
    expect(res.storyboard.shots[0].layout).toBe('overlay');
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.storyboard?.shots[0].layout).toBe('overlay');
    expect(project.film).toMatchObject({ before: { ok: false }, actions: [{ shotIndex: 0, kind: 'overlay' }], after: { ok: true } });
    expect(events.filter((e) => e.step === 'qa-film').map((e) => e.message).join('\n')).toMatch(/局部重做：第 1 镜：标题卡改浮层[\s\S]*局部重做后：整片自检 1\/1 达标/);
    // 只重渲受影响的分段：其余分段复用缓存
    const redo = events.find((e) => e.step === 'compose' && /^局部重做：重渲 \d+ 段/.test(e.message))?.message ?? '';
    const [, rendered, reused] = /重渲 (\d+) 段 · 复用缓存 (\d+) 段/.exec(redo) ?? [];
    expect(Number(rendered)).toBeGreaterThan(0);
    expect(Number(reused)).toBeGreaterThan(0);
    expect(hardSeen).toEqual([join(workDir, 'out.mp4')]);
  }, 240_000);

  it('qa: false 跳过两个自检步骤，project.json 没有 qa', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-qa-'));
    const qaDeps: QaDeps = { qaCards: async () => { throw new Error('不应自检卡片'); }, hardChecks: async () => { throw new Error('不应检查成片'); } };
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm, cover: false, qa: false, qaDeps, onProgress: (e) => events.push(e) });
    expect(events.map((e) => e.step)).not.toContain('qa-cards');
    expect(events.map((e) => e.step)).not.toContain('qa-final');
    expect(events.map((e) => e.step)).not.toContain('qa-film');
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.qa).toBeUndefined();
    expect(res.qa).toEqual({ cards: [], hard: [] });
  }, 240_000);
});

describe('runPipeline 背景提前校验', () => {
  const llm: LlmClient = { chatJson: async () => { throw new Error('不应调用模型'); } };
  const input = join(import.meta.dirname, 'fixtures', 'talk.mp4');

  it('背景图片不存在时在任何耗时步骤之前报错，不产生 project.json', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-fast-'));
    const events: ProgressEvent[] = [];
    await expect(runPipeline({
      input, workDir, output: join(workDir, 'out.mp4'), cfg: loadConfig({}), llm,
      background: { kind: 'file', path: join(workDir, 'nope.jpg') }, onProgress: (e) => events.push(e),
    })).rejects.toThrow('背景图片不存在或不是文件');
    expect(events).toEqual([]);
    expect(existsSync(join(workDir, 'project.json'))).toBe(false);
  });

  it('一句话生成背景但没有 task 时提前报缺 key', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-fast-'));
    await expect(runPipeline({
      input, workDir, output: join(workDir, 'out.mp4'), cfg: loadConfig({}), llm, background: { kind: 'prompt', prompt: '海边' },
    })).rejects.toThrow('MINGZHI_KX_KEY');
    expect(existsSync(join(workDir, 'project.json'))).toBe(false);
  });
});

describe('runPipeline 失败时保留花费', () => {
  it('步骤抛错（输入没有音轨）时 finally 仍把已花费写进 project.json，并保留原错误', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-fail-'));
    const input = join(workDir, 'silent.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=270x480:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    const meter = new CostMeter({}, 10);
    meter.addTask('M', 0.6, '前序生图');
    const llm: LlmClient = { chatJson: async () => { throw new Error('不应调用模型'); } };
    await expect(runPipeline({ input, workDir, output: join(workDir, 'out.mp4'), cfg, llm, meter })).rejects.toThrow('没有音轨');
    const project = JSON.parse(readFileSync(join(workDir, 'project.json'), 'utf8')) as ProjectFile;
    expect(project.costs).toMatchObject({ total: 0.6, budget: 10 });
    expect(project.costs?.entries).toHaveLength(1);
  });
});

describe('runPipeline finally 不掩盖原错误', () => {
  it('收尾写 project.json 失败（路径被目录占用）时，仍抛出步骤里的原始错误', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-fail2-'));
    mkdirSync(join(workDir, 'project.json')); // 让 finally 里的写盘必然失败
    const input = join(workDir, 'silent.mp4');
    await run(cfg.ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=blue:s=270x480:r=30:d=1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', input]);
    const llm: LlmClient = { chatJson: async () => { throw new Error('不应调用模型'); } };
    await expect(runPipeline({ input, workDir, output: join(workDir, 'out.mp4'), cfg, llm })).rejects.toThrow('没有音轨');
  });
});

const BROLL_STORYBOARD = { bgm: 'upbeat', coverTitle: { title: '钱放哪里', subtitle: '应急金' }, shots: [
  { start: 0, end: 3, layout: 'split', card: { template: 'hook', props: { index: 1, total: 1, headline: '钱要放在取得到的地方', highlight: ['取得到'], visual: { source: 'video', prompt: 'a jar of coins on a wooden table, slow push in' } } } },
  { start: 3, end: 8, layout: 'split', card: { template: 'photo', props: { label: '应急金', visual: { source: 'generate', prompt: 'a savings jar on a desk, editorial photo' } } } },
  { start: 8, end: 17, layout: 'full' },
  { start: 17, end: 19.4, layout: 'full', card: { template: 'cta', props: { actions: ['关注', '点赞', '收藏'] } } },
] };

/** 假素材依赖：用 ffmpeg 产出真实的 jpg / 30fps mp4，让 Remotion 能渲染；记录调用 */
function fakeBrollDeps(ffmpeg: string): { deps: BrollDeps; calls: { image: string[]; video: string[] } } {
  const calls = { image: [] as string[], video: [] as string[] };
  const deps: BrollDeps = {
    screenshot: async () => { throw new Error('不应截图'); },
    search: async () => [],
    image: async (prompt, out) => { calls.image.push(prompt); await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=1080x960', '-frames:v', '1', out]); return { cost: 0.2 }; },
    video: async (prompt, _imageUrl, out) => { calls.video.push(prompt); await run(ffmpeg, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=s=720x720:r=30:d=4', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', out]); return { cost: 2.4 }; },
  };
  return { deps, calls };
}
const brollLlm: LlmClient = { chatJson: async (o) => (o.system.includes('分镜') ? BROLL_STORYBOARD : o.system.includes('剪辑师') ? { cuts: [] } : { lines: [] }) };
const CLIP = join(import.meta.dirname, 'fixtures', 'talk.mp4');

describe.skipIf(!hasModels())('runPipeline B-roll 步骤（需要本地模型）', () => {
  it('开启：storyboard 之后取素材并写回卡片，进度与 project.json 记录结果，成片渲染成功', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-br-'));
    const { deps, calls } = fakeBrollDeps(cfg.ffmpeg);
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm: brollLlm, brollDeps: deps, qaDeps: fakeQa().deps,
      broll: { enabled: true, maxVideos: 1, budgetYuan: 10 }, onProgress: (e) => events.push(e) });
    expect(events.map((e) => e.step).filter((s, i, all) => s !== all[i - 1]).slice(-8)).toEqual(['broll', 'qa-cards', 'compose', 'loudness', 'qa-film', 'qa-final', 'cover', 'done']);
    const brollEvents = events.filter((e) => e.step === 'broll').map((e) => e.message);
    // 节拍编排先于卡片素材；假模型不会规划节拍：节拍整体跳过，不中断出片；钩子先生图，图生视频在 B-roll 上限（短片 ¥1）下放不下
    expect(brollEvents[0]).toContain('节拍规划失败');
    expect(brollEvents[1]).toBe('素材 1/2：生图（钩子关键图）中…');
    expect(brollEvents.at(-1)).toMatch(/^素材 2 个（实拍 0 \/ 图片 0 \/ 截图 0 \/ 生成 2） · 花费 ¥0\.40 · 失败 0 个/);
    expect(calls.video).toHaveLength(0);
    expect(calls.image).toHaveLength(2);
    expect(res.storyboard).toMatchObject({ bgm: 'upbeat', coverTitle: { title: '钱放哪里', subtitle: '应急金' } });
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.broll?.assets.map((a) => a.source).sort()).toEqual(['generate', 'generate']);
    expect(project.broll?.failures).toEqual([]);
    expect(project.broll?.costYuan).toBeCloseTo(0.4);
    const cards = project.storyboard?.shots.flatMap((s) => (s.card ? [s.card] : [])) ?? [];
    const photoImage = (cards.find((c) => c.template === 'photo')?.props as { image?: string }).image ?? '';
    const hookImage = (cards.find((c) => c.template === 'hook')?.props as { image?: string }).image ?? '';
    expect(photoImage).toMatch(/^broll\/[0-9a-f]{12}\.jpg$/);
    expect(hookImage).toMatch(/^broll\/[0-9a-f]{12}\.jpg$/);
    expect(existsSync(join(workDir, photoImage))).toBe(true);
    // 授权记录：两张都是 AI 生成
    const credits = JSON.parse(readFileSync(join(workDir, 'credits.json'), 'utf8')) as { file: string; aiGenerated: boolean }[];
    expect(credits.map((c) => c.file).sort()).toEqual([hookImage, photoImage].sort());
    expect(credits.every((c) => c.aiGenerated)).toBe(true);
    expect(existsSync(res.output)).toBe(true);
  }, 240_000);

  it('B-roll 阶段余额不足：不降级、不逐项重试，runPipeline 拒绝，project.json 仍保留已花费', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-br-'));
    const meter = new CostMeter({}, 10);
    meter.addTask('M', 0.6, '前序花费');
    let attempts = 0;
    const deps: BrollDeps = { ...fakeBrollDeps(cfg.ffmpeg).deps, video: async () => { attempts += 1; throw new InsufficientBalanceError(); }, image: async () => { attempts += 1; throw new InsufficientBalanceError(); } };
    await expect(runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm: brollLlm, brollDeps: deps, qaDeps: fakeQa().deps, meter,
      broll: { enabled: true, maxVideos: 1, budgetYuan: 10 } })).rejects.toBeInstanceOf(InsufficientBalanceError);
    expect(attempts).toBe(1);
    const project = JSON.parse(readFileSync(join(workDir, 'project.json'), 'utf8')) as ProjectFile;
    expect(project.costs).toMatchObject({ total: 0.6, budget: 10 });
  }, 240_000);

  it('封面预留接线：封面开启时 B-roll 预算检查扣掉 COVER_YUAN，--no-cover 时不扣', async () => {
    const cfg = loadConfig({});
    /** 跑到卡片自检就用余额不足错误中止（只关心 B-roll 取了几张图），返回生图次数 */
    const imagesFetched = async (cover: false | undefined): Promise<number> => {
      const workDir = mkdtempSync(join(tmpdir(), 'mz-br-'));
      const { deps, calls } = fakeBrollDeps(cfg.ffmpeg);
      const stop: QaDeps = { qaCards: async () => { throw new InsufficientBalanceError('测试中止'); } };
      await expect(runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm: brollLlm, brollDeps: deps, qaDeps: stop, ...(cover === false ? { cover } : {}),
        meter: new CostMeter({}, 1.4), broll: { enabled: true, maxVideos: 0, budgetYuan: 1.4 } })).rejects.toThrow('测试中止');
      return calls.image.length;
    };
    expect(await imagesFetched(undefined)).toBe(0); // 0.2 + 封面预留 1.25 > 1.4
    expect(await imagesFetched(false)).toBe(2);
  }, 240_000);

  it('关闭：不调用素材依赖，只靠 visual 的 photo 被去掉并补成全屏，project.json 无 broll', async () => {
    const cfg = loadConfig({});
    const workDir = mkdtempSync(join(tmpdir(), 'mz-br-'));
    const { deps, calls } = fakeBrollDeps(cfg.ffmpeg);
    const events: ProgressEvent[] = [];
    const res = await runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg, llm: brollLlm, brollDeps: deps, qaDeps: fakeQa().deps,
      broll: { enabled: false, maxVideos: 1, budgetYuan: 10 }, onProgress: (e) => events.push(e) });
    expect(calls).toEqual({ image: [], video: [] });
    expect(events.find((e) => e.step === 'broll')?.message).toContain('已去掉待取素材的需求');
    expect(res.storyboard.shots.some((s) => s.card?.template === 'photo')).toBe(false);
    expect(res.storyboard).toMatchObject({ bgm: 'upbeat', coverTitle: { title: '钱放哪里', subtitle: '应急金' } });
    const project = JSON.parse(readFileSync(res.projectPath, 'utf8')) as ProjectFile;
    expect(project.broll).toBeUndefined();
    expect(existsSync(join(workDir, 'broll'))).toBe(false);
    expect(existsSync(res.output)).toBe(true);
  }, 240_000);
});

describe('B-roll 选项', () => {
  it('开启素材获取但没有 task 与注入依赖时，在耗时步骤之前报缺 key', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-fast-'));
    await expect(runPipeline({ input: CLIP, workDir, output: join(workDir, 'out.mp4'), cfg: loadConfig({}), llm: brollLlm,
      broll: { enabled: true, maxVideos: 1, budgetYuan: 10 } })).rejects.toThrow('MINGZHI_KX_KEY');
    expect(existsSync(join(workDir, 'project.json'))).toBe(false);
  });

  it('parseBrollArgs：默认开启、1 个视频、预算 10 元；支持 --no-broll、--max-videos、--budget 与图库 key；非法值报错', () => {
    expect(parseBrollArgs({})).toEqual({ enabled: true, maxVideos: 1, budgetYuan: 10 });
    expect(parseBrollArgs({ 'no-broll': true, 'max-videos': '0', budget: '3.5' }, 'pk')).toEqual({ enabled: false, maxVideos: 0, budgetYuan: 3.5, pexelsKey: 'pk' });
    expect(parseBudgetArg(undefined)).toBe(10);
    expect(parseBudgetArg('3.5')).toBe(3.5);
    expect(() => parseBudgetArg('-1')).toThrow('--budget');
    for (const bad of ['1.5', '-1', '1e1', '0x10', '', ' 2', 'abc']) expect(() => parseBrollArgs({ 'max-videos': bad })).toThrow('--max-videos');
    for (const bad of ['-1', '1e1', '0x10', '', '.5', '5.', 'abc', 'Infinity']) expect(() => parseBrollArgs({ budget: bad })).toThrow('--budget');
  });

  it('makeTaskClient：需要可想任务却没配 key 时给出可操作的提示；不需要时不构造', () => {
    const on = { enabled: true, maxVideos: 1, budgetYuan: 10 };
    const off = { ...on, enabled: false };
    expect(() => makeTaskClient(loadConfig({}), { background: false, broll: on })).toThrow(/MINGZHI_KX_KEY.*--no-broll/);
    expect(() => makeTaskClient(loadConfig({}), { background: true, broll: off })).toThrow('一句话生成背景需要可想 AI key');
    expect(makeTaskClient(loadConfig({}), { background: false, broll: off })).toBeUndefined();
    expect(makeTaskClient(loadConfig({ MINGZHI_KX_KEY: 'k' }), { background: false, broll: on })).toBeDefined();
  });

  it('取素材成功与降级两条路径都保留分镜的 bgm 与 coverTitle', async () => {
    const cfg = loadConfig({});
    const visual = { source: 'generate' as const, prompt: 'a savings jar on a desk, editorial photo' };
    const storyboard = { bgm: 'tech' as const, coverTitle: { title: '钱放哪里', subtitle: '应急金' }, shots: [
      { start: 0, end: 5, layout: 'split' as const, card: { template: 'photo' as const, props: { visual } } },
      { start: 5, end: 10, layout: 'full' as const },
    ] };
    const complete = (_step: 'broll', _message: string): ProjectFile => ({}) as ProjectFile;
    const workDir = mkdtempSync(join(tmpdir(), 'mz-keep-'));
    const fulfilled = await runBroll({ workDir, cfg, broll: { enabled: true, maxVideos: 0, budgetYuan: 10 }, brollDeps: fakeBrollDeps(cfg.ffmpeg).deps }, storyboard, 10, complete);
    expect(fulfilled.shots.some((s) => s.card?.template === 'photo')).toBe(true);
    expect(fulfilled).toMatchObject({ bgm: 'tech', coverTitle: { title: '钱放哪里', subtitle: '应急金' } });
    const degraded = await runBroll({ workDir, cfg, broll: { enabled: false, maxVideos: 0, budgetYuan: 10 } }, storyboard, 10, complete);
    expect(degraded).toMatchObject({ bgm: 'tech', coverTitle: { title: '钱放哪里', subtitle: '应急金' } });
  });

  it('素材步骤整步异常：降级为去掉待取素材的需求，进度消息含「素材获取失败」，不抛错', async () => {
    // 工作目录是一个文件，fulfillVisuals 创建 broll 目录时失败
    const notDir = join(mkdtempSync(join(tmpdir(), 'mz-deg-')), 'file');
    writeFileSync(notDir, 'x');
    const events: ProgressEvent[] = [];
    const patches: ProjectPatch[] = [];
    const complete = (step: 'broll', message: string, patch: ProjectPatch = {}): ProjectFile => { events.push({ step, message }); patches.push(patch); return {} as ProjectFile; };
    const visual = { source: 'generate' as const, prompt: 'a savings jar on a desk, editorial photo' };
    const storyboard = { shots: [
      { start: 0, end: 5, layout: 'split' as const, card: { template: 'photo' as const, props: { visual } } },
      { start: 5, end: 10, layout: 'full' as const },
    ] };
    const out = await runBroll({ workDir: notDir, cfg: loadConfig({}), broll: { enabled: true, maxVideos: 1, budgetYuan: 10 }, brollDeps: fakeBrollDeps('ffmpeg').deps }, storyboard, 10, complete);
    expect(events).toHaveLength(1);
    expect(events[0].message).toContain('素材获取失败');
    expect(out.shots.some((s) => s.card)).toBe(false);
    expect(patches[0].storyboard).toEqual(out);
    expect(patches[0].broll).toBeUndefined();
  });

  it('进度：每个素材开始前有提示，缓存命中标「（缓存）」；钩子要视频时先生图', async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'mz-prog-'));
    const visual = { source: 'video' as const, prompt: 'slow push-in on a glass of cola with ice' };
    const cachedVisual = { source: 'generate' as const, prompt: 'a savings jar on a desk, editorial photo' };
    mkdirSync(join(workDir, 'broll'));
    writeFileSync(join(workDir, 'broll', `${visualKey(cachedVisual)}.jpg`), 'x');
    const storyboard = { shots: [
      { start: 0, end: 4, layout: 'split' as const, card: { template: 'hook' as const, props: { index: 1, total: 1, headline: '标题', highlight: [], visual } } },
      { start: 4, end: 9, layout: 'split' as const, card: { template: 'photo' as const, props: { visual: cachedVisual } } },
    ] };
    const deps: BrollDeps = {
      screenshot: async () => undefined, search: async () => [], image: async (_p, out) => { writeFileSync(out, 'i'); return {}; },
      video: async () => { throw new Error('不应发起视频'); },
    };
    const events: ProgressEvent[] = [];
    await runBroll({ workDir, cfg: loadConfig({}), broll: { enabled: true, maxVideos: 1, budgetYuan: 10 }, brollDeps: deps, onProgress: (e) => events.push(e) }, storyboard, 9,
      () => ({}) as ProjectFile);
    expect(events.map((e) => e.message).slice(0, 3)).toEqual([
      '素材 1/2：生图（钩子关键图）中…',
      expect.stringMatching(/^素材 1\/2 生图 broll\/[0-9a-f]{12}\.jpg$/),
      expect.stringMatching(/^素材 2\/2 生图（缓存） broll\/[0-9a-f]{12}\.jpg$/),
    ]);
  });

  it('brollSummary：图库图片计入生图', () => {
    const asset = (source: 'screenshot' | 'generate' | 'pexels' | 'video') => ({ key: 'k', file: 'broll/k', source });
    expect(brollSummary([asset('screenshot'), asset('generate'), asset('pexels'), asset('video')], 2, 2.6)).toBe('素材 4 个（截图 1 / 生图 2 / 视频 1）· 花费 ¥2.60 · 失败 2 个');
  });
});
